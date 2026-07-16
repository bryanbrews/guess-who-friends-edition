// guess-who/ai.js — pure engine for single-player vs. the computer.
// No network, no server. Mirrors the 2-player redacted-state shape so the
// existing render layer in app.js consumes it unchanged.

// ---- deterministic trait matrix --------------------------------------

export function normalizeQuestion(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function traitAnswer(seed, friendId, questionText) {
  const h = fnv1a(`${seed}|${friendId}|${normalizeQuestion(questionText)}`);
  return (h & 1) ? "yes" : "no";
}

// ---- game object ------------------------------------------------------

export function createAiGame({ board, playerName, deckQuestions, seed }) {
  const s = seed >>> 0;
  const aiSecret = board[fnv1a(`${s}|ai-secret`) % board.length];
  const weights = {};
  for (const id of board) weights[id] = 1;
  return {
    mode: "ai",
    seed: s,
    state: "picking",
    board: [...board],
    turn: 1,
    winner: null,
    finishReason: null,
    names: { 1: playerName, 2: "The Computer" },
    you: 1,
    yourSecret: null,
    aiSecret,
    deckQuestions: [...deckQuestions],
    log: [],
    ai: { weights, usedQ: [] },
    version: 0,
  };
}

export function aiRedact(game) {
  const out = {
    code: "AI",
    state: game.state,
    board: game.board,
    turn: game.turn,
    winner: game.winner,
    finishReason: game.finishReason,
    names: game.names,
    log: game.log,
    version: game.version,
    you: 1,
    yourSecret: game.yourSecret,
  };
  if (game.state === "finished") out.secrets = { 1: game.yourSecret, 2: game.aiSecret };
  return out;
}

// ---- action dispatch --------------------------------------------------

function pendingAsk(game) {
  const last = game.log[game.log.length - 1];
  return last && last.t === "ask" ? last : null;
}
function fail(error) { return { ok: false, error }; }

export function applyAiAction(game, action, opts = {}) {
  const rng = opts.rng || Math.random;
  switch (action.type) {
    case "pick": return aiPick(game, action);
    case "ask": return aiAsk(game, action);
    case "answer": return aiAnswer(game, action);
    case "guess": return aiGuess(game, action);
    case "forfeit": return aiForfeit(game);
    case "rematch": return aiRematch(game, rng);
    case "ai_step": return aiStep(game, rng);
    default: return fail("unknown action");
  }
}

function aiPick(game, { id }) {
  if (game.state !== "picking") return fail("not picking");
  if (!game.board.includes(id)) return fail("not on board");
  game.yourSecret = id;
  game.state = "turns";
  game.turn = 1;
  game.version++;
  return { ok: true };
}

function aiAsk(game, { q }) {
  if (game.state !== "turns") return fail("not in play");
  if (game.turn !== 1) return fail("not your turn");
  if (pendingAsk(game)) return fail("answer pending");
  const text = String(q || "").trim();
  if (!text) return fail("empty question");
  game.log.push({ t: "ask", p: 1, q: text });
  const answer = traitAnswer(game.seed, game.aiSecret, text);
  game.log.push({ t: "answer", p: 2, v: answer });
  game.turn = 2;
  game.version++;
  return { ok: true, answer };
}

function updateWeights(game, q, value) {
  for (const id of game.board) {
    if (game.ai.weights[id] <= 0) continue;
    if (traitAnswer(game.seed, id, q) !== value) game.ai.weights[id] *= 0.25;
  }
}

function aiAnswer(game, { value }) {
  if (game.state !== "turns") return fail("not in play");
  const pending = pendingAsk(game);
  if (!pending || pending.p !== 2) return fail("nothing to answer");
  if (value !== "yes" && value !== "no") return fail("bad answer");
  game.log.push({ t: "answer", p: 1, v: value });
  updateWeights(game, pending.q, value);
  game.turn = 1;
  game.version++;
  return { ok: true };
}

function aiGuess(game, { id }) {
  if (game.state !== "turns") return fail("not in play");
  if (game.turn !== 1) return fail("not your turn");
  if (pendingAsk(game)) return fail("answer pending");
  if (!game.board.includes(id)) return fail("not on board");
  const correct = id === game.aiSecret;
  game.log.push({ t: "guess", p: 1, id, correct });
  game.state = "finished";
  game.winner = correct ? 1 : 2;
  game.finishReason = correct ? "guess_right" : "guess_wrong";
  game.version++;
  return { ok: true };
}

function aiForfeit(game) {
  if (game.state === "finished") return fail("already over");
  game.state = "finished";
  game.winner = 2;
  game.finishReason = "forfeit";
  game.version++;
  return { ok: true };
}

function aiRematch(game, rng) {
  if (game.state !== "finished") return fail("not finished");
  game.seed = (Math.floor(rng() * 0xffffffff) >>> 0) ^ ((game.seed + 0x9e3779b9) >>> 0);
  game.aiSecret = game.board[fnv1a(`${game.seed}|ai-secret`) % game.board.length];
  game.yourSecret = null;
  game.state = "picking";
  game.turn = 1;
  game.winner = null;
  game.finishReason = null;
  game.log = [];
  game.ai = { weights: Object.fromEntries(game.board.map((id) => [id, 1])), usedQ: [] };
  game.version++;
  return { ok: true };
}

function aiStep(game, rng) {
  if (game.state !== "turns") return fail("not in play");
  if (game.turn !== 2) return fail("not AI turn");
  if (pendingAsk(game)) return fail("waiting for your answer");

  const ids = game.board;
  const total = ids.reduce((s, id) => s + game.ai.weights[id], 0);
  let topId = ids[0], topW = -Infinity;
  for (const id of ids) if (game.ai.weights[id] > topW) { topW = game.ai.weights[id]; topId = id; }
  const deckLeft = game.deckQuestions.filter((q) => !game.ai.usedQ.includes(q));

  if ((total > 0 && topW / total >= 0.85) || deckLeft.length === 0) {
    const correct = topId === game.yourSecret;
    game.log.push({ t: "guess", p: 2, id: topId, correct });
    game.state = "finished";
    game.winner = correct ? 2 : 1;
    game.finishReason = correct ? "guess_right" : "guess_wrong";
    game.version++;
    return { ok: true, guessed: topId };
  }

  const scored = deckLeft.map((q) => {
    let yesW = 0;
    for (const id of ids) if (traitAnswer(game.seed, id, q) === "yes") yesW += game.ai.weights[id];
    return { q, score: -Math.abs(yesW - (total - yesW)) };
  });
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, Math.min(3, scored.length));
  const pick = top[Math.floor(rng() * top.length) % top.length];
  game.ai.usedQ.push(pick.q);
  game.log.push({ t: "ask", p: 2, q: pick.q });
  game.version++;
  return { ok: true, asked: pick.q };
}
