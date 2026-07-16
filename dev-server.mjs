// dev-server.mjs — LOCAL DEV ONLY.
//
// A tiny harness that emulates what `wrangler pages dev .` would do for this
// app, so you can play the game locally without a Cloudflare account:
//   - serves the static files in guess-who/
//   - routes /api/guess-who/* to the Pages Functions in functions/api/guess-who/
//   - provides a D1-compatible `env.DB` backed by node:sqlite (Node >= 22.5)
//   - provides a no-op `caches.default`
//
// Usage: node dev-server.mjs   (then open http://localhost:8788/guess-who/)

import http from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const ROOT = import.meta.dirname;
const PORT = process.env.PORT || 8788;

// ---------------------------------------------------------------- D1 shim

class D1PreparedStatement {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql;
    this.params = [];
  }
  bind(...params) {
    this.params = params.map((p) => (p === undefined ? null : p));
    return this;
  }
  async first(col) {
    const row = this.db.prepare(this.sql).get(...this.params) ?? null;
    if (col) return row ? row[col] : null;
    return row;
  }
  async all() {
    const results = this.db.prepare(this.sql).all(...this.params);
    return { results, success: true, meta: {} };
  }
  async run() {
    const info = this.db.prepare(this.sql).run(...this.params);
    return {
      success: true,
      meta: { changes: info.changes, last_row_id: info.lastInsertRowid },
    };
  }
}

class D1Shim {
  constructor(file) {
    this.db = new DatabaseSync(file);
  }
  prepare(sql) {
    return new D1PreparedStatement(this.db, sql);
  }
  async batch(stmts) {
    const out = [];
    for (const s of stmts) out.push(await s.run());
    return out;
  }
  exec(sql) {
    this.db.exec(sql);
  }
}

mkdirSync(path.join(ROOT, ".wrangler"), { recursive: true });
const DB = new D1Shim(path.join(ROOT, ".wrangler", "dev-guess-who.sqlite"));
DB.exec(await readFile(path.join(ROOT, "schema.sql"), "utf8"));

// ------------------------------------------------------------- caches shim

globalThis.caches ??= {
  default: { match: async () => undefined, put: async () => {} },
};

const env = { DB };

// ------------------------------------------------------ functions routing

const routes = [
  { re: /^\/api\/guess-who\/rooms\/?$/, mod: "./functions/api/guess-who/rooms/index.js", params: [] },
  { re: /^\/api\/guess-who\/rooms\/([^/]+)\/join$/, mod: "./functions/api/guess-who/rooms/[code]/join.js", params: ["code"] },
  { re: /^\/api\/guess-who\/rooms\/([^/]+)\/state$/, mod: "./functions/api/guess-who/rooms/[code]/state.js", params: ["code"] },
  { re: /^\/api\/guess-who\/rooms\/([^/]+)\/action$/, mod: "./functions/api/guess-who/rooms/[code]/action.js", params: ["code"] },
];

const HANDLERS = {
  GET: "onRequestGet",
  POST: "onRequestPost",
  PATCH: "onRequestPatch",
  PUT: "onRequestPut",
  DELETE: "onRequestDelete",
  OPTIONS: "onRequestOptions",
};

async function handleApi(req, urlPath) {
  for (const route of routes) {
    const m = urlPath.match(route.re);
    if (!m) continue;
    const mod = await import(route.mod + "?t=" + Date.now()); // no-cache for dev
    const params = {};
    route.params.forEach((name, i) => (params[name] = decodeURIComponent(m[i + 1])));
    const fn = mod[HANDLERS[req.method]] || mod.onRequest;
    if (!fn) return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405 });
    return fn({ request: req, env, params, waitUntil: (p) => p });
  }
  return null;
}

// ------------------------------------------------------------ static files

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".woff2": "font/woff2",
};

async function serveStatic(urlPath) {
  let rel = decodeURIComponent(urlPath);
  if (rel === "/") rel = "/guess-who/index.html";
  if (rel.endsWith("/")) rel += "index.html";
  let file = path.resolve(ROOT, "." + rel);
  if (!file.startsWith(ROOT)) return new Response("Forbidden", { status: 403 });
  if (!existsSync(file) && existsSync(file + ".html")) file += ".html";
  if (!existsSync(file) && existsSync(path.join(file, "index.html")))
    file = path.join(file, "index.html");
  try {
    const data = await readFile(file);
    const type = MIME[path.extname(file).toLowerCase()] || "application/octet-stream";
    return new Response(data, { headers: { "Content-Type": type } });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}

// ----------------------------------------------------------------- server

const server = http.createServer(async (nodeReq, nodeRes) => {
  const chunks = [];
  for await (const c of nodeReq) chunks.push(c);
  const body = Buffer.concat(chunks);
  const url = new URL(nodeReq.url, `http://localhost:${PORT}`);
  const req = new Request(url, {
    method: nodeReq.method,
    headers: nodeReq.headers,
    body: ["GET", "HEAD"].includes(nodeReq.method) ? undefined : body,
  });

  let res;
  try {
    res = url.pathname.startsWith("/api/")
      ? await handleApi(req, url.pathname)
      : await serveStatic(url.pathname);
    if (!res) res = new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
  } catch (err) {
    console.error(err);
    res = new Response(JSON.stringify({ error: String(err) }), { status: 500 });
  }

  nodeRes.writeHead(res.status, Object.fromEntries(res.headers));
  nodeRes.end(Buffer.from(await res.arrayBuffer()));
});

server.listen(PORT, () => {
  console.log(`dev server: http://localhost:${PORT}/guess-who/`);
});
