import { createAiGame, applyAiAction, aiRedact, traitAnswer } from "./ai.js";

// Guess Who — Friends Edition. Server-authoritative via /api/guess-who;
// this client polls state (1.5s visible, 5s hidden) and keeps only cosmetic
// things local: flipped-down faces and the current UI mode.

const API = "/api/guess-who";
const POLL_VISIBLE = 1500;
const POLL_HIDDEN = 5000;

let roster = [];
let rosterById = new Map();
let deck = { categories: [], questions: [] };

let session = loadJSON("gw:session"); // {code, token, playerNum, name}
let state = null;                     // last redacted server state
let flips = new Set();                // roster ids flipped down (local)
let pickSelection = null;             // pick screen selection
let guessMode = false;
let activeCat = null;
let pollTimer = null;
let pollBackoff = 0;
let aiGame = null;   // full AI game object (has secrets/weights); persisted to gw:ai
let aiTimer = null;  // pending AI think-delay timer
const isAi = () => !!session && session.mode === "ai";

const $ = (id) => document.getElementById(id);

// ------------------------------------------------------------- utilities

function loadJSON(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
}
function saveJSON(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch { /* private mode */ }
}
function clearSession() {
  if (session) localStorage.removeItem(`gw:flips:${session.code}`);
  localStorage.removeItem("gw:session");
  localStorage.removeItem("gw:ai");
  clearTimeout(aiTimer);
  aiGame = null;
  session = null;
  state = null;
  flips = new Set();
  pickSelection = null;
  guessMode = false;
}
function loadFlips() {
  flips = new Set(loadJSON(`gw:flips:${session.code}`) || []);
}
function saveFlips() {
  saveJSON(`gw:flips:${session.code}`, [...flips]);
}
function opponentName() {
  if (!state) return "opponent";
  return state.names[state.you === 1 ? 2 : 1] || "opponent";
}
function pendingAsk() {
  const last = state && state.log[state.log.length - 1];
  return last && last.t === "ask" ? last : null;
}
function usedQuestions() {
  const used = new Set();
  if (state) for (const e of state.log) if (e.t === "ask") used.add(e.q);
  return used;
}

async function api(path, opts) {
  const res = await fetch(API + path, opts);
  let body = null;
  try { body = await res.json(); } catch { /* non-JSON error */ }
  return { ok: res.ok, status: res.status, body };
}

// ------------------------------------------------------------------ poll

function schedulePoll(ms) {
  clearTimeout(pollTimer);
  if (!session || isAi()) return;
  pollTimer = setTimeout(poll, ms ?? (document.hidden ? POLL_HIDDEN : POLL_VISIBLE));
}

async function poll() {
  if (!session || isAi()) return;
  const since = state ? `&since=${state.version}` : "";
  let res;
  try {
    res = await api(`/rooms/${session.code}/state?token=${session.token}${since}`);
  } catch {
    connLost();
    return;
  }
  if (res.status === 403 || res.status === 404) {
    clearSession();
    render();
    return;
  }
  if (!res.ok) { connLost(); return; }

  $("conn-pill").hidden = true;
  pollBackoff = 0;
  if (res.body && res.body.state) {
    // full state (something changed)
    state = res.body;
    render();
  }
  schedulePoll();
}

function connLost() {
  $("conn-pill").hidden = false;
  pollBackoff = Math.min((pollBackoff || POLL_VISIBLE) * 2, 10000);
  schedulePoll(pollBackoff);
}

async function sendAction(action) {
  if (isAi()) return aiDo(action);
  let res;
  try {
    res = await api(`/rooms/${session.code}/action`, {
      method: "POST",
      body: JSON.stringify({ token: session.token, ...action }),
    });
  } catch {
    connLost();
    return false;
  }
  if (res.ok && res.body && res.body.state) {
    state = res.body;
    render();
    schedulePoll();
    return true;
  }
  if (res.status === 409) {
    // stale or race — grab fresh state and re-render
    state = null;
    poll();
  } else if (res.status === 403 || res.status === 404) {
    clearSession();
    render();
  } else if (res.body && res.body.error) {
    alert(res.body.error);
  }
  return false;
}

function aiDo(action) {
  const res = applyAiAction(aiGame, action);
  if (!res.ok) return false;
  saveJSON("gw:ai", aiGame);
  state = aiRedact(aiGame);
  render();
  maybeScheduleAiStep();
  return true;
}

function maybeScheduleAiStep() {
  clearTimeout(aiTimer);
  if (!isAi() || !aiGame || aiGame.state !== "turns" || aiGame.turn !== 2) return;
  const last = aiGame.log[aiGame.log.length - 1];
  if (last && last.t === "ask") return; // AI already asked; waiting on your answer
  aiTimer = setTimeout(() => {
    const r = applyAiAction(aiGame, { type: "ai_step" });
    if (!r.ok) return;
    saveJSON("gw:ai", aiGame);
    state = aiRedact(aiGame);
    render();
    maybeScheduleAiStep();
  }, 600 + Math.random() * 600);
}

// ---------------------------------------------------------------- render

const SCREENS = ["screen-lobby", "screen-wait", "screen-pick", "screen-game", "screen-end"];

function show(id) {
  for (const s of SCREENS) $(s).hidden = s !== id;
}

function render() {
  if (!session) { renderLobby(); return; }
  if (!state) { show(null); return; } // resuming: wait for first poll
  switch (state.state) {
    case "waiting": renderWait(); break;
    case "picking": renderPick(); break;
    case "turns": renderGame(); break;
    case "finished": renderEnd(); break;
    default: renderLobby();
  }
}

function renderLobby() {
  show("screen-lobby");
  const name = localStorage.getItem("gw:name") || "";
  if (!$("create-name").value) $("create-name").value = name;
  if (!$("join-name").value) $("join-name").value = name;
  if (!$("ai-name").value) $("ai-name").value = name;
  const joinCode = new URLSearchParams(location.search).get("join");
  if (joinCode && !$("join-code").value) $("join-code").value = joinCode.toUpperCase();
}

function renderWait() {
  show("screen-wait");
  $("wait-code").textContent = session.code;
}

function faceButton(person, { onTap }) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "face";
  btn.dataset.id = person.id;
  const img = document.createElement("img");
  img.src = person.img;
  img.alt = person.name;
  const nm = document.createElement("span");
  nm.className = "nm";
  nm.textContent = person.name;
  btn.append(img, nm);
  btn.addEventListener("click", () => onTap(person, btn));
  return btn;
}

function boardPeople() {
  return state.board.map((id) => rosterById.get(id)).filter(Boolean);
}

function renderPick() {
  show("screen-pick");
  const picked = !!state.yourSecret;
  $("pick-waiting").hidden = !picked;
  $("btn-confirm-pick").parentElement.hidden = picked;
  const grid = $("pick-grid");
  grid.hidden = picked;
  if (picked) return;

  // fresh round: local flips are stale
  flips = new Set();
  saveFlips();

  grid.replaceChildren(...boardPeople().map((p) =>
    faceButton(p, {
      onTap: (person) => {
        pickSelection = person.id;
        for (const el of grid.children) el.classList.toggle("selected", el.dataset.id === person.id);
        $("btn-confirm-pick").disabled = false;
      },
    })
  ));
  for (const el of grid.children) el.classList.toggle("selected", el.dataset.id === pickSelection);
  $("btn-confirm-pick").disabled = !pickSelection;
}

function renderGame() {
  show("screen-game");
  loadFlips();
  const myTurn = state.turn === state.you;
  const pending = pendingAsk();

  // status line
  $("game-status").textContent = myTurn
    ? "Your turn"
    : `${opponentName()}'s turn`;

  // your secret chip
  const secret = rosterById.get(state.yourSecret);
  $("secret-chip").replaceChildren();
  if (secret) {
    const img = document.createElement("img");
    img.src = secret.img;
    img.alt = "";
    const label = document.createElement("span");
    label.textContent = `You are ${secret.name}`;
    $("secret-chip").append(img, label);
  }

  renderBoard();
  if (isAi()) renderAiBadges();
  renderTurnPanel(myTurn, pending);
  renderLog();
}

function renderBoard() {
  const board = $("board");
  board.replaceChildren(...boardPeople().map((p) =>
    faceButton(p, {
      onTap: (person, btn) => {
        if (guessMode && !flips.has(person.id)) {
          confirmGuess(person);
          return;
        }
        if (flips.has(person.id)) flips.delete(person.id);
        else flips.add(person.id);
        saveFlips();
        btn.classList.toggle("flipped", flips.has(person.id));
      },
    })
  ));
  for (const el of board.children) {
    el.classList.toggle("flipped", flips.has(el.dataset.id));
    el.classList.toggle("guessable", guessMode);
  }
}

function activeAiAsk() {
  for (let i = aiGame.log.length - 1; i >= 0; i--) {
    const e = aiGame.log[i];
    if (e.t === "ask" && e.p === 1) {
      const next = aiGame.log[i + 1];
      return next && next.t === "answer" && next.p === 2 ? { q: e.q, answer: next.v } : null;
    }
  }
  return null;
}

function renderAiBadges() {
  const board = $("board");
  for (const el of board.children) {
    const old = el.querySelector(".ai-badge");
    if (old) old.remove();
  }
  const ask = aiGame.state === "turns" ? activeAiAsk() : null;
  const help = $("ai-flip-help");
  if (!ask) { help.hidden = true; return; }
  for (const el of board.children) {
    if (el.classList.contains("flipped")) continue;
    const would = traitAnswer(aiGame.seed, el.dataset.id, ask.q);
    const badge = document.createElement("span");
    badge.className = "ai-badge " + (would === ask.answer ? "yes" : "no");
    badge.textContent = would === ask.answer ? "✓" : "✗";
    el.appendChild(badge);
  }
  help.hidden = false;
}

function renderTurnPanel(myTurn, pending) {
  for (const id of ["panel-ask", "panel-guess", "panel-asked", "panel-answer", "panel-theirs"])
    $(id).hidden = true;
  for (const el of document.querySelectorAll(".opp-name")) el.textContent = opponentName();

  if (pending && pending.p !== state.you) {
    $("panel-answer").hidden = false;
    $("answer-q").textContent = pending.q;
  } else if (pending) {
    $("panel-asked").hidden = false;
    $("asked-q").textContent = pending.q;
  } else if (myTurn && guessMode) {
    $("panel-guess").hidden = false;
  } else if (myTurn) {
    $("panel-ask").hidden = false;
    renderDeck();
  } else {
    $("panel-theirs").hidden = false;
  }
}

function renderDeck() {
  const used = usedQuestions();
  if (!activeCat) activeCat = deck.categories[0]?.id;

  $("q-cats").replaceChildren(...deck.categories.map((c) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "q-cat" + (c.id === activeCat ? " active" : "");
    b.textContent = c.label;
    b.addEventListener("click", () => { activeCat = c.id; renderDeck(); });
    return b;
  }));

  $("q-list").replaceChildren(...deck.questions
    .filter((q) => q.cat === activeCat)
    .map((q) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "q-item";
      b.textContent = q.text;
      b.disabled = used.has(q.text);
      b.addEventListener("click", () => sendAction({ type: "ask", q: q.text }));
      return b;
    }));
}

function renderLog() {
  const names = state.names;
  $("log").replaceChildren(...state.log.map((e) => {
    const li = document.createElement("li");
    const who = document.createElement("span");
    who.className = "who";
    who.textContent = names[e.p] || `P${e.p}`;
    li.append(who);
    if (e.t === "ask") {
      li.append(`: ${e.q}`);
    } else if (e.t === "answer") {
      const ans = document.createElement("span");
      ans.className = e.v === "yes" ? "ans-yes" : "ans-no";
      ans.textContent = ` ${e.v.toUpperCase()}`;
      li.append(ans);
    } else if (e.t === "guess") {
      const target = rosterById.get(e.id);
      li.append(` guessed ${target ? target.name : e.id} — ${e.correct ? "right!" : "wrong"}`);
    }
    return li;
  }));
}

function renderEnd() {
  show("screen-end");
  guessMode = false;
  const won = state.winner === state.you;
  $("end-title").textContent = won ? "You win! 🎉" : "You lose";
  const reasons = {
    guess_right: won ? "You guessed it." : `${opponentName()} guessed your friend.`,
    guess_wrong: won ? `${opponentName()} guessed wrong.` : "Wrong guess — brutal.",
    forfeit: won ? `${opponentName()} forfeited.` : "You forfeited.",
  };
  $("end-detail").textContent = reasons[state.finishReason] || "";

  const mine = rosterById.get(state.secrets?.[state.you]);
  const theirs = rosterById.get(state.secrets?.[state.you === 1 ? 2 : 1]);
  if (mine) { $("reveal-1").src = mine.img; $("reveal-cap-1").textContent = `You were ${mine.name}`; }
  if (theirs) { $("reveal-2").src = theirs.img; $("reveal-cap-2").textContent = `${opponentName()} was ${theirs.name}`; }
}

// --------------------------------------------------------------- actions

function confirmGuess(person) {
  if (!confirm(`Guess ${person.name}?\n\nIf you're wrong, you LOSE the game.`)) return;
  guessMode = false;
  sendAction({ type: "guess", id: person.id });
}

async function createRoom(name) {
  const board = [...roster].sort(() => Math.random() - 0.5).slice(0, 24).map((p) => p.id);
  const res = await api("/rooms", { method: "POST", body: JSON.stringify({ name, board }) });
  if (!res.ok) { showLobbyError(res.body?.error || "Couldn't create room"); return; }
  session = { code: res.body.code, token: res.body.playerToken, playerNum: 1, name };
  saveJSON("gw:session", session);
  state = null;
  poll();
}

async function joinRoom(name, code) {
  const res = await api(`/rooms/${code}/join`, { method: "POST", body: JSON.stringify({ name }) });
  if (!res.ok) { showLobbyError(res.body?.error || "Couldn't join room"); return; }
  session = { code, token: res.body.playerToken, playerNum: 2, name };
  saveJSON("gw:session", session);
  state = null;
  poll();
}

function startAiGame(name) {
  const board = [...roster].sort(() => Math.random() - 0.5).slice(0, 24).map((p) => p.id);
  const deckQuestions = deck.questions.map((q) => q.text);
  const seed = (Math.floor(Math.random() * 0xffffffff)) >>> 0;
  aiGame = createAiGame({ board, playerName: name, deckQuestions, seed });
  session = { mode: "ai", code: "AI", name };
  saveJSON("gw:session", session);
  saveJSON("gw:ai", aiGame);
  state = aiRedact(aiGame);
  render();
}

function showLobbyError(msg) {
  const el = $("lobby-error");
  el.textContent = msg;
  el.hidden = false;
}

// ------------------------------------------------------------ wire it up

function wireEvents() {
  $("form-create").addEventListener("submit", (e) => {
    e.preventDefault();
    const name = $("create-name").value.trim();
    if (!name) return;
    localStorage.setItem("gw:name", name);
    createRoom(name);
  });

  $("form-join").addEventListener("submit", (e) => {
    e.preventDefault();
    const name = $("join-name").value.trim();
    const code = $("join-code").value.trim().toUpperCase();
    if (!name || code.length !== 4) return;
    localStorage.setItem("gw:name", name);
    joinRoom(name, code);
  });

  $("form-ai").addEventListener("submit", (e) => {
    e.preventDefault();
    const name = $("ai-name").value.trim();
    if (!name) return;
    localStorage.setItem("gw:name", name);
    startAiGame(name);
  });

  $("btn-share").addEventListener("click", async () => {
    const url = `${location.origin}/guess-who/?join=${session.code}`;
    try {
      await navigator.clipboard.writeText(url);
      $("btn-share").textContent = "Copied!";
      setTimeout(() => ($("btn-share").textContent = "Copy invite link"), 1500);
    } catch {
      prompt("Copy this link:", url);
    }
  });

  $("btn-abandon-wait").addEventListener("click", () => {
    clearSession();
    render();
  });

  $("btn-confirm-pick").addEventListener("click", () => {
    if (pickSelection) sendAction({ type: "pick", id: pickSelection });
  });

  $("btn-guess-mode").addEventListener("click", () => { guessMode = true; renderGame(); });
  $("btn-guess-cancel").addEventListener("click", () => { guessMode = false; renderGame(); });

  $("form-freeq").addEventListener("submit", (e) => {
    e.preventDefault();
    const q = $("freeq-input").value.trim();
    if (!q) return;
    $("freeq-input").value = "";
    sendAction({ type: "ask", q });
  });

  $("btn-yes").addEventListener("click", () => sendAction({ type: "answer", value: "yes" }));
  $("btn-no").addEventListener("click", () => sendAction({ type: "answer", value: "no" }));

  $("btn-forfeit").addEventListener("click", () => {
    if (confirm("Forfeit the game?")) sendAction({ type: "forfeit" });
  });

  $("btn-flip-for-me").addEventListener("click", () => {
    if (!isAi()) return;
    const ask = activeAiAsk();
    if (!ask) return;
    for (const id of state.board) {
      if (flips.has(id)) continue;
      if (traitAnswer(aiGame.seed, id, ask.q) !== ask.answer) flips.add(id);
    }
    saveFlips();
    renderGame();
  });

  $("btn-rematch").addEventListener("click", () => {
    flips = new Set();
    saveFlips();
    pickSelection = null;
    sendAction({ type: "rematch" });
  });

  $("btn-new-game").addEventListener("click", () => {
    clearSession();
    render();
  });

  document.addEventListener("visibilitychange", () => schedulePoll());
}

async function init() {
  const [rosterRes, deckRes] = await Promise.all([
    fetch("roster.json?v=2"),
    fetch("questions.json?v=1"),
  ]);
  roster = await rosterRes.json();
  deck = await deckRes.json();
  rosterById = new Map(roster.map((p) => [p.id, p]));

  wireEvents();

  if (session && session.mode === "ai") {
    aiGame = loadJSON("gw:ai");
    if (!aiGame || aiGame.mode !== "ai" || !Array.isArray(aiGame.board) || !aiGame.ai) {
      clearSession();
      render();
    } else {
      state = aiRedact(aiGame);
      render();
      maybeScheduleAiStep();
    }
    return;
  }

  render();
  if (session) poll();
}

init();
