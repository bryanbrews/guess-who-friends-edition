// fetch_listings.mjs — ingest real-estate listings and aggregate them into
// per-city median asking prices (EUR/m²), written to sources/listings.json for
// build_dataset.mjs to pick up.
//
// IMPORTANT — why this is an ingestion framework and not a portal scraper:
// the big German portals (ImmoScout24, Immowelt, Kleinanzeigen) prohibit
// automated scraping in their terms of service, and German law backs that up
// (database rights under §87b UrhG). This script therefore only consumes
// sources you are allowed to use:
//   - csv       your own exports / partner data / research datasets
//   - openimmo  OpenImmo XML feeds (the standard German broker export format)
//   - json-url  open-data endpoints; fetched politely with a robots.txt check
//
// Configure feeds in sources/listings_feeds.json:
//   { "feeds": [
//       { "type": "csv", "path": "data/my-export.csv",
//         "columns": { "city": "ort", "state": "bundesland", "propertyType": "typ",
//                      "price": "kaufpreis", "size": "wohnflaeche" } },
//       { "type": "openimmo", "dir": "data/openimmo/", "city": "berlin", "state": "BE" },
//       { "type": "json-url", "url": "https://…", "map": "…see mapJsonRecords…" }
//   ] }
//
// Usage: node scripts/immopreis/fetch_listings.mjs

import { readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const HERE = import.meta.dirname;
const CONFIG = path.join(HERE, "sources", "listings_feeds.json");
const OUT = path.join(HERE, "sources", "listings.json");
const USER_AGENT = "immopreis-aggregator/1.0 (+https://pacbrewlab.com/immopreis/)";

const slug = (name) =>
  name
    .toLowerCase()
    .replaceAll("ä", "ae")
    .replaceAll("ö", "oe")
    .replaceAll("ü", "ue")
    .replaceAll("ß", "ss")
    .replace(/[^a-z]+/g, "");

// ------------------------------------------------------------ polite fetch

const robotsCache = new Map();

async function allowedByRobots(url) {
  const origin = new URL(url).origin;
  if (!robotsCache.has(origin)) {
    try {
      const res = await fetch(`${origin}/robots.txt`, { headers: { "User-Agent": USER_AGENT } });
      robotsCache.set(origin, res.ok ? await res.text() : "");
    } catch {
      robotsCache.set(origin, "");
    }
  }
  const robots = robotsCache.get(origin);
  const pathName = new URL(url).pathname;
  let applies = false;
  let allowed = true;
  for (const raw of robots.split("\n")) {
    const line = raw.replace(/#.*/, "").trim();
    const [field, ...rest] = line.split(":");
    const value = rest.join(":").trim();
    if (/^user-agent$/i.test(field)) applies = value === "*";
    else if (applies && /^disallow$/i.test(field) && value && pathName.startsWith(value))
      allowed = false;
  }
  return allowed;
}

async function politeFetch(url) {
  if (!(await allowedByRobots(url))) {
    throw new Error(`robots.txt disallows fetching ${url} — skipping this feed`);
  }
  await new Promise((r) => setTimeout(r, 1000)); // 1 req/s, be a good citizen
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res;
}

// -------------------------------------------------------------- adapters
// Every adapter yields records: { city, state, propertyType, price, size }

function parseCsv(text) {
  const [header, ...lines] = text.split(/\r?\n/).filter(Boolean);
  const cols = header.split(",").map((c) => c.trim().toLowerCase());
  return lines.map((line) => {
    const cells = line.split(",");
    return Object.fromEntries(cols.map((c, i) => [c, cells[i]?.trim()]));
  });
}

async function* csvAdapter(feed) {
  const rows = parseCsv(await readFile(path.join(HERE, feed.path), "utf8"));
  const c = feed.columns;
  for (const row of rows) {
    yield {
      city: row[c.city],
      state: row[c.state] ?? null,
      propertyType: /haus|house/i.test(row[c.propertyType] ?? "") ? "house" : "apartment",
      price: Number(row[c.price]),
      size: Number(row[c.size]),
    };
  }
}

// Minimal OpenImmo XML extraction — enough for price aggregation, no deps.
const tag = (xml, name) => xml.match(new RegExp(`<${name}[^>]*>([^<]*)</${name}>`, "i"))?.[1];

async function* openimmoAdapter(feed) {
  const dir = path.join(HERE, feed.dir);
  for (const file of await readdir(dir)) {
    if (!file.endsWith(".xml")) continue;
    const xml = await readFile(path.join(dir, file), "utf8");
    for (const obj of xml.split(/<immobilie[\s>]/i).slice(1)) {
      yield {
        city: tag(obj, "ort") ?? feed.city,
        state: feed.state ?? null,
        propertyType: /haus/i.test(tag(obj, "objektart") ?? obj) ? "house" : "apartment",
        price: Number(tag(obj, "kaufpreis")),
        size: Number(tag(obj, "wohnflaeche")),
      };
    }
  }
}

async function* jsonUrlAdapter(feed) {
  const data = await (await politeFetch(feed.url)).json();
  const records = feed.map ? data[feed.map] : data;
  for (const r of records) {
    yield {
      city: r.city ?? r.ort,
      state: r.state ?? r.bundesland ?? null,
      propertyType: r.propertyType ?? r.typ ?? "apartment",
      price: Number(r.price ?? r.kaufpreis),
      size: Number(r.size ?? r.wohnflaeche),
    };
  }
}

const ADAPTERS = { csv: csvAdapter, openimmo: openimmoAdapter, "json-url": jsonUrlAdapter };

// ------------------------------------------------------------- aggregate

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

if (!existsSync(CONFIG)) {
  console.log(
    `No ${path.relative(process.cwd(), CONFIG)} found — nothing to ingest.\n` +
      "Create it to plug in CSV exports, OpenImmo feeds, or open-data URLs\n" +
      "(see the header of this script). The site keeps using the seed data."
  );
  process.exit(0);
}

const { feeds } = JSON.parse(await readFile(CONFIG, "utf8"));
const samples = new Map(); // slug -> { name, state, apartment: [], house: [] }

for (const feed of feeds) {
  const adapter = ADAPTERS[feed.type];
  if (!adapter) throw new Error(`unknown feed type: ${feed.type}`);
  try {
    for await (const rec of adapter(feed)) {
      if (!rec.city || !Number.isFinite(rec.price) || !(rec.size > 10)) continue;
      const key = slug(rec.city);
      if (!samples.has(key))
        samples.set(key, { name: rec.city, state: rec.state, apartment: [], house: [] });
      samples.get(key)[rec.propertyType === "house" ? "house" : "apartment"].push(
        rec.price / rec.size
      );
    }
  } catch (err) {
    console.warn(`feed skipped: ${err.message}`);
  }
}

const MIN_SAMPLES = 8; // below this a median is noise, not a market level
const cities = {};
for (const [key, s] of samples) {
  const entry = { name: s.name, state: s.state, source: "ingested listings feed" };
  if (s.apartment.length >= MIN_SAMPLES) {
    entry.apartment = Math.round(median(s.apartment));
    entry.apartmentSamples = s.apartment.length;
  }
  if (s.house.length >= MIN_SAMPLES) {
    entry.house = Math.round(median(s.house));
    entry.houseSamples = s.house.length;
  }
  if (entry.apartment || entry.house) cities[key] = entry;
}

await writeFile(
  OUT,
  JSON.stringify({ generatedAt: new Date().toISOString(), cities }, null, 2) + "\n"
);
console.log(`wrote sources/listings.json — ${Object.keys(cities).length} cities with enough samples`);
console.log("Now run: node scripts/immopreis/build_dataset.mjs");
