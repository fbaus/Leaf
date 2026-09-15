"""Migrazione non distruttiva del database live per introdurre utenti/login multiutente:
crea la tabella `users` (se non esiste), aggiunge la colonna `tasks.owner_id` (se non
esiste), poi crea un account superuser dedicato "admin" (nessun dato proprio) e un account
personale con username a scelta, a cui vengono assegnati tutti i task esistenti che non
hanno ancora un proprietario. Rieseguibile senza errori (idempotente): se "admin" esiste
già non richiede di nuovo la password, e il passo dell'account personale/backfill si salta
da solo se non restano più task orfani.
"""

import getpass
import sqlite3
import sys

from werkzeug.security import generate_password_hash

from config import DB_PATH

ADMIN_USERNAME = "admin"


def column_exists(cursor, table, column):
    cursor.execute(f"PRAGMA table_info({table})")
    return any(row[1] == column for row in cursor.fetchall())


def create_user_row(cursor, username, password, is_superuser):
    cursor.execute(
        "INSERT INTO users (username, password_hash, is_superuser) VALUES (?, ?, ?)",
        (username, generate_password_hash(password), 1 if is_superuser else 0),
    )


def prompt_unique_username(cursor, prompt_text):
    while True:
        username = input(prompt_text).strip()
        if not username:
            print("Username vuoto, riprova.")
            continue
        cursor.execute("SELECT id FROM users WHERE username = ?", (username,))
        if cursor.fetchone() is not None:
            print(f'Esiste già un utente "{username}", scegline un altro.')
            continue
        return username


def prompt_password(username):
    password = getpass.getpass(f"Password per {username}: ")
    confirm = getpass.getpass("Conferma password: ")
    if not password or password != confirm:
        print("Password vuota o non corrispondente, migrazione interrotta.", file=sys.stderr)
        sys.exit(1)
    return password


def main():
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()

    cursor.execute("""
        CREATE TABLE IF NOT EXISTS users (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          username        TEXT NOT NULL UNIQUE COLLATE NOCASE CHECK (length(username) BETWEEN 1 AND 30),
          password_hash   TEXT NOT NULL,
          is_superuser    INTEGER NOT NULL DEFAULT 0 CHECK (is_superuser IN (0,1)),
          created_at      TEXT NOT NULL DEFAULT (datetime('now','localtime'))
        )
    """)

    if not column_exists(cursor, "tasks", "owner_id"):
        # nullable: SQLite non permette NOT NULL senza un default costante su una
        # tabella già popolata — il vincolo NOT NULL resta garantito dall'applicazione
        # da qui in poi (ogni INSERT INTO tasks valorizza sempre owner_id)
        cursor.execute("ALTER TABLE tasks ADD COLUMN owner_id INTEGER REFERENCES users(id) ON DELETE RESTRICT")
        print("Colonna tasks.owner_id aggiunta.")
    else:
        print("Colonna tasks.owner_id già presente.")

    cursor.execute("CREATE INDEX IF NOT EXISTS idx_tasks_owner_id ON tasks(owner_id)")

    # il vincolo "un solo task in focus" va scoped per utente, non globale in tutta
    # l'app (altrimenti attivare il focus di un utente spegnerebbe quello di un altro)
    cursor.execute("DROP INDEX IF EXISTS idx_tasks_focus_unique")
    cursor.execute("CREATE UNIQUE INDEX idx_tasks_focus_unique ON tasks(owner_id) WHERE focus = 1")
    conn.commit()

    # account superuser dedicato, separato dall'account personale: non possiede task propri,
    # serve solo per amministrazione (coerente con "il superuser non vede i progetti personali")
    cursor.execute("SELECT id FROM users WHERE username = ?", (ADMIN_USERNAME,))
    if cursor.fetchone() is None:
        print(f'Creo l\'account superuser "{ADMIN_USERNAME}".')
        password = prompt_password(ADMIN_USERNAME)
        create_user_row(cursor, ADMIN_USERNAME, password, is_superuser=True)
        conn.commit()
    else:
        print(f'Account "{ADMIN_USERNAME}" già presente, salto la creazione.')

    # account personale (username a scelta) + assegnazione di tutti i task che non hanno
    # ancora un proprietario: si salta da solo se la migrazione era già stata completata
    cursor.execute("SELECT COUNT(*) FROM tasks WHERE owner_id IS NULL")
    orphan_count = cursor.fetchone()[0]
    if orphan_count > 0:
        print(f"{orphan_count} task esistenti non hanno ancora un proprietario.")
        username = prompt_unique_username(cursor, "Scegli lo username per il tuo account personale: ")
        password = prompt_password(username)
        create_user_row(cursor, username, password, is_superuser=False)
        conn.commit()
        cursor.execute("SELECT id FROM users WHERE username = ?", (username,))
        owner_id = cursor.fetchone()[0]
        cursor.execute("UPDATE tasks SET owner_id = ? WHERE owner_id IS NULL", (owner_id,))
        conn.commit()
        print(f'Task assegnati a "{username}": {cursor.rowcount}')
    else:
        print("Nessun task senza proprietario: tutti i task esistenti sono già assegnati.")

    conn.close()
    print("Migrazione completata.")


if __name__ == "__main__":
    main()
