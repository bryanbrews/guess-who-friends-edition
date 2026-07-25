// build_dataset.mjs — merge the gillow data sources into the dataset the
// frontend ships with (gillow/data/market.json).
//
// Inputs, in ascending priority (later overrides earlier, city by city):
//   sources/listings_seed.json   hand-curated asking prices (always present)
//   sources/listings.json        output of fetch_listings.mjs (optional)
//   sources/official_seed.json   hand-curated Gutachterausschuss figures
//   sources/official.json        output of fetch_official.mjs (optional)
//   sources/official_nrw.json    output of fetch_official_nrw.mjs — real
//                                open-data transaction averages for all NRW
//                                municipalities; also adds official-only
//                                cities that have no listing seed
//
// Usage: node scripts/gillow/build_dataset.mjs

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const HERE = import.meta.dirname;
const ROOT = path.resolve(HERE, "..", "..");
const OUT = path.join(ROOT, "gillow", "data", "market.json");

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function readOptional(name) {
  const file = path.join(HERE, "sources", name);
  return existsSync(file) ? readJson(file) : null;
}

const listingsSeed = await readJson(path.join(HERE, "sources", "listings_seed.json"));
const listingsLive = await readOptional("listings.json");
const officialSeed = await readJson(path.join(HERE, "sources", "official_seed.json"));
const officialLive = await readOptional("official.json");

const cities = {};
for (const [key, seed] of Object.entries(listingsSeed.cities)) {
  const live = listingsLive?.cities?.[key];
  cities[key] = {
    name: seed.name,
    state: seed.state,
    listing: {
      apartment: live?.apartment ?? seed.apartment,
      house: live?.house ?? seed.house,
    },
    listingSource: live ? live.source ?? "ingested feed" : "seed (approximate)",
  };
}
// Cities that only appear in a live listings feed still get an entry.
for (const [key, live] of Object.entries(listingsLive?.cities ?? {})) {
  if (cities[key]) continue;
  cities[key] = {
    name: live.name ?? key,
    state: live.state ?? null,
    listing: { apartment: live.apartment ?? null, house: live.house ?? null },
    listingSource: live.source ?? "ingested feed",
  };
}

for (const [key, seed] of Object.entries(officialSeed.cities)) {
  const live = officialLive?.cities?.[key];
  const merged = live ?? seed;
  if (!cities[key]) continue;
  cities[key].official = { apartment: merged.apartment ?? null, house: merged.house ?? null };
  cities[key].officialSource = merged.source ?? "Gutachterausschuss market report";
}

// NRW open data (highest priority): real sale-register aggregates. Cities not
// in any listing source still become entries — the estimator handles
// official-only areas.
const officialNrw = await readOptional("official_nrw.json");
for (const [key, nrw] of Object.entries(officialNrw?.cities ?? {})) {
  if (!cities[key]) {
    cities[key] = { name: nrw.name, state: nrw.state, listing: null, listingSource: null };
  }
  cities[key].official = {
    apartment: nrw.apartment ?? null,
    house: nrw.house ?? null,
    apartmentNew: nrw.apartmentNew ?? null,
    samples: { apartment: nrw.apartmentSamples ?? null, house: nrw.houseSamples ?? null },
    year: officialNrw.berichtsjahr,
  };
  cities[key].officialSource = nrw.source;
}

const states = {};
for (const [code, s] of Object.entries(listingsSeed.states)) {
  states[code] = {
    name: s.name,
    listing: { apartment: s.apartment, house: s.house },
    listingSource: "seed (approximate state average)",
  };
}

const market = {
  generated: new Date().toISOString().slice(0, 10),
  vintage: listingsLive?.vintage ?? listingsSeed.vintage,
  params: {
    askingDiscount: 0.06,
    newBuildFactor: 1.28,
    yoy: officialLive?.index?.yoy ?? officialSeed.index.yoy,
  },
  notes: {
    listings: listingsSeed.comment,
    official: officialSeed.comment,
    trend: officialNrw?.trend
      ? `${officialSeed.index.source}; NRW open data: ${(officialNrw.trend.yoy * 100).toFixed(1)}% (${officialNrw.trend.basis})`
      : officialSeed.index.source,
  },
  cities,
  states,
};

await mkdir(path.dirname(OUT), { recursive: true });
await writeFile(OUT, JSON.stringify(market, null, 2) + "\n");
console.log(
  `wrote ${path.relative(ROOT, OUT)} — ${Object.keys(cities).length} cities, ` +
    `${Object.keys(states).length} states, vintage ${market.vintage}`
);
