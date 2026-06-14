import Database from 'better-sqlite3'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS rooms (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL DEFAULT '',
  -- 1 = title is auto-generated and may be refined/overwritten; 0 = user-fixed, never touched
  title_auto  INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS personas (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  system_prompt TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS participants (
  uid            TEXT PRIMARY KEY,
  room_id        TEXT NOT NULL REFERENCES rooms(id),
  persona_id     TEXT REFERENCES personas(id),
  nickname       TEXT NOT NULL,
  type           TEXT NOT NULL CHECK (type IN ('human','agent')),
  token          TEXT NOT NULL UNIQUE,
  last_acked_seq INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL,
  UNIQUE (room_id, nickname)
);

CREATE TABLE IF NOT EXISTS events (
  room_id     TEXT NOT NULL REFERENCES rooms(id),
  seq         INTEGER NOT NULL,
  msg_id      TEXT NOT NULL UNIQUE,
  sender_uid  TEXT,
  kind        TEXT NOT NULL,
  text        TEXT,
  in_reply_to TEXT,
  mentions    TEXT NOT NULL DEFAULT '[]',
  muted       INTEGER NOT NULL DEFAULT 0,
  payload     TEXT,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (room_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_events_reply ON events(room_id, in_reply_to);
CREATE INDEX IF NOT EXISTS idx_events_sender ON events(room_id, sender_uid);
`

export function openDb(path: string): Database.Database {
  const db = new Database(path)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.exec(SCHEMA)
  // migrate DBs created before title_auto existed
  const roomCols = db.prepare('PRAGMA table_info(rooms)').all() as Array<{ name: string }>
  if (!roomCols.some((c) => c.name === 'title_auto')) {
    db.exec("ALTER TABLE rooms ADD COLUMN title_auto INTEGER NOT NULL DEFAULT 1")
  }
  if (!roomCols.some((c) => c.name === 'cwd')) {
    db.exec("ALTER TABLE rooms ADD COLUMN cwd TEXT DEFAULT NULL")
  }
  if (!roomCols.some((c) => c.name === 'machine_id')) {
    db.exec("ALTER TABLE rooms ADD COLUMN machine_id TEXT DEFAULT NULL")
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_rooms_cwd ON rooms(cwd)")
  return db
}
