import { estimate } from "./estimator.js";

const $ = (id) => document.getElementById(id);
const eur = (n) =>
  new Intl.NumberFormat("de-DE", {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: 0,
  }).format(n);

const market = await (await fetch("data/market.json")).json();

// ------------------------------------------------------------ populate form

const areaSelect = $("area");
const cityGroup = document.createElement("optgroup");
cityGroup.label = "Cities";
for (const [key, city] of Object.entries(market.cities).sort((a, b) =>
  a[1].name.localeCompare(b[1].name, "de")
)) {
  const opt = new Option(city.name, key);
  cityGroup.append(opt);
}
const stateGroup = document.createElement("optgroup");
stateGroup.label = "Elsewhere (state average)";
for (const [code, state] of Object.entries(market.states).sort((a, b) =>
  a[1].name.localeCompare(b[1].name, "de")
)) {
  stateGroup.append(new Option(state.name, `state:${code}`));
}
areaSelect.append(cityGroup, stateGroup);
areaSelect.value = "berlin";

$("vintage").textContent = `${market.vintage} (built ${market.generated})`;

// ---------------------------------------------------------------- estimate

const FACTOR_LABELS = {
  condition: "Condition / new-build",
  location: "Micro-location",
  buildYear: "Build-year band",
  size: "Size adjustment",
  energy: "Energy class",
  extras: "Extras",
};

$("estimate-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const extras = [];
  if ($("extra-balcony").checked) extras.push("balcony");
  if ($("extra-garden").checked) extras.push("garden");
  if ($("extra-parking").checked) extras.push("parking");

  const result = estimate(market, {
    areaKey: areaSelect.value,
    type: document.querySelector('input[name="type"]:checked').value,
    sizeSqm: $("size").value,
    buildYear: $("year").value,
    condition: $("condition").value,
    location: $("location").value,
    energy: $("energy").value,
    extras,
  });
  if (!result) return;

  $("result").hidden = false;
  $("result-mid").textContent = eur(result.mid);
  $("result-low").textContent = eur(result.low);
  $("result-high").textContent = eur(result.high);
  $("result-sqm").textContent = eur(result.eurPerSqm);
  $("result-avg").textContent = eur(result.areaAvgSqm);
  $("result-confidence").textContent = result.confidence;

  const b = result.breakdown;
  const rows = [];
  if (b.officialNewUsed)
    rows.push(["Official new-build transaction average (Gutachterausschuss)", `${eur(result.areaAvgSqm)}/m²`]);
  if (b.official && !b.officialNewUsed)
    rows.push(["Official transaction average (Gutachterausschuss)", `${eur(b.official)}/m²`]);
  if (!b.officialNewUsed && b.listingAsk)
    rows.push([
      `Listing asking average, −${Math.round(b.askingDiscount * 100)}% to transaction level`,
      `${eur(b.listingAsk)}/m² → ${eur(b.listingNet)}/m²`,
    ]);
  if (!b.officialNewUsed) rows.push(["Blended base", `${eur(result.areaAvgSqm)}/m²`]);
  for (const [key, value] of Object.entries(b.factors)) {
    if (Math.abs(value - 1) < 0.001) continue;
    rows.push([FACTOR_LABELS[key] ?? key, `× ${value.toFixed(2)}`]);
  }
  rows.push(["Adjusted", `${eur(result.eurPerSqm)}/m²`]);
  $("breakdown-table").innerHTML = rows
    .map(([label, value]) => `<tr><td>${label}</td><td>${value}</td></tr>`)
    .join("");

  const src = [];
  if (result.area.officialSource) {
    const o = result.area.official ?? {};
    const type = document.querySelector('input[name="type"]:checked').value;
    const n = o.samples?.[type];
    const detail = n ? ` — based on ${n.toLocaleString("de-DE")} notarized sales in ${o.year}` : "";
    src.push(`Official data: ${result.area.officialSource}${detail}.`);
  }
  if (result.area.listingSource) src.push(`Listing data: ${result.area.listingSource}.`);
  $("sources-note").textContent = src.join(" ");

  $("result").scrollIntoView({ behavior: "smooth", block: "nearest" });
});
