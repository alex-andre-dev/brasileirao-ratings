import { DatabaseSync } from 'node:sqlite';

export const db = new DatabaseSync('brasileirao.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS players (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    team TEXT,
    position TEXT,
    age INTEGER,
    photo TEXT
  );

  CREATE TABLE IF NOT EXISTS player_stats (
    player_id INTEGER,
    season INTEGER,
    appearances INTEGER, minutes INTEGER,
    goals INTEGER, assists INTEGER,
    shots_total INTEGER, shots_on INTEGER,
    passes_total INTEGER, passes_key INTEGER, pass_accuracy INTEGER,
    dribbles_attempts INTEGER, dribbles_success INTEGER,
    tackles INTEGER, interceptions INTEGER,
    duels_total INTEGER, duels_won INTEGER,
    raw TEXT,
    PRIMARY KEY (player_id, season)
  );
`);