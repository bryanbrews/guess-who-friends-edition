import {
  json, normalizeCode, getGame, playerFromToken, applyAction, saveGame, redactState,
} from "../../lib/util.js";

// POST /api/guess-who/rooms/[code]/action — {token, type: pick|ask|answer|guess|forfeit|rematch, ...}
// Returns the fresh redacted state on success so the client can render immediately.
export async function onRequestPost({ request, env, params }) {
  const code = normalizeCode(params.code);
  if (!code) return json({ error: "bad room code" }, 400);
  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid JSON body" }, 400); }

  const game = await getGame(env, code);
  if (!game) return json({ error: "room not found" }, 404);

  const playerNum = playerFromToken(game, body.token);
  if (!playerNum) return json({ error: "bad token" }, 403);

  const expected = game.version;
  const res = applyAction(game, playerNum, body);
  if (!res.ok) return json({ error: res.error }, res.status);

  if (!(await saveGame(env, game, expected)))
    return json({ error: "someone moved first — refresh" }, 409);
  return json(redactState(game, playerNum));
}
