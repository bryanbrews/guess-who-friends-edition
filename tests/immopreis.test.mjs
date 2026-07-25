import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  estimate,
  sizeFactor,
  yearFactor,
  resolveArea,
} from "../immopreis/estimator.js";

const market = JSON.parse(
  await readFile(
    path.join(import.meta.dirname, "..", "immopreis", "data", "market.json"),
    "utf8"
  )
);

const baseInput = {
  areaKey: "berlin",
  type: "apartment",
  sizeSqm: 80,
  buildYear: 1985,
  condition: "maintained",
  location: "average",
  energy: "mid",
  extras: [],
};

test("dataset has cities, states, and params", () => {
  assert.ok(Object.keys(market.cities).length >= 50);
  assert.equal(Object.keys(market.states).length, 16);
  assert.ok(market.params.askingDiscount > 0 && market.params.askingDiscount < 0.2);
});

test("estimate returns a sane range for a Berlin apartment", () => {
  const r = estimate(market, baseInput);
  assert.ok(r);
  assert.ok(r.low < r.mid && r.mid < r.high);
  // 80 m² in Berlin should land in the hundreds of thousands, not millions.
  assert.ok(r.mid > 200_000 && r.mid < 700_000, `mid was ${r.mid}`);
  assert.equal(r.confidence, "high"); // Berlin has official + listing data
  assert.ok(r.breakdown.official && r.breakdown.listingNet);
});

test("official data is blended in, not ignored", () => {
  const r = estimate(market, baseInput);
  const { official, listingNet } = r.breakdown;
  const lo = Math.min(official, listingNet);
  const hi = Math.max(official, listingNet);
  assert.ok(r.areaAvgSqm >= lo && r.areaAvgSqm <= hi);
});

test("cities without official data fall back to listing-only, medium confidence", () => {
  const r = estimate(market, { ...baseInput, areaKey: "kassel" });
  assert.equal(r.confidence, "medium");
  assert.equal(r.breakdown.official, null);
});

test("state fallback works with low confidence", () => {
  const r = estimate(market, { ...baseInput, areaKey: "state:MV" });
  assert.ok(r);
  assert.equal(r.area.kind, "state");
  assert.equal(r.confidence, "low");
});

test("unknown area and invalid size return null", () => {
  assert.equal(estimate(market, { ...baseInput, areaKey: "atlantis" }), null);
  assert.equal(estimate(market, { ...baseInput, sizeSqm: 0 }), null);
  assert.equal(estimate(market, { ...baseInput, sizeSqm: "nope" }), null);
});

test("better condition and location increase the estimate", () => {
  const worse = estimate(market, { ...baseInput, condition: "needs_renovation" });
  const better = estimate(market, { ...baseInput, condition: "modernized" });
  assert.ok(better.mid > worse.mid);

  const simple = estimate(market, { ...baseInput, location: "simple" });
  const prime = estimate(market, { ...baseInput, location: "prime" });
  assert.ok(prime.mid > simple.mid);
});

test("first occupancy applies the new-build premium without double counting", () => {
  const existing = estimate(market, baseInput);
  const newBuild = estimate(market, {
    ...baseInput,
    condition: "first_occupancy",
    buildYear: 2026,
    energy: "high",
  });
  assert.ok(newBuild.mid > existing.mid);
  assert.equal(newBuild.breakdown.factors.buildYear, 1.0);
  assert.equal(newBuild.breakdown.factors.energy, 1.0);
});

test("size factor is clamped and monotonic around the anchor", () => {
  assert.ok(sizeFactor("apartment", 30) > 1);
  assert.ok(sizeFactor("apartment", 200) < 1);
  assert.ok(sizeFactor("apartment", 5) <= 1.12);
  assert.ok(sizeFactor("apartment", 5000) >= 0.9);
  assert.equal(sizeFactor("apartment", 75), 1);
  assert.equal(sizeFactor("house", 140), 1);
});

test("year factor bands: Altbau premium, 1960s discount, new-build premium", () => {
  assert.ok(yearFactor(1900) > 1);
  assert.ok(yearFactor(1965) < 1);
  assert.ok(yearFactor(2020) > yearFactor(1990));
  assert.equal(yearFactor(NaN), 1);
});

test("NRW open data is merged: real transaction averages with sample counts", () => {
  const koeln = market.cities.koeln;
  assert.ok(koeln.official.apartment > 2000 && koeln.official.apartment < 8000);
  assert.ok(koeln.official.samples.apartment > 100);
  assert.match(koeln.officialSource, /opengeodata\.nrw/);
});

test("official-only NRW municipalities estimate with medium confidence", () => {
  const r = estimate(market, { ...baseInput, areaKey: "krefeld" });
  assert.ok(r);
  assert.equal(r.confidence, "medium");
  assert.equal(r.breakdown.listingAsk, null);
  assert.ok(r.mid > 50_000);
});

test("first occupancy uses the official new-build average when available", () => {
  const r = estimate(market, {
    ...baseInput,
    areaKey: "koeln",
    condition: "first_occupancy",
    buildYear: 2026,
  });
  assert.equal(r.breakdown.officialNewUsed, true);
  assert.equal(r.breakdown.factors.condition, 1.0);
  assert.equal(r.areaAvgSqm, market.cities.koeln.official.apartmentNew);
});

test("resolveArea distinguishes cities from states", () => {
  assert.equal(resolveArea(market, "muenchen").kind, "city");
  assert.equal(resolveArea(market, "state:BY").kind, "state");
  assert.equal(resolveArea(market, "state:XX"), null);
});
