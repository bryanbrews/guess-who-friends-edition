import test from "node:test";
import assert from "node:assert/strict";
import { normalizeQuestion, traitAnswer, createAiGame, aiRedact, applyAiAction } from "../guess-who/ai.js";

test("normalizeQuestion collapses case, whitespace, punctuation", () => {
  assert.equal(normalizeQuestion("Would they CRY?  "), "would they cry");
  assert.equal(normalizeQuestion("would  they\tcry"), "would they cry");
  assert.notEqual(normalizeQuestion("would they cry"), normalizeQuestion("would they laugh"));
});

test("traitAnswer is deterministic and normalization-stable", () => {
  const a = traitAnswer(123, "ava", "Would they cry at a wedding?");
  assert.ok(a === "yes" || a === "no");
  assert.equal(a, traitAnswer(123, "ava", "  would they CRY at a wedding  "));
});

test("traitAnswer diverges across seeds and friends", () => {
  const q = "Do they text back fast?";
  let diffSeed = 0, diffFriend = 0;
  for (let s = 0; s < 40; s++) if (traitAnswer(s, "ava", q) !== traitAnswer(s + 1000, "ava", q)) diffSeed++;
  for (const f of ["ava", "ben", "cora", "dan", "evan"]) if (traitAnswer(7, f, q) !== traitAnswer(7, "ava", q)) diffFriend++;
  assert.ok(diffSeed > 5, "seeds should produce varied answers");
  assert.ok(diffFriend > 0, "friends should differ");
});

const BOARD = ["a", "b", "c", "d", "e", "f", "g", "h"];
const DECK = [
  "Would they cry at a wedding", "Do they text back fast", "Are they always late",
  "Would they skip the party", "Do they hold grudges", "Would they lie to be kind",
  "Are they the loud friend", "Do they love a spreadsheet", "Would they adopt a stray",
  "Do they read the terms", "Would they win a fight", "Are they secretly romantic",
];
const mkGame = (seed = 42) =>
  createAiGame({ board: BOARD, playerName: "You", deckQuestions: DECK, seed });

test("createAiGame starts in picking with uniform weights and a hidden secret", () => {
  const g = mkGame();
  assert.equal(g.state, "picking");
  assert.equal(g.turn, 1);
  assert.equal(g.you, 1);
  assert.equal(g.yourSecret, null);
  assert.ok(BOARD.includes(g.aiSecret));
  assert.deepEqual(Object.values(g.ai.weights), BOARD.map(() => 1));
  assert.deepEqual(g.names, { 1: "You", 2: "The Computer" });
});

test("aiRedact hides secrets until finished", () => {
  const g = mkGame();
  const r = aiRedact(g);
  assert.equal(r.secrets, undefined);
  assert.equal(r.code, "AI");
  assert.equal(JSON.stringify(r).includes(g.aiSecret) && r.yourSecret === g.aiSecret, false);
  g.state = "finished";
  g.yourSecret = "a";
  assert.deepEqual(aiRedact(g).secrets, { 1: "a", 2: g.aiSecret });
});

test("pick advances to turns, your turn", () => {
  const g = mkGame();
  const r = applyAiAction(g, { type: "pick", id: "c" });
  assert.equal(r.ok, true);
  assert.equal(g.state, "turns");
  assert.equal(g.turn, 1);
  assert.equal(g.yourSecret, "c");
  assert.equal(g.version, 1);
  assert.equal(applyAiAction(g, { type: "pick", id: "d" }).ok, false); // no double pick
});

test("your ask auto-answers from the AI secret and hands the turn over", () => {
  const g = mkGame();
  applyAiAction(g, { type: "pick", id: "c" });
  const v = g.version;
  const r = applyAiAction(g, { type: "ask", q: "Are they always late?" });
  assert.equal(r.ok, true);
  assert.equal(g.turn, 2);
  assert.equal(g.version, v + 1);
  const last2 = g.log.slice(-2);
  assert.deepEqual(last2[0], { t: "ask", p: 1, q: "Are they always late?" });
  assert.equal(last2[1].t, "answer");
  assert.equal(last2[1].p, 2);
  assert.equal(last2[1].v, traitAnswer(g.seed, g.aiSecret, "Are they always late?"));
});

test("you can only answer a pending AI question; weights update softly", () => {
  const g = mkGame();
  applyAiAction(g, { type: "pick", id: "c" });
  assert.equal(applyAiAction(g, { type: "answer", value: "yes" }).ok, false); // nothing pending
  // Simulate the AI having asked:
  g.turn = 2;
  g.log.push({ t: "ask", p: 2, q: "Do they hold grudges?" });
  const before = { ...g.ai.weights };
  const r = applyAiAction(g, { type: "answer", value: "yes" });
  assert.equal(r.ok, true);
  assert.equal(g.turn, 1);
  for (const id of BOARD) {
    const match = traitAnswer(g.seed, id, "Do they hold grudges?") === "yes";
    assert.equal(g.ai.weights[id], before[id] * (match ? 1 : 0.25));
  }
});

test("your correct guess wins; wrong guess loses", () => {
  const g = mkGame();
  applyAiAction(g, { type: "pick", id: "c" });
  const right = applyAiAction(g, { type: "guess", id: g.aiSecret });
  assert.equal(right.ok, true);
  assert.equal(g.state, "finished");
  assert.equal(g.winner, 1);
  assert.equal(g.finishReason, "guess_right");

  const g2 = mkGame(99);
  applyAiAction(g2, { type: "pick", id: "c" });
  const wrongId = BOARD.find((x) => x !== g2.aiSecret);
  applyAiAction(g2, { type: "guess", id: wrongId });
  assert.equal(g2.winner, 2);
  assert.equal(g2.finishReason, "guess_wrong");
});

test("forfeit hands the win to the computer", () => {
  const g = mkGame();
  applyAiAction(g, { type: "pick", id: "c" });
  applyAiAction(g, { type: "forfeit" });
  assert.equal(g.state, "finished");
  assert.equal(g.winner, 2);
  assert.equal(g.finishReason, "forfeit");
});

function splitAbs(g, q) {
  let yes = 0, no = 0;
  for (const id of g.board) (traitAnswer(g.seed, id, q) === "yes" ? (yes += g.ai.weights[id]) : (no += g.ai.weights[id]));
  return Math.abs(yes - no);
}

test("ai_step asks a most-balanced unused question and never repeats", () => {
  const g = mkGame();
  applyAiAction(g, { type: "pick", id: "c" });
  applyAiAction(g, { type: "ask", q: DECK[0] });   // turn -> 2
  const r1 = applyAiAction(g, { type: "ai_step" }, { rng: () => 0 });
  assert.equal(r1.ok, true);
  const asked1 = g.log[g.log.length - 1];
  assert.equal(asked1.t, "ask");
  assert.equal(asked1.p, 2);
  // rng:()=>0 picks the top-scored (most balanced) of the remaining deck:
  const remaining = DECK.filter((q) => q !== asked1.q);
  const bestAbs = Math.min(...DECK.map((q) => splitAbs(g, q)));
  assert.equal(splitAbs(g, asked1.q), bestAbs);
  // answer it, take another AI turn, ensure no repeat
  applyAiAction(g, { type: "answer", value: "yes" });
  applyAiAction(g, { type: "ask", q: DECK[1] });
  const r2 = applyAiAction(g, { type: "ai_step" }, { rng: () => 0 });
  const asked2 = g.log[g.log.length - 1];
  assert.notEqual(asked2.q, asked1.q);
  assert.ok(remaining.includes(asked2.q));
});

test("ai_step guesses the dominant candidate (>=85%) — wrong guess hands you the win", () => {
  const g = mkGame();
  applyAiAction(g, { type: "pick", id: "a" });   // your secret is 'a'
  g.turn = 2;
  for (const id of BOARD) g.ai.weights[id] = 0.01;
  g.ai.weights["e"] = 100;                        // 'e' dominates, but you are 'a'
  const r = applyAiAction(g, { type: "ai_step" }, { rng: () => 0 });
  assert.equal(r.guessed, "e");
  assert.equal(g.state, "finished");
  assert.equal(g.winner, 1);                      // AI guessed wrong -> you win
  assert.equal(g.finishReason, "guess_wrong");
});

test("ai_step guesses when the deck is exhausted", () => {
  const g = mkGame();
  applyAiAction(g, { type: "pick", id: "a" });
  g.turn = 2;
  g.ai.usedQ = [...DECK];
  const r = applyAiAction(g, { type: "ai_step" }, { rng: () => 0 });
  assert.ok(r.guessed);
  assert.equal(g.state, "finished");
});

test("rematch reseeds and returns to picking", () => {
  const g = mkGame();
  applyAiAction(g, { type: "pick", id: "a" });
  applyAiAction(g, { type: "guess", id: g.aiSecret });
  const oldSeed = g.seed;
  const r = applyAiAction(g, { type: "rematch" }, { rng: () => 0.123456 });
  assert.equal(r.ok, true);
  assert.equal(g.state, "picking");
  assert.equal(g.yourSecret, null);
  assert.equal(g.log.length, 0);
  assert.deepEqual(Object.values(g.ai.weights), BOARD.map(() => 1));
  assert.notEqual(g.seed, oldSeed);
});

test("a full honest game always terminates in a finished state", () => {
  for (let seed = 0; seed < 25; seed++) {
    const g = createAiGame({ board: BOARD, playerName: "You", deckQuestions: DECK, seed });
    const mySecret = BOARD[seed % BOARD.length];
    applyAiAction(g, { type: "pick", id: mySecret });
    const humanDeck = [...DECK];
    let guard = 0;
    while (g.state === "turns" && guard++ < 500) {
      const pend = g.log[g.log.length - 1];
      if (pend && pend.t === "ask" && pend.p === 2) {
        // answer honestly about your own secret (consistent with the matrix)
        applyAiAction(g, { type: "answer", value: traitAnswer(g.seed, mySecret, pend.q) });
      } else if (g.turn === 1) {
        const q = humanDeck.shift();
        if (q) applyAiAction(g, { type: "ask", q });
        else applyAiAction(g, { type: "guess", id: g.board[0] });
      } else {
        applyAiAction(g, { type: "ai_step" }, { rng: () => 0 });
      }
    }
    assert.equal(g.state, "finished", `seed ${seed} did not terminate`);
    assert.ok(g.winner === 1 || g.winner === 2);
  }
});

test("wrong AI guess always yields winner=1", () => {
  const g = createAiGame({ board: BOARD, playerName: "You", deckQuestions: DECK, seed: 5 });
  applyAiAction(g, { type: "pick", id: "a" });
  g.turn = 2;
  for (const id of BOARD) g.ai.weights[id] = 0;
  g.ai.weights["h"] = 1;                 // dominant but wrong (you are 'a')
  applyAiAction(g, { type: "ai_step" }, { rng: () => 0 });
  assert.equal(g.winner, 1);
});
