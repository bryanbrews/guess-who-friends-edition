// estimator.js — pure valuation logic for ImmoPreis. No DOM, no fetch.
//
// The model is a classic hedonic-style adjustment chain on top of two anchors:
//   1. official  — average transaction prices from the local Gutachterausschuss
//                  (Germany's appraisal committees, fed by the notarized-sale
//                  register). Only available for cities whose market reports
//                  are public.
//   2. listing   — median asking prices scraped/ingested from listing feeds,
//                  discounted to transaction level (asking prices in Germany
//                  typically close a few percent below ask).
// When both exist they are blended, with the transaction-anchored source
// weighted higher. All factors are multiplicative on a EUR/m² base.

export const CONDITION_FACTORS = {
  needs_renovation: 0.82,
  dated: 0.92,
  maintained: 1.0,
  modernized: 1.08,
  first_occupancy: 1.25,
};

export const LOCATION_FACTORS = {
  simple: 0.85,
  average: 1.0,
  good: 1.12,
  prime: 1.28,
};

export const ENERGY_FACTORS = {
  high: 1.04, // class A+/A/B
  mid: 1.0, //  class C–E
  low: 0.94, // class F/G/H
};

export const EXTRA_FACTORS = {
  balcony: 1.02,
  garden: 1.02,
  parking: 1.02,
};

// Build-year bands. Pre-war Altbau carries a premium in most cities; the
// 1949–1977 stock (worst energy standards) trades at a discount.
const YEAR_BANDS = [
  [1918, 1.02],
  [1948, 0.97],
  [1977, 0.93],
  [1999, 0.97],
  [2015, 1.05],
  [Infinity, 1.15],
];

export function yearFactor(buildYear) {
  if (!Number.isFinite(buildYear)) return 1.0;
  for (const [upTo, factor] of YEAR_BANDS) {
    if (buildYear <= upTo) return factor;
  }
  return 1.0;
}

// Small units cost more per m², large ones less. Anchored at the typical size
// for each property type and clamped so extremes don't run away.
export function sizeFactor(type, sizeSqm) {
  const anchor = type === "house" ? 140 : 75;
  const exponent = type === "house" ? 0.05 : 0.07;
  const raw = Math.pow(anchor / sizeSqm, exponent);
  return Math.min(1.12, Math.max(0.9, raw));
}

export function resolveArea(market, areaKey) {
  if (areaKey?.startsWith("state:")) {
    const state = market.states[areaKey.slice(6)];
    return state ? { ...state, kind: "state" } : null;
  }
  const city = market.cities[areaKey];
  return city ? { ...city, kind: "city" } : null;
}

/**
 * @param {object} market  parsed data/market.json
 * @param {object} input   { areaKey, type: "apartment"|"house", sizeSqm,
 *                           buildYear, condition, location, extras: string[],
 *                           energy }
 * @returns {object|null}  { mid, low, high, eurPerSqm, areaAvgSqm, area,
 *                           confidence, breakdown } or null for unknown area
 */
export function estimate(market, input) {
  const area = resolveArea(market, input.areaKey);
  if (!area) return null;
  const type = input.type === "house" ? "house" : "apartment";
  const sizeSqm = Number(input.sizeSqm);
  if (!Number.isFinite(sizeSqm) || sizeSqm <= 0) return null;

  const { askingDiscount, newBuildFactor } = market.params;
  const listingAsk = area.listing?.[type];
  const listingNet = listingAsk ? listingAsk * (1 - askingDiscount) : null;
  const official = area.kind === "city" ? area.official?.[type] : null;

  let base;
  let confidence;
  if (official && listingNet) {
    base = 0.55 * official + 0.45 * listingNet;
    confidence = "high";
  } else if (official) {
    base = official;
    confidence = "medium";
  } else if (listingNet) {
    base = listingNet;
    confidence = area.kind === "city" ? "medium" : "low";
  } else {
    return null;
  }

  const condition = CONDITION_FACTORS[input.condition] ?? 1.0;
  // First occupancy means new-build pricing; the build-year band would double
  // count the premium, so it is skipped in that case.
  const isNew = input.condition === "first_occupancy";
  const factors = {
    condition: isNew ? newBuildFactor : condition,
    location: LOCATION_FACTORS[input.location] ?? 1.0,
    buildYear: isNew ? 1.0 : yearFactor(Number(input.buildYear)),
    size: sizeFactor(type, sizeSqm),
    energy: isNew ? 1.0 : ENERGY_FACTORS[input.energy] ?? 1.0,
    extras: (input.extras ?? []).reduce(
      (acc, key) => acc * (EXTRA_FACTORS[key] ?? 1.0),
      1.0
    ),
  };

  let eurPerSqm = base;
  for (const f of Object.values(factors)) eurPerSqm *= f;

  const spread = confidence === "high" ? 0.09 : confidence === "medium" ? 0.14 : 0.18;
  const mid = eurPerSqm * sizeSqm;

  return {
    mid: Math.round(mid),
    low: Math.round(mid * (1 - spread)),
    high: Math.round(mid * (1 + spread)),
    eurPerSqm: Math.round(eurPerSqm),
    areaAvgSqm: Math.round(base),
    area,
    confidence,
    breakdown: {
      listingAsk: listingAsk ? Math.round(listingAsk) : null,
      listingNet: listingNet ? Math.round(listingNet) : null,
      official: official ? Math.round(official) : null,
      askingDiscount,
      factors,
    },
  };
}
