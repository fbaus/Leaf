import sqlite3

from config import DB_PATH

conn = sqlite3.connect(DB_PATH)
cursor = conn.cursor()

cursor.executescript("""
DROP TABLE IF EXISTS notes;
DROP TABLE IF EXISTS task_dependencies;
DROP TABLE IF EXISTS tasks;

CREATE TABLE tasks (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_id       INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
  title           TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 60),
  description     TEXT CHECK (description IS NULL OR length(description) <= 300),
  deadline        TEXT,
  status          INTEGER CHECK (status IS NULL OR status BETWEEN 1 AND 10),
  label           TEXT CHECK (label IS NULL OR label IN ('APERTO', 'CHIUSO')),
  assegnato       TEXT CHECK (assegnato IS NULL OR length(assegnato) <= 20),
  escalation_seen INTEGER NOT NULL DEFAULT 0 CHECK (escalation_seen IN (0, 1)),
  focus           INTEGER NOT NULL DEFAULT 0 CHECK (focus IN (0,1)),
  urgent          INTEGER NOT NULL DEFAULT 0 CHECK (urgent IN (0,1)),
  execution_date  TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE INDEX idx_tasks_parent_id ON tasks(parent_id);
CREATE UNIQUE INDEX idx_tasks_focus_unique ON tasks(focus) WHERE focus = 1;

CREATE TABLE task_dependencies (
  task_id       INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, depends_on_id),
  CHECK (task_id != depends_on_id)
);

CREATE TABLE notes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id     INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  note_date   TEXT NOT NULL,
  text        TEXT NOT NULL,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE UNIQUE INDEX idx_notes_task_day ON notes(task_id, note_date);
""")

conn.commit()
conn.close()

print("Database ricreato correttamente.")
