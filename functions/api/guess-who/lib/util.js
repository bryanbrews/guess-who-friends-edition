// Shared helpers for /api/guess-who — mirrors functions/api/electrical/lib/util.js style.
//
// The whole game lives in one gw_games row. `applyAction` below is a PURE
// state machine over the parsed game object (no DB, no crypto side effects
// beyond token minting in createGame/joinGame) so it's unit-testable with
// node --test. Endpoints parse the row, apply, then write back with an
// optimistic lock on `version`.

export const BOARD_SIZE = 24;
export const MAX_NAME = 40;
export const MAX_QUESTION = 300;
export const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ"; // no I, L, O (ambiguous)

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export function newToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function newCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  return [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
}

const ok = () => ({ ok: true });
const fail = (status, error) => ({ ok: false, status, error });

export function validateBoard(board) {
  if (!Array.isArray(board) || board.length !== BOARD_SIZE)
    return `board must be an array of ${BOARD_SIZE} ids`;
  const seen = new Set();
  for (const id of board) {
    if (typeof id !== "string" || !id.trim() || id.length > 64) return "bad board id";
    if (seen.has(id)) return "duplicate board id";
    seen.add(id);
  }
  return null;
}

function cleanName(name) {
  return typeof name === "string" ? name.trim().slice(0, MAX_NAME) : "";
}

export function createGame({ name, board }) {
  const now = Date.now();
  return {
    code: newCode(),
    state: "waiting",
    board,
    turn: null,
    winner: null,
    finish_reason: null,
    p1_token: newToken(),
    p2_token: null,
    p1_name: cleanName(name),
    p2_name: null,
    p1_secret: null,
    p2_secret: null,
    log: [],
    version: 0,
    created_at: now,
    updated_at: now,
  };
}

export function joinGame(game, name) {
  const clean = cleanName(name);
  if (!clean) return fail(400, "name required");
  if (game.state !== "waiting" || game.p2_token) return fail(409, "game already has two players");
  game.p2_token = newToken();
  game.p2_name = clean;
  game.state = "picking";
  game.version += 1;
  return ok();
}

export function playerFromToken(game, token) {
  if (typeof token !== "string" || !token) return null;
  if (token === game.p1_token) return 1;
  if (game.p2_token && token === game.p2_token) return 2;
  return null;
}

function pendingAsk(game) {
  const last = game.log[game.log.length - 1];
  return last && last.t === "ask" ? last : null;
}

// Pure state machine: mutates `game` in place on success (version += 1),
// otherwise returns {ok:false, status, error} and leaves it untouched.
export function applyAction(game, playerNum, action) {
  const type = action && action.type;
  const opponent = playerNum === 1 ? 2 : 1;
  let result;
  switch (type) {
    case "pick":
      result = doPick(game, playerNum, action);
      break;
    case "ask":
      result = doAsk(game, playerNum, action);
      break;
    case "answer":
      result = doAnswer(game, playerNum, action);
      break;
    case "guess":
      result = doGuess(game, playerNum, opponent, action);
      break;
    case "forfeit":
      if (game.state !== "picking" && game.state !== "turns")
        return fail(409, "nothing to forfeit");
      finish(game, opponent, "forfeit");
      result = ok();
      break;
    case "rematch":
      if (game.state !== "finished") return fail(409, "game is not finished");
      game.state = "picking";
      game.turn = null;
      game.winner = null;
      game.finish_reason = null;
      game.p1_secret = null;
      game.p2_secret = null;
      game.log = [];
      result = ok();
      break;
    default:
      return fail(400, "unknown action type");
  }
  if (result.ok) {
    game.version += 1;
    game.updated_at = Date.now();
  }
  return result;
}

function doPick(game, playerNum, action) {
  if (game.state !== "picking") return fail(409, "not in picking phase");
  const key = playerNum === 1 ? "p1_secret" : "p2_secret";
  if (game[key]) return fail(409, "you already picked");
  if (!game.board.includes(action.id)) return fail(400, "id not on board");
  game[key] = action.id;
  if (game.p1_secret && game.p2_secret) {
    game.state = "turns";
    game.turn = 1;
  }
  return ok();
}

function doAsk(game, playerNum, action) {
  if (game.state !== "turns" || game.turn !== playerNum) return fail(409, "not your turn");
  if (pendingAsk(game)) return fail(409, "a question is already pending");
  const q = typeof action.q === "string" ? action.q.trim() : "";
  if (!q) return fail(400, "question required");
  if (q.length > MAX_QUESTION) return fail(400, `question too long (max ${MAX_QUESTION})`);
  game.log.push({ t: "ask", p: playerNum, q });
  return ok();
}

function doAnswer(game, playerNum, action) {
  if (game.state !== "turns") return fail(409, "not in play");
  const pending = pendingAsk(game);
  if (!pending) return fail(409, "no question pending");
  if (pending.p === playerNum) return fail(409, "you can't answer your own question");
  if (action.value !== "yes" && action.value !== "no") return fail(400, "answer must be yes or no");
  game.log.push({ t: "answer", p: playerNum, v: action.value });
  game.turn = playerNum; // turn flips to the answerer
  return ok();
}

function doGuess(game, playerNum, opponent, action) {
  if (game.state !== "turns" || game.turn !== playerNum) return fail(409, "not your turn");
  if (pendingAsk(game)) return fail(409, "answer pending question first");
  if (!game.board.includes(action.id)) return fail(400, "id not on board");
  const target = opponent === 1 ? game.p1_secret : game.p2_secret;
  const correct = action.id === target;
  game.log.push({ t: "guess", p: playerNum, id: action.id, correct });
  finish(game, correct ? playerNum : opponent, correct ? "guess_right" : "guess_wrong");
  return ok();
}

function finish(game, winner, reason) {
  game.state = "finished";
  game.winner = winner;
  game.finish_reason = reason;
  game.turn = null;
}

// ------------------------------------------------------------- DB plumbing

export function normalizeCode(raw) {
  const code = typeof raw === "string" ? raw.trim().toUpperCase() : "";
  return new RegExp(`^[${CODE_ALPHABET}]{4}$`).test(code) ? code : null;
}

export async function getGame(env, code) {
  const row = await env.DB.prepare("SELECT * FROM gw_games WHERE code = ?").bind(code).first();
  if (!row) return null;
  return { ...row, board: JSON.parse(row.board), log: JSON.parse(row.log) };
}

export async function insertGame(env, game) {
  await env.DB.prepare(
    `INSERT INTO gw_games (code, state, board, turn, winner, finish_reason,
       p1_token, p2_token, p1_name, p2_name, p1_secret, p2_secret,
       log, version, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    game.code, game.state, JSON.stringify(game.board), game.turn, game.winner,
    game.finish_reason, game.p1_token, game.p2_token, game.p1_name, game.p2_name,
    game.p1_secret, game.p2_secret, JSON.stringify(game.log), game.version,
    game.created_at, game.updated_at
  ).run();
}

// Optimistic lock: expectedVersion is the version the game had when loaded.
// Returns false when someone else won the race (caller should 409).
export async function saveGame(env, game, expectedVersion) {
  const res = await env.DB.prepare(
    `UPDATE gw_games SET state=?, turn=?, winner=?, finish_reason=?,
       p2_token=?, p2_name=?, p1_secret=?, p2_secret=?, log=?, version=?, updated_at=?
     WHERE code=? AND version=?`
  ).bind(
    game.state, game.turn, game.winner, game.finish_reason,
    game.p2_token, game.p2_name, game.p1_secret, game.p2_secret,
    JSON.stringify(game.log), game.version, game.updated_at,
    game.code, expectedVersion
  ).run();
  return (res.meta?.changes ?? 0) > 0;
}

// What a player is allowed to see. Never tokens; never the opponent's secret
// until the game is finished.
export function redactState(game, playerNum) {
  const s = {
    code: game.code,
    state: game.state,
    board: game.board,
    turn: game.turn,
    winner: game.winner,
    finishReason: game.finish_reason,
    names: { 1: game.p1_name, 2: game.p2_name },
    log: game.log,
    version: game.version,
    you: playerNum,
    yourSecret: playerNum === 1 ? game.p1_secret : game.p2_secret,
  };
  if (game.state === "finished") s.secrets = { 1: game.p1_secret, 2: game.p2_secret };
  return s;
}
