import sqlite3

from config import DB_PATH

conn = sqlite3.connect(DB_PATH)
cursor = conn.cursor()

cursor.executescript("""
DROP TABLE IF EXISTS notes;
DROP TABLE IF EXISTS task_dependencies;
DROP TABLE IF EXISTS tasks;
DROP TABLE IF EXISTS users;

CREATE TABLE users (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  username               TEXT NOT NULL UNIQUE COLLATE NOCASE CHECK (length(username) BETWEEN 1 AND 30),
  password_hash          TEXT NOT NULL,
  is_superuser           INTEGER NOT NULL DEFAULT 0 CHECK (is_superuser IN (0,1)),
  can_set_project_code   INTEGER NOT NULL DEFAULT 0 CHECK (can_set_project_code IN (0,1)),
  created_at             TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE tasks (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_id       INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
  owner_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
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
  estimated_days  REAL CHECK (estimated_days IS NULL OR estimated_days > 0),
  -- solo un nodo radice (parent_id NULL) può avere un codice progetto: i discendenti lo
  -- ereditano per calcolo (risalendo la radice), mai copiato/memorizzato su di loro
  project_code    TEXT CHECK (project_code IS NULL OR (parent_id IS NULL AND project_code GLOB '[0-9][0-9][0-9]-20[0-9][0-9]')),
  -- delega interna fra utenti registrati: committente/esecutore valorizzati solo sul nodo
  -- effettivamente delegato, mai ereditati dai discendenti (a differenza di project_code)
  committente_user_id INTEGER REFERENCES users(id),
  executor_user_id    INTEGER REFERENCES users(id),
  delegation_status TEXT CHECK (delegation_status IS NULL OR delegation_status IN ('in_attesa','accettata')),
  delegation_notice TEXT CHECK (delegation_notice IS NULL OR delegation_notice IN ('posticipata','anticipata','accettata')),
  -- foglia delegata chiusa come COMPLETATO in attesa di conferma del committente (fase di
  -- "accettazione del completamento", analoga a delegation_status='in_attesa' per la delega
  -- stessa): delegation_status resta 'accettata' per tutta questa fase, è questo flag a
  -- marcare l'attesa, non un nuovo valore del suo enum (vedi CHECK sotto e gotcha CHECK
  -- incrociati in CLAUDE.md)
  completion_pending INTEGER NOT NULL DEFAULT 0 CHECK (completion_pending IN (0,1)),
  created_at      TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  -- colonne, non CHECK, devono precedere questi vincoli a livello di tabella (grammatica SQLite)
  CHECK (
    (committente_user_id IS NULL AND executor_user_id IS NULL AND delegation_status IS NULL)
    OR (committente_user_id IS NOT NULL AND executor_user_id IS NOT NULL AND delegation_status IS NOT NULL)
  ),
  CHECK (delegation_notice IS NULL OR committente_user_id IS NOT NULL),
  CHECK (completion_pending = 0 OR executor_user_id IS NOT NULL)
);

CREATE INDEX idx_tasks_parent_id ON tasks(parent_id);
CREATE INDEX idx_tasks_owner_id ON tasks(owner_id);
-- un solo task in focus PER UTENTE, non uno globale in tutta l'app: senza owner_id
-- nella chiave, attivare il focus di un utente spegnerebbe quello di un altro
CREATE UNIQUE INDEX idx_tasks_focus_unique ON tasks(owner_id) WHERE focus = 1;
-- codice progetto unico in tutta l'app (fra tutti gli utenti, non solo per owner): è
-- proprio la segnalazione della collisione fra utenti diversi il punto della funzionalità
CREATE UNIQUE INDEX idx_tasks_project_code ON tasks(project_code) WHERE project_code IS NOT NULL;
CREATE INDEX idx_tasks_committente_user_id ON tasks(committente_user_id) WHERE committente_user_id IS NOT NULL;
CREATE INDEX idx_tasks_executor_user_id ON tasks(executor_user_id) WHERE executor_user_id IS NOT NULL;

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

DROP TABLE IF EXISTS checklist_items;

CREATE TABLE checklist_items (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id         INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  description     TEXT NOT NULL CHECK (length(description) BETWEEN 1 AND 60),
  assegnato       TEXT CHECK (assegnato IS NULL OR length(assegnato) <= 20),
  execution_date  TEXT,
  deadline        TEXT,
  completed       INTEGER NOT NULL DEFAULT 0 CHECK (completed IN (0,1)),
  created_at      TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX idx_checklist_task_id ON checklist_items(task_id);

DROP TABLE IF EXISTS planning_blocks;

CREATE TABLE planning_blocks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id     INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  day         TEXT NOT NULL,
  start_min   INTEGER NOT NULL CHECK (start_min >= 0 AND start_min < 1440),
  end_min     INTEGER NOT NULL CHECK (end_min > 0 AND end_min <= 1440),
  created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  CHECK (end_min > start_min)
);
CREATE INDEX idx_planning_blocks_day ON planning_blocks(day);
CREATE INDEX idx_planning_blocks_task_id ON planning_blocks(task_id);
""")

conn.commit()
conn.close()

print("Database ricreato correttamente.")
