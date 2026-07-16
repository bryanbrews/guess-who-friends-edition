import { json, validateBoard, createGame, insertGame } from "../lib/util.js";

const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// POST /api/guess-who/rooms — create a game. {name, board} -> {code, playerToken, playerNum:1}
export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid JSON body" }, 400); }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return json({ error: "name required" }, 400);
  const boardError = validateBoard(body.board);
  if (boardError) return json({ error: boardError }, 400);

  // Opportunistic housekeeping: drop games older than 7 days.
  try {
    await env.DB.prepare("DELETE FROM gw_games WHERE created_at < ?")
      .bind(Date.now() - MAX_AGE_MS).run();
  } catch { /* best effort */ }

  // Retry a couple of times on the (rare) code collision.
  for (let attempt = 0; attempt < 3; attempt++) {
    const game = createGame({ name, board: body.board });
    try {
      await insertGame(env, game);
      return json({ code: game.code, playerToken: game.p1_token, playerNum: 1 }, 201);
    } catch (err) {
      if (attempt === 2) throw err;
    }
  }
}
