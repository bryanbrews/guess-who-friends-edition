// fetch_official.mjs — refresh the official-data side of the dataset.
//
// Germany has no public per-sale price register, but two official sources are
// publicly usable:
//   1. Destatis Häuserpreisindex (table 61262-0001) — the national price
//      index, fetched here via the GENESIS REST API to keep the year-over-year
//      trend current. Needs a free account: https://www-genesis.destatis.de
//      (pass the API token via GENESIS_TOKEN).
//   2. The Gutachterausschüsse (local appraisal committees) publish yearly
//      Immobilienmarktberichte with average transaction prices from the
//      notarized-sale register. Most publish PDFs, not APIs, so city averages
//      are maintained by hand in sources/official_overrides.json; this script
//      merges them and prints where to look each year (see PORTALS below).
//
// Output: sources/official.json (picked up by build_dataset.mjs, overriding
// official_seed.json).
//
// Usage: [GENESIS_TOKEN=…] node scripts/immopreis/fetch_official.mjs

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const HERE = import.meta.dirname;
const OUT = path.join(HERE, "sources", "official.json");
const OVERRIDES = path.join(HERE, "sources", "official_overrides.json");

// Where to find each state's official market data (BORIS portals and
// Gutachterausschuss report hubs). Land prices (Bodenrichtwerte) are open
// data in most states; full market reports are linked from the same portals.
const PORTALS = {
  national: "https://www.bodenrichtwerte-boris.de (BORIS-D, all states)",
  BW: "https://www.gutachterausschuesse-bw.de",
  BY: "https://www.bodenrichtwerte.bayern.de",
  BE: "https://www.berlin.de/gutachterausschuss (full Kaufpreissammlung stats)",
  BB: "https://www.boris-brandenburg.de",
  HH: "https://www.hamburg.de/gutachterausschuss",
  HE: "https://boris.hessen.de",
  MV: "https://www.geodaten-mv.de/grundstuecksmarktinformationen",
  NI: "https://immobilienmarkt.niedersachsen.de (open, includes price maps)",
  NW: "https://www.boris.nrw.de (open data incl. transaction aggregates)",
  RP: "https://www.gutachterausschuesse.rlp.de",
  SL: "https://www.saarland.de/gutachterausschuss",
  SN: "https://www.boris.sachsen.de",
  ST: "https://www.boris.sachsen-anhalt.de",
  SH: "https://danord.gdi-sh.de (Grundstücksmarktberichte SH)",
  TH: "https://www.bodenmanagement.thueringen.de",
};

// ------------------------------------------------- Destatis GENESIS (yoy)

async function fetchYoy(token) {
  const url =
    "https://www-genesis.destatis.de/genesisWS/rest/2020/data/tablefile" +
    `?username=${encodeURIComponent(token)}&password=&name=61262-0001` +
    "&area=all&format=ffcsv&language=de";
  const res = await fetch(url, { headers: { "User-Agent": "immopreis-aggregator/1.0" } });
  if (!res.ok) throw new Error(`GENESIS HTTP ${res.status}`);
  const csv = await res.text();
  // ffcsv: one row per year/quarter with the index value in the last column.
  const values = csv
    .split("\n")
    .map((line) => line.split(";"))
    .filter((cells) => /^\d{4}$/.test(cells[4] ?? ""))
    .map((cells) => ({ year: Number(cells[4]), index: Number(cells.at(-1)?.replace(",", ".")) }))
    .filter((r) => Number.isFinite(r.index))
    .sort((a, b) => a.year - b.year);
  if (values.length < 2) throw new Error("could not parse index values from GENESIS response");
  const [prev, last] = values.slice(-2);
  return { yoy: last.index / prev.index - 1, asOf: last.year };
}

// ---------------------------------------------------------------- assemble

const seed = JSON.parse(
  await readFile(path.join(HERE, "sources", "official_seed.json"), "utf8")
);
const overrides = existsSync(OVERRIDES)
  ? JSON.parse(await readFile(OVERRIDES, "utf8"))
  : { cities: {} };

let index = { ...seed.index };
const token = process.env.GENESIS_TOKEN;
if (token) {
  try {
    const { yoy, asOf } = await fetchYoy(token);
    index = { yoy: Math.round(yoy * 1000) / 1000, source: `${seed.index.source} (as of ${asOf})` };
    console.log(`Destatis Häuserpreisindex: yoy ${(yoy * 100).toFixed(1)}% (as of ${asOf})`);
  } catch (err) {
    console.warn(`GENESIS fetch failed (${err.message}) — keeping seed trend`);
  }
} else {
  console.log("No GENESIS_TOKEN set — keeping the seed year-over-year trend.");
}

const cities = { ...seed.cities, ...overrides.cities };
await writeFile(
  OUT,
  JSON.stringify({ generatedAt: new Date().toISOString(), index, cities }, null, 2) + "\n"
);
console.log(
  `wrote sources/official.json — ${Object.keys(cities).length} cities ` +
    `(${Object.keys(overrides.cities).length} from overrides)`
);
console.log("\nAnnual refresh checklist — official market reports per state:");
for (const [code, url] of Object.entries(PORTALS)) console.log(`  ${code.padEnd(8)} ${url}`);
console.log("\nNow run: node scripts/immopreis/build_dataset.mjs");
