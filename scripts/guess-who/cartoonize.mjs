// Turn raw_faces/*.jpg into flat-color cartoon avatars via OpenAI gpt-image-1
// (images/edits endpoint), downscale to 512px, and regenerate
// guess-who/roster.json.
//
// Usage:
//   OPENAI_API_KEY=sk-...  node scripts/guess-who/cartoonize.mjs --test   # first 3 only
//   OPENAI_API_KEY=sk-...  node scripts/guess-who/cartoonize.mjs          # full batch
//
// Idempotent: skips faces that already have an output PNG, so delete a bad
// PNG and re-run to regenerate just that one. Serial requests with retry on
// 429 (image API rate limits are tight).

import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const RAW = path.join(HERE, "raw_faces");
const REPO = path.resolve(HERE, "../..");
const FACES = path.join(REPO, "guess-who", "faces");
const ROSTER = path.join(REPO, "guess-who", "roster.json");

const KEY = process.env.OPENAI_API_KEY;
if (!KEY) { console.error("Set OPENAI_API_KEY first."); process.exit(1); }

const TEST = process.argv.includes("--test");
// gpt-image-1 is being retired 2026-10-23; default to the cheap mini model.
// Override with MODEL=gpt-image-1.5 if a likeness drifts and needs the flagship.
const MODEL = process.env.MODEL || "gpt-image-1-mini";

const PROMPT =
  "Redraw this person as a flat-color cartoon avatar for a board game card: " +
  "head and shoulders only, bold clean outlines, simple flat colors, " +
  "friendly warm expression, solid warm cream background, centered. " +
  "Preserve the person's distinctive features (hair style and color, skin tone, " +
  "facial hair, glasses if present) so friends can recognize them. " +
  "No text, no logos, square format.";

const slugify = (s) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

async function cartoonize(file, outPath) {
  const form = new FormData();
  form.append("model", MODEL);
  form.append("prompt", PROMPT);
  form.append("size", "1024x1024");
  form.append("image", new Blob([readFileSync(file)], { type: "image/jpeg" }), path.basename(file));

  for (let attempt = 1; attempt <= 5; attempt++) {
    const res = await fetch("https://api.openai.com/v1/images/edits", {
      method: "POST",
      headers: { Authorization: `Bearer ${KEY}` },
      body: form,
    });
    if (res.status === 429 || res.status >= 500) {
      const wait = attempt * 15;
      console.log(`    ${res.status} — retrying in ${wait}s (attempt ${attempt}/5)`);
      await new Promise((r) => setTimeout(r, wait * 1000));
      continue;
    }
    const body = await res.json();
    if (!res.ok) throw new Error(body.error?.message || `HTTP ${res.status}`);
    const b64 = body.data?.[0]?.b64_json;
    if (!b64) throw new Error("no image in response");
    writeFileSync(outPath, Buffer.from(b64, "base64"));
    // Downscale in place to 512px (macOS built-in).
    execFileSync("sips", ["-Z", "512", outPath], { stdio: "ignore" });
    return;
  }
  throw new Error("gave up after 5 attempts");
}

mkdirSync(FACES, { recursive: true });
let raws;
try {
  raws = readdirSync(RAW).filter((f) => /\.(jpe?g|png|webp)$/i.test(f)).sort();
} catch {
  console.error(`${RAW} not found — run scrape_faces.mjs (or fill it manually) first.`);
  process.exit(1);
}
if (raws.length === 0) { console.error(`No images in ${RAW}.`); process.exit(1); }
if (TEST) raws = raws.slice(0, 3);
console.log(`${TEST ? "TEST BATCH: " : ""}${raws.length} faces to process.`);

const roster = [];
let generated = 0;
for (const f of raws) {
  const name = path.basename(f, path.extname(f));
  const id = slugify(name);
  const out = path.join(FACES, `${id}.png`);
  roster.push({ id, name, img: `faces/${id}.png` });
  if (existsSync(out)) { console.log(`  skip ${name} (exists)`); continue; }
  process.stdout.write(`  ${name} ...`);
  try {
    await cartoonize(path.join(RAW, f), out);
    generated++;
    console.log(" done");
  } catch (err) {
    console.log(` FAILED: ${err.message}`);
  }
}

if (!TEST) {
  writeFileSync(ROSTER, JSON.stringify(roster, null, 2) + "\n");
  console.log(`\nWrote ${ROSTER} with ${roster.length} people (${generated} newly generated).`);
  if (roster.length < 24)
    console.warn(`WARNING: roster has ${roster.length} people; the game needs at least 24 (it samples 24 per game).`);
} else {
  console.log(`\nTest batch done (${generated} generated). Review guess-who/faces/, then run without --test.`);
}
