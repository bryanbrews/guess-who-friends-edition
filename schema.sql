-- Guess Who — Friends Edition (/guess-who). One row per game, optimistic
-- locking via `version` (every mutation: UPDATE … WHERE code=? AND version=?).
CREATE TABLE IF NOT EXISTS gw_games (
  code TEXT PRIMARY KEY,                  -- 4 letters, unambiguous alphabet
  state TEXT NOT NULL DEFAULT 'waiting',  -- waiting|picking|turns|finished
  board TEXT NOT NULL,                    -- JSON array of 24 roster ids
  turn INTEGER,                           -- 1|2, whose turn in 'turns'
  winner INTEGER,                         -- 1|2 when finished
  finish_reason TEXT,                     -- guess_right|guess_wrong|forfeit
  p1_token TEXT NOT NULL,                 -- secrets, never sent in state
  p2_token TEXT,
  p1_name TEXT NOT NULL,
  p2_name TEXT,
  p1_secret TEXT,                         -- picked roster ids
  p2_secret TEXT,
  log TEXT NOT NULL DEFAULT '[]',         -- JSON events: ask/answer/guess
  version INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
