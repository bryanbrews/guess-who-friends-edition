// Unit tests for the pure Guess Who state machine.
// Run: node --test tests/guess-who-state.test.js

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  CODE_ALPHABET,
  newCode,
  validateBoard,
  createGame,
  joinGame,
  playerFromToken,
  applyAction,
  redactState,
} from "../functions/api/guess-who/lib/util.js";

const BOARD = Array.from({ length: 24 }, (_, i) => `f${i + 1}`);

function freshGame() {
  return createGame({ name: "Bryan", board: BOARD });
}

function pickingGame() {
  const game = freshGame();
  const res = joinGame(game, "Olivia");
  assert.equal(res.ok, true);
  return game;
}

function turnsGame() {
  const game = pickingGame();
  assert.equal(applyAction(game, 1, { type: "pick", id: "f3" }).ok, true);
  assert.equal(applyAction(game, 2, { type: "pick", id: "f7" }).ok, true);
  return game; // p1 secret f3, p2 secret f7, turn 1
}

function finishedGame() {
  const game = turnsGame();
  assert.equal(applyAction(game, 1, { type: "guess", id: "f7" }).ok, true);
  return game; // p1 guessed right
}

// ---------------------------------------------------------------- helpers

describe("newCode", () => {
  test("returns 4 chars from the unambiguous alphabet", () => {
    for (let i = 0; i < 50; i++) {
      const code = newCode();
      assert.match(code, new RegExp(`^[${CODE_ALPHABET}]{4}$`));
    }
  });

  test("alphabet has no ambiguous letters", () => {
    for (const ch of ["I", "O", "L"]) assert.ok(!CODE_ALPHABET.includes(ch), ch);
  });
});

describe("validateBoard", () => {
  test("accepts 24 unique string ids", () => {
    assert.equal(validateBoard(BOARD), null);
  });
  test("rejects non-array, wrong length, duplicates, bad entries", () => {
    assert.ok(validateBoard("nope"));
    assert.ok(validateBoard(BOARD.slice(0, 23)));
    assert.ok(validateBoard([...BOARD.slice(0, 23), "f1"]));
    assert.ok(validateBoard([...BOARD.slice(0, 23), 42]));
    assert.ok(validateBoard([...BOARD.slice(0, 23), ""]));
  });
});

describe("createGame / joinGame", () => {
  test("creates a waiting game with p1 only", () => {
    const game = freshGame();
    assert.equal(game.state, "waiting");
    assert.equal(game.p1_name, "Bryan");
    assert.match(game.p1_token, /^[0-9a-f]{32}$/);
    assert.equal(game.p2_token, null);
    assert.deepEqual(game.board, BOARD);
    assert.equal(game.version, 0);
    assert.deepEqual(game.log, []);
  });

  test("join moves waiting -> picking and bumps version", () => {
    const game = freshGame();
    const res = joinGame(game, "Olivia");
    assert.equal(res.ok, true);
    assert.equal(game.state, "picking");
    assert.equal(game.p2_name, "Olivia");
    assert.match(game.p2_token, /^[0-9a-f]{32}$/);
    assert.equal(game.version, 1);
  });

  test("join rejected when game already has two players", () => {
    const game = pickingGame();
    const res = joinGame(game, "Zach");
    assert.equal(res.ok, false);
    assert.equal(res.status, 409);
  });

  test("join rejected with empty name", () => {
    const game = freshGame();
    const res = joinGame(game, "  ");
    assert.equal(res.ok, false);
    assert.equal(res.status, 400);
  });
});

describe("playerFromToken", () => {
  test("maps tokens to player numbers, rejects tampering", () => {
    const game = pickingGame();
    assert.equal(playerFromToken(game, game.p1_token), 1);
    assert.equal(playerFromToken(game, game.p2_token), 2);
    assert.equal(playerFromToken(game, "deadbeef".repeat(4)), null);
    assert.equal(playerFromToken(game, ""), null);
    assert.equal(playerFromToken(game, null), null);
  });
});

// ------------------------------------------------------------------ pick

describe("pick", () => {
  test("first pick stays in picking, second starts turns with turn=1", () => {
    const game = pickingGame();
    const v0 = game.version;
    let res = applyAction(game, 1, { type: "pick", id: "f3" });
    assert.equal(res.ok, true);
    assert.equal(game.state, "picking");
    assert.equal(game.p1_secret, "f3");
    assert.equal(game.version, v0 + 1);

    res = applyAction(game, 2, { type: "pick", id: "f7" });
    assert.equal(res.ok, true);
    assert.equal(game.state, "turns");
    assert.equal(game.turn, 1);
    assert.equal(game.p2_secret, "f7");
    assert.equal(game.version, v0 + 2);
  });

  test("rejects pick of id not on board", () => {
    const game = pickingGame();
    const res = applyAction(game, 1, { type: "pick", id: "nope" });
    assert.equal(res.ok, false);
    assert.equal(res.status, 400);
  });

  test("rejects double pick by same player", () => {
    const game = pickingGame();
    applyAction(game, 1, { type: "pick", id: "f3" });
    const res = applyAction(game, 1, { type: "pick", id: "f5" });
    assert.equal(res.ok, false);
    assert.equal(res.status, 409);
    assert.equal(game.p1_secret, "f3");
  });

  test("rejects pick outside picking phase", () => {
    const game = freshGame();
    const res = applyAction(game, 1, { type: "pick", id: "f3" });
    assert.equal(res.ok, false);
    assert.equal(res.status, 409);
  });
});

// ------------------------------------------------------------------- ask

describe("ask", () => {
  test("current player asks; question logged; turn unchanged until answer", () => {
    const game = turnsGame();
    const res = applyAction(game, 1, { type: "ask", q: "Would they cry at a stranger's wedding?" });
    assert.equal(res.ok, true);
    assert.equal(game.turn, 1);
    assert.deepEqual(game.log.at(-1), { t: "ask", p: 1, q: "Would they cry at a stranger's wedding?" });
  });

  test("rejects out-of-turn ask", () => {
    const game = turnsGame();
    const res = applyAction(game, 2, { type: "ask", q: "Hmm?" });
    assert.equal(res.ok, false);
    assert.equal(res.status, 409);
  });

  test("rejects a second ask while one is pending", () => {
    const game = turnsGame();
    applyAction(game, 1, { type: "ask", q: "One?" });
    const res = applyAction(game, 1, { type: "ask", q: "Two?" });
    assert.equal(res.ok, false);
    assert.equal(res.status, 409);
  });

  test("rejects empty or oversized question", () => {
    const game = turnsGame();
    assert.equal(applyAction(game, 1, { type: "ask", q: "  " }).status, 400);
    assert.equal(applyAction(game, 1, { type: "ask", q: "x".repeat(301) }).status, 400);
  });
});

// ---------------------------------------------------------------- answer

describe("answer", () => {
  test("opponent answers and turn flips", () => {
    const game = turnsGame();
    applyAction(game, 1, { type: "ask", q: "Chaotic?" });
    const res = applyAction(game, 2, { type: "answer", value: "yes" });
    assert.equal(res.ok, true);
    assert.equal(game.turn, 2);
    assert.deepEqual(game.log.at(-1), { t: "answer", p: 2, v: "yes" });
  });

  test("asker cannot answer their own question", () => {
    const game = turnsGame();
    applyAction(game, 1, { type: "ask", q: "Chaotic?" });
    const res = applyAction(game, 1, { type: "answer", value: "no" });
    assert.equal(res.ok, false);
    assert.equal(res.status, 409);
  });

  test("rejects answer when no question is pending", () => {
    const game = turnsGame();
    const res = applyAction(game, 2, { type: "answer", value: "yes" });
    assert.equal(res.ok, false);
    assert.equal(res.status, 409);
  });

  test("rejects values other than yes/no", () => {
    const game = turnsGame();
    applyAction(game, 1, { type: "ask", q: "Chaotic?" });
    const res = applyAction(game, 2, { type: "answer", value: "maybe" });
    assert.equal(res.ok, false);
    assert.equal(res.status, 400);
  });
});

// ----------------------------------------------------------------- guess

describe("guess", () => {
  test("correct guess wins for the guesser", () => {
    const game = turnsGame(); // p2 secret is f7
    const res = applyAction(game, 1, { type: "guess", id: "f7" });
    assert.equal(res.ok, true);
    assert.equal(game.state, "finished");
    assert.equal(game.winner, 1);
    assert.equal(game.finish_reason, "guess_right");
    assert.deepEqual(game.log.at(-1), { t: "guess", p: 1, id: "f7", correct: true });
  });

  test("wrong guess loses for the guesser", () => {
    const game = turnsGame();
    const res = applyAction(game, 1, { type: "guess", id: "f1" });
    assert.equal(res.ok, true);
    assert.equal(game.state, "finished");
    assert.equal(game.winner, 2);
    assert.equal(game.finish_reason, "guess_wrong");
    assert.deepEqual(game.log.at(-1), { t: "guess", p: 1, id: "f1", correct: false });
  });

  test("rejects guess out of turn, off-board, or while a question is pending", () => {
    let game = turnsGame();
    assert.equal(applyAction(game, 2, { type: "guess", id: "f3" }).status, 409);
    assert.equal(applyAction(game, 1, { type: "guess", id: "nope" }).status, 400);
    applyAction(game, 1, { type: "ask", q: "Pending?" });
    assert.equal(applyAction(game, 1, { type: "guess", id: "f7" }).status, 409);
  });
});

// --------------------------------------------------------------- forfeit

describe("forfeit", () => {
  test("forfeit in turns gives the win to the opponent", () => {
    const game = turnsGame();
    const res = applyAction(game, 2, { type: "forfeit" });
    assert.equal(res.ok, true);
    assert.equal(game.state, "finished");
    assert.equal(game.winner, 1);
    assert.equal(game.finish_reason, "forfeit");
  });

  test("forfeit works during picking too", () => {
    const game = pickingGame();
    const res = applyAction(game, 1, { type: "forfeit" });
    assert.equal(res.ok, true);
    assert.equal(game.winner, 2);
  });

  test("rejects forfeit after the game is finished", () => {
    const game = finishedGame();
    assert.equal(applyAction(game, 2, { type: "forfeit" }).status, 409);
  });
});

// --------------------------------------------------------------- rematch

describe("rematch", () => {
  test("resets to picking, keeps players and board, clears the rest", () => {
    const game = finishedGame();
    const v = game.version;
    const res = applyAction(game, 2, { type: "rematch" });
    assert.equal(res.ok, true);
    assert.equal(game.state, "picking");
    assert.equal(game.turn, null);
    assert.equal(game.winner, null);
    assert.equal(game.finish_reason, null);
    assert.equal(game.p1_secret, null);
    assert.equal(game.p2_secret, null);
    assert.deepEqual(game.log, []);
    assert.deepEqual(game.board, BOARD);
    assert.equal(game.p1_name, "Bryan");
    assert.equal(game.p2_name, "Olivia");
    assert.equal(game.version, v + 1);
  });

  test("rejects rematch when the game is not finished", () => {
    const game = turnsGame();
    assert.equal(applyAction(game, 1, { type: "rematch" }).status, 409);
  });
});

// ------------------------------------------------------------- misc guard

describe("guards", () => {
  test("unknown action type is a 400", () => {
    const game = turnsGame();
    assert.equal(applyAction(game, 1, { type: "meditate" }).status, 400);
  });

  test("no game actions once finished", () => {
    const game = finishedGame();
    assert.equal(applyAction(game, 2, { type: "ask", q: "Hm?" }).status, 409);
    assert.equal(applyAction(game, 2, { type: "pick", id: "f1" }).status, 409);
  });

  test("every successful action bumps version by exactly 1", () => {
    const game = pickingGame();
    let v = game.version;
    for (const [p, action] of [
      [1, { type: "pick", id: "f3" }],
      [2, { type: "pick", id: "f7" }],
      [1, { type: "ask", q: "Chaotic?" }],
      [2, { type: "answer", value: "no" }],
      [2, { type: "guess", id: "f3" }],
      [1, { type: "rematch" }],
    ]) {
      assert.equal(applyAction(game, p, action).ok, true);
      assert.equal(game.version, ++v);
    }
  });
});

// ------------------------------------------------------------ redactState

describe("redactState", () => {
  test("never exposes tokens or the opponent's secret mid-game", () => {
    const game = turnsGame();
    const s = redactState(game, 1);
    const flat = JSON.stringify(s);
    assert.ok(!flat.includes(game.p1_token));
    assert.ok(!flat.includes(game.p2_token));
    assert.equal(s.you, 1);
    assert.equal(s.yourSecret, "f3");
    assert.equal(s.secrets, undefined);
    assert.equal(s.state, "turns");
    assert.equal(s.turn, 1);
    assert.deepEqual(s.board, BOARD);
    assert.deepEqual(s.log, []);
    assert.equal(s.names[1], "Bryan");
    assert.equal(s.names[2], "Olivia");
    assert.equal(s.version, game.version);
  });

  test("p2 view redacts p1's secret", () => {
    const game = turnsGame();
    const s = redactState(game, 2);
    assert.equal(s.yourSecret, "f7");
    assert.equal(s.secrets, undefined);
    // p1's secret must not appear anywhere outside the board list
    const { board, ...rest } = s;
    assert.ok(!JSON.stringify(rest).includes('"f3"'));
  });

  test("reveals both secrets once finished", () => {
    const game = finishedGame();
    const s = redactState(game, 2);
    assert.deepEqual(s.secrets, { 1: "f3", 2: "f7" });
    assert.equal(s.winner, 1);
    assert.equal(s.finishReason, "guess_right");
  });
});
