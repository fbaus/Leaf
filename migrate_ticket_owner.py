"""Migrazione non distruttiva del database live per il canale di delega "ticket":
aggiunge la colonna tasks.ticket_owner_id (se non esiste già) e il suo indice.
Nessun dato esistente viene toccato: la colonna nasce NULL su tutti i task attuali
(nessuno di essi è un ticket, dato che il canale non esisteva ancora). Rieseguibile
senza errori (idempotente).
"""

import sqlite3

from config import DB_PATH


def column_exists(cursor, table, column):
    cursor.execute(f"PRAGMA table_info({table})")
    return any(row[1] == column for row in cursor.fetchall())


def main():
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()

    if not column_exists(cursor, "tasks", "ticket_owner_id"):
        cursor.execute("ALTER TABLE tasks ADD COLUMN ticket_owner_id INTEGER REFERENCES users(id)")
        print("Colonna tasks.ticket_owner_id aggiunta.")
    else:
        print("Colonna tasks.ticket_owner_id già presente.")

    cursor.execute(
        "CREATE INDEX IF NOT EXISTS idx_tasks_ticket_owner_id ON tasks(ticket_owner_id) "
        "WHERE ticket_owner_id IS NOT NULL"
    )
    conn.commit()
    conn.close()
    print("Migrazione completata.")


if __name__ == "__main__":
    main()
