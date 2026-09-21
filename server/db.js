const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'poker_memo.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Schema v2 is seat-based (fixed 9 seats per session, relative to "me") and is
// incompatible with the old name-based schema. Drop any old-shape tables.
const hasOldSchema = db.prepare(`
  SELECT COUNT(*) AS c FROM sqlite_master
  WHERE type = 'table' AND name IN ('players', 'hand_players')
`).get().c > 0;
if (hasOldSchema) {
  db.exec(`
    DROP TABLE IF EXISTS actions;
    DROP TABLE IF EXISTS hand_players;
    DROP TABLE IF EXISTS hands;
    DROP TABLE IF EXISTS players;
    DROP TABLE IF EXISTS sessions;
  `);
}

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    small_blind REAL,
    big_blind REAL,
    memo TEXT,
    dealer_seat INTEGER NOT NULL DEFAULT 0,
    my_slot INTEGER NOT NULL DEFAULT 0, -- which of the 9 visual table positions is "me"
    created_at TEXT NOT NULL
  );

  -- seat_no 0 is always "me". 1-8 are the eight seats going around the table
  -- from me (labelled A-H). Seats are fixed slots for a session; the person
  -- sitting in one can change without changing the seat's identity.
  CREATE TABLE IF NOT EXISTS seats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    seat_no INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'active', -- active | away | empty
    generation INTEGER NOT NULL DEFAULT 1, -- bumped when the occupant is reset
    memo TEXT,
    stack REAL, -- optional, in BB
    updated_at TEXT NOT NULL,
    UNIQUE(session_id, seat_no)
  );

  CREATE TABLE IF NOT EXISTS hands (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    hand_no INTEGER NOT NULL,
    dealer_seat_no INTEGER NOT NULL,
    board_flop TEXT,
    board_turn TEXT,
    board_river TEXT,
    pot_size REAL,
    winner_seat_id INTEGER REFERENCES seats(id) ON DELETE SET NULL,
    memo TEXT,
    finished INTEGER NOT NULL DEFAULT 0, -- 0 while it's the session's live/open hand
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS hand_seats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    hand_id INTEGER NOT NULL REFERENCES hands(id) ON DELETE CASCADE,
    seat_id INTEGER NOT NULL REFERENCES seats(id) ON DELETE CASCADE,
    generation INTEGER NOT NULL,
    hole_cards TEXT,
    folded INTEGER NOT NULL DEFAULT 0,
    UNIQUE(hand_id, seat_id)
  );

  CREATE TABLE IF NOT EXISTS actions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    hand_id INTEGER NOT NULL REFERENCES hands(id) ON DELETE CASCADE,
    seat_id INTEGER NOT NULL REFERENCES seats(id) ON DELETE CASCADE,
    street TEXT NOT NULL,
    seq INTEGER NOT NULL,
    action_type TEXT NOT NULL,
    amount REAL,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_seats_session ON seats(session_id);
  CREATE INDEX IF NOT EXISTS idx_hands_session ON hands(session_id);
  CREATE INDEX IF NOT EXISTS idx_hand_seats_hand ON hand_seats(hand_id);
  CREATE INDEX IF NOT EXISTS idx_hand_seats_seat ON hand_seats(seat_id);
  CREATE INDEX IF NOT EXISTS idx_actions_hand ON actions(hand_id);
`);

const sessionCols = db.prepare("PRAGMA table_info(sessions)").all().map((c) => c.name);
if (!sessionCols.includes('my_slot')) {
  db.exec('ALTER TABLE sessions ADD COLUMN my_slot INTEGER NOT NULL DEFAULT 0');
}
const handCols = db.prepare("PRAGMA table_info(hands)").all().map((c) => c.name);
if (!handCols.includes('finished')) {
  db.exec('ALTER TABLE hands ADD COLUMN finished INTEGER NOT NULL DEFAULT 0');
}
const seatCols = db.prepare("PRAGMA table_info(seats)").all().map((c) => c.name);
if (!seatCols.includes('stack')) {
  db.exec('ALTER TABLE seats ADD COLUMN stack REAL');
}

module.exports = db;
