import { json, normalizeCode, getGame, playerFromToken, redactState } from "../../lib/util.js";

// GET /api/guess-who/rooms/[code]/state?token=..&since=N
// If nothing changed since `since`, replies {version} only (cheap poll).
export async function onRequestGet({ request, env, params }) {
  const code = normalizeCode(params.code);
  if (!code) return json({ error: "bad room code" }, 400);
  const url = new URL(request.url);

  const game = await getGame(env, code);
  if (!game) return json({ error: "room not found" }, 404);

  const playerNum = playerFromToken(game, url.searchParams.get("token"));
  if (!playerNum) return json({ error: "bad token" }, 403);

  const since = url.searchParams.get("since");
  if (since !== null && Number(since) === game.version) return json({ version: game.version });
  return json(redactState(game, playerNum));
}
