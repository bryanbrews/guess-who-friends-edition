// Scrape face thumbnails from your own Google Photos "People" page.
// Google Photos has no API for people/face data, so this drives a real
// headful browser you log into yourself. Login persists in .pwdata/ so you
// only do it once.
//
// Usage:  node scripts/guess-who/scrape_faces.mjs
//   1. A Chromium window opens at photos.google.com/people
//   2. Log in if asked, wait until you can SEE the people grid
//   3. Come back to the terminal and press Enter
//   4. Named faces land in scripts/guess-who/raw_faces/<Name>.jpg
//
// Then prune raw_faces/ down to the 24 friends you want and run
// cartoonize.mjs. If this scraper breaks (Google DOM churn), fallback:
// right-click-save portraits into raw_faces/ manually — same pipeline.

import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const OUT = path.join(HERE, "raw_faces");
const PROFILE = path.join(HERE, ".pwdata");
mkdirSync(OUT, { recursive: true });

const ctx = await chromium.launchPersistentContext(PROFILE, {
  headless: false,
  viewport: { width: 1280, height: 900 },
});
const page = ctx.pages()[0] || (await ctx.newPage());
await page.goto("https://photos.google.com/people", { waitUntil: "domcontentloaded" });

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
await rl.question(
  "\nLog in (if needed) and wait until the People grid is visible.\nThen press Enter here to scrape... "
);
rl.close();

// Scroll a few times to force lazy thumbnails to load.
for (let i = 0; i < 6; i++) {
  await page.mouse.wheel(0, 1200);
  await page.waitForTimeout(700);
}

// Generic extraction: any /people/ link that carries a name (aria-label or
// inner text) and a thumbnail (either an <img src> or a CSS background-image).
const people = await page.$$eval('a[href*="/people/"]', (links) =>
  links.map((a) => {
    const name =
      (a.getAttribute("aria-label") || "").trim() ||
      (a.textContent || "").trim();
    let src = null;
    const img = a.querySelector("img[src]");
    if (img) src = img.src;
    if (!src) {
      for (const el of [a, ...a.querySelectorAll("*")]) {
        const bg = getComputedStyle(el).backgroundImage;
        const m = bg && bg.match(/url\("?(https:[^")]+)"?\)/);
        if (m) { src = m[1]; break; }
      }
    }
    return { name, src, href: a.href };
  })
);

const withFaces = people.filter((p) => p.name && p.src);
console.log(`Found ${people.length} people links, ${withFaces.length} with name+thumbnail.`);

if (withFaces.length === 0) {
  // Selector debugging aid: dump the page so the selectors can be fixed.
  const html = await page.content();
  const dump = path.join(HERE, "people-page-dump.html");
  writeFileSync(dump, html);
  console.error(
    `No matches — Google likely changed the DOM.\nDumped page HTML to ${dump} for selector fixes.` +
    `\nFallback: right-click-save portraits into ${OUT}/<Name>.jpg manually.`
  );
  await ctx.close();
  process.exit(1);
}

let saved = 0;
const seen = new Set();
for (const person of withFaces) {
  const name = person.name.replace(/[/\\:*?"<>|]/g, "").trim();
  if (!name || seen.has(name)) continue;
  seen.add(name);
  // Ask for a decent resolution: Google thumbnail URLs take a =s<size>-c suffix.
  const url = person.src.replace(/=s\d+(-[a-z]+)*$/i, "") + "=s512-c";
  try {
    const res = await ctx.request.get(url);
    if (!res.ok()) throw new Error(`HTTP ${res.status()}`);
    writeFileSync(path.join(OUT, `${name}.jpg`), Buffer.from(await res.body()));
    saved++;
    console.log(`  saved ${name}.jpg`);
  } catch (err) {
    console.warn(`  FAILED ${name}: ${err.message}`);
  }
}

console.log(`\nDone: ${saved} faces in ${OUT}`);
console.log("Next: delete everyone you don't want, keep 24, then run cartoonize.mjs");
await ctx.close();
