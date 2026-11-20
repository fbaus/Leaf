"""Migrazione non distruttiva del database live per il connettore MCP (Claude):
aggiunge la colonna users.api_token_hash (se non esiste già) e il suo indice univoco.
Nessun dato esistente viene toccato: la colonna nasce NULL su tutti gli utenti (nessun
token emesso finché non si usa `manage_users.py create-token`). Rieseguibile senza
errori (idempotente).
"""

import sqlite3

from config import DB_PATH


def column_exists(cursor, table, column):
    cursor.execute(f"PRAGMA table_info({table})")
    return any(row[1] == column for row in cursor.fetchall())


def main():
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()

    if not column_exists(cursor, "users", "api_token_hash"):
        cursor.execute("ALTER TABLE users ADD COLUMN api_token_hash TEXT")
        print("Colonna users.api_token_hash aggiunta.")
    else:
        print("Colonna users.api_token_hash già presente.")

    cursor.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_users_api_token_hash ON users(api_token_hash) "
        "WHERE api_token_hash IS NOT NULL"
    )
    conn.commit()
    conn.close()
    print("Migrazione completata.")


if __name__ == "__main__":
    main()
