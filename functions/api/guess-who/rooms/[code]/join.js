import { json, normalizeCode, getGame, joinGame, saveGame } from "../../lib/util.js";

// POST /api/guess-who/rooms/[code]/join — {name} -> {playerToken, playerNum:2}
export async function onRequestPost({ request, env, params }) {
  const code = normalizeCode(params.code);
  if (!code) return json({ error: "bad room code" }, 400);
  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid JSON body" }, 400); }

  const game = await getGame(env, code);
  if (!game) return json({ error: "room not found" }, 404);

  const expected = game.version;
  const res = joinGame(game, body.name);
  if (!res.ok) return json({ error: res.error }, res.status);

  if (!(await saveGame(env, game, expected))) return json({ error: "room just filled up, try again" }, 409);
  return json({ playerToken: game.p2_token, playerNum: 2 });
}
