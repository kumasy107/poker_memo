const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'poker_memo.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    small_blind REAL,
    big_blind REAL,
    memo TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS players (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    seat_order INTEGER NOT NULL,
    is_me INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS hands (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    hand_no INTEGER NOT NULL,
    dealer_player_id INTEGER REFERENCES players(id) ON DELETE SET NULL,
    board_flop TEXT,
    board_turn TEXT,
    board_river TEXT,
    pot_size REAL,
    winner_player_id INTEGER REFERENCES players(id) ON DELETE SET NULL,
    memo TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS hand_players (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    hand_id INTEGER NOT NULL REFERENCES hands(id) ON DELETE CASCADE,
    player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    hole_cards TEXT,
    folded INTEGER NOT NULL DEFAULT 0,
    UNIQUE(hand_id, player_id)
  );

  CREATE TABLE IF NOT EXISTS actions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    hand_id INTEGER NOT NULL REFERENCES hands(id) ON DELETE CASCADE,
    player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    street TEXT NOT NULL,
    seq INTEGER NOT NULL,
    action_type TEXT NOT NULL,
    amount REAL,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_players_session ON players(session_id);
  CREATE INDEX IF NOT EXISTS idx_hands_session ON hands(session_id);
  CREATE INDEX IF NOT EXISTS idx_hand_players_hand ON hand_players(hand_id);
  CREATE INDEX IF NOT EXISTS idx_actions_hand ON actions(hand_id);
`);

module.exports = db;
