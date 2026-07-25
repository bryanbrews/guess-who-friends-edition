// fetch_official_nrw.mjs — real official transaction data for all of NRW.
//
// North Rhine-Westphalia publishes its Grundstücksmarktdaten (aggregates of
// the notarized-sale register, compiled by the Gutachterausschüsse) as open
// data under Datenlizenz Deutschland Zero:
//   https://www.opengeodata.nrw.de/produkte/infrastruktur_bauen_wohnen/boris/GMD/
//
// Per municipality and reporting year the CSVs contain, for condominiums
// (we.csv) and single-family houses (efh.csv): number of sales, average
// living area and average EUR/m², split by new-build vs resale build-year
// cohorts. This script downloads the current zip, aggregates each
// municipality to one existing-stock EUR/m² (sale-count-weighted across the
// resale cohorts), and writes sources/official_nrw.json for
// build_dataset.mjs. With --trend it also downloads the previous year and
// derives the state-wide year-over-year price change.
//
// Usage: node scripts/gillow/fetch_official_nrw.mjs [--trend] [--min-samples N]

import { writeFile } from "node:fs/promises";
import path from "node:path";

const HERE = import.meta.dirname;
const OUT = path.join(HERE, "sources", "official_nrw.json");
const BASE = "https://www.opengeodata.nrw.de/produkte/infrastruktur_bauen_wohnen/boris/GMD";
const MIN_SAMPLES = Number(process.argv.find((a) => a.startsWith("--min-samples="))?.split("=")[1] ?? 10);
const WITH_TREND = process.argv.includes("--trend");
const SOURCE =
  "Gutachterausschüsse NRW, Grundstücksmarktdaten (open data, dl-zero-de/2.0, opengeodata.nrw.de)";

// ---------------------------------------------------------- tiny zip reader
// The zips are plain deflate archives; DecompressionStream('deflate-raw')
// covers extraction without any dependency.

async function unzip(buf) {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65536); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("not a zip file (no end-of-central-directory)");
  const count = view.getUint16(eocd + 10, true);
  let off = view.getUint32(eocd + 16, true);
  const files = {};
  for (let i = 0; i < count; i++) {
    if (view.getUint32(off, true) !== 0x02014b50) throw new Error("bad central directory");
    const method = view.getUint16(off + 10, true);
    const compSize = view.getUint32(off + 20, true);
    const nameLen = view.getUint16(off + 28, true);
    const extraLen = view.getUint16(off + 30, true);
    const commentLen = view.getUint16(off + 32, true);
    const localOff = view.getUint32(off + 42, true);
    const name = new TextDecoder("latin1").decode(buf.subarray(off + 46, off + 46 + nameLen));
    const lNameLen = view.getUint16(localOff + 26, true);
    const lExtraLen = view.getUint16(localOff + 28, true);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compSize);
    if (method === 0) files[name] = raw;
    else if (method === 8) {
      const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
      files[name] = new Uint8Array(await new Response(stream).arrayBuffer());
    } else throw new Error(`unsupported zip method ${method} for ${name}`);
    off += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

// -------------------------------------------------------------- csv + math

function parseCsv(bytes) {
  // latin1-encoded, semicolon-delimited, values quoted; suppressed values
  // are "-", "." or "*" (too few cases / not reported).
  const text = new TextDecoder("latin1").decode(bytes);
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const splitLine = (line) => {
    const out = [];
    let cur = "";
    let inQ = false;
    for (const ch of line) {
      if (ch === '"') inQ = !inQ;
      else if (ch === ";" && !inQ) { out.push(cur); cur = ""; }
      else cur += ch;
    }
    out.push(cur);
    return out;
  };
  const header = splitLine(lines[0]);
  return lines.slice(1).map((line) => {
    const cells = splitLine(line);
    return Object.fromEntries(header.map((h, i) => [h, cells[i] ?? ""]));
  });
}

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && v !== "" ? n : null;
};

// Sale-count-weighted average EUR/m² across the given column prefixes.
function weighted(row, prefixes) {
  let n = 0;
  let sum = 0;
  for (const p of prefixes) {
    const count = num(row[`${p.replace("euqm", "a")}`]);
    const price = num(row[p]);
    if (count && price) { n += count; sum += count * price; }
  }
  return n ? { avg: Math.round(sum / n), samples: n } : null;
}

const COHORTS = ["z", "20xx", "2009", "1994", "1974", "1949", "1919"];
// Condos: resales (w) and first sales of converted rentals (u), all cohorts.
const WE_EXISTING = COHORTS.flatMap((c) => [`we_euqm_w_${c}`, `we_euqm_u_${c}`]);
// Houses: every house type (detached small/large lot, semi/end-terraced,
// mid-terraced), resale cohorts only.
const EFH_EXISTING = ["efh350", "efh", "rehdhh", "rmh"].flatMap((t) =>
  COHORTS.map((c) => `${t}_euqm_${c}`)
);

const slug = (name) =>
  name
    .toLowerCase()
    .replaceAll("ä", "ae").replaceAll("ö", "oe").replaceAll("ü", "ue").replaceAll("ß", "ss")
    .replace(/[^a-z]+/g, "");

// ------------------------------------------------------------------ fetch

async function loadYear(zipName) {
  const url = `${BASE}/${zipName}`;
  console.log(`downloading ${url} …`);
  const res = await fetch(url, { headers: { "User-Agent": "gillow-aggregator/1.0" } });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  const files = await unzip(new Uint8Array(await res.arrayBuffer()));
  const pick = (want) => {
    const key = Object.keys(files).find((f) => f.toLowerCase().endsWith(want));
    if (!key) throw new Error(`${want} missing from ${zipName}`);
    return parseCsv(files[key]);
  };
  return { we: pick("we.csv"), efh: pick("efh.csv"), schluessel: pick("schluessel.csv") };
}

// Rows are municipalities except the state total (empty ags) and the Kreis /
// Städteregion aggregate rows, which are all named accordingly.
const isMunicipality = (row) =>
  /^\d{8}$/.test(row.ags ?? "") && !/kreis|städteregion/i.test(row.name ?? "");

const { we, efh } = await loadYear("GMDNRW_CSV.zip");
const berichtsjahr = we.find((r) => r.berichtsjahr)?.berichtsjahr ?? "?";

const efhByAgs = new Map(efh.map((r) => [r.ags, r]));
const cities = {};
let skippedThin = 0;
for (const row of we) {
  if (!isMunicipality(row)) continue;
  const apartment = weighted(row, WE_EXISTING);
  const apartmentNew = num(row.we_euqm_neu);
  const house = weighted(efhByAgs.get(row.ags) ?? {}, EFH_EXISTING);
  const entry = { name: row.name, state: "NW", ags: row.ags, source: SOURCE };
  if (apartment && apartment.samples >= MIN_SAMPLES) {
    entry.apartment = apartment.avg;
    entry.apartmentSamples = apartment.samples;
  }
  if (apartmentNew) entry.apartmentNew = apartmentNew;
  if (house && house.samples >= MIN_SAMPLES) {
    entry.house = house.avg;
    entry.houseSamples = house.samples;
  }
  if (entry.apartment || entry.house) cities[slug(row.name)] = entry;
  else skippedThin++;
}

// -------------------------------------------------------------- yoy trend

let trend = null;
if (WITH_TREND) {
  const prevYear = Number(berichtsjahr) - 1;
  try {
    const prev = await loadYear(`GMDNRW_${prevYear}_CSV.zip`);
    const stateAvg = (rows) => {
      let n = 0;
      let sum = 0;
      for (const row of rows) {
        if (!isMunicipality(row)) continue;
        const w = weighted(row, WE_EXISTING);
        if (w) { n += w.samples; sum += w.avg * w.samples; }
      }
      return sum / n;
    };
    const yoy = stateAvg(we) / stateAvg(prev.we) - 1;
    trend = {
      yoy: Math.round(yoy * 1000) / 1000,
      basis: `NRW condo resales, ${prevYear}→${berichtsjahr}`,
    };
    console.log(`state-wide trend: ${(yoy * 100).toFixed(1)}% (${prevYear}→${berichtsjahr})`);
  } catch (err) {
    console.warn(`trend skipped: ${err.message}`);
  }
}

await writeFile(
  OUT,
  JSON.stringify(
    { generatedAt: new Date().toISOString(), berichtsjahr, source: SOURCE, trend, cities },
    null,
    2
  ) + "\n"
);
console.log(
  `wrote sources/official_nrw.json — ${Object.keys(cities).length} municipalities ` +
    `(reporting year ${berichtsjahr}; ${skippedThin} skipped with <${MIN_SAMPLES} sales)`
);
console.log("Now run: node scripts/gillow/build_dataset.mjs");
