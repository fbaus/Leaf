"""Migrazione non distruttiva del database live: aggiunge la colonna
tasks.branch_closed_status (se non esiste già), che permette di marcare un ramo come
"chiuso" (Quarantena o Interrotto, mai Completato — vedi BRANCH_CLOSED_STATUSES in app.py)
senza toccare lo stato dei suoi figli — serve solo a nasconderli dalla vista Foglie finché
il ramo non viene riaperto. Nessun dato esistente viene toccato: la colonna nasce NULL su
tutti i task attuali. Rieseguibile senza errori (idempotente).
"""

import sqlite3

from config import DB_PATH


def column_exists(cursor, table, column):
    cursor.execute(f"PRAGMA table_info({table})")
    return any(row[1] == column for row in cursor.fetchall())


def main():
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()

    if not column_exists(cursor, "tasks", "branch_closed_status"):
        cursor.execute(
            "ALTER TABLE tasks ADD COLUMN branch_closed_status INTEGER "
            "CHECK (branch_closed_status IS NULL OR branch_closed_status IN (8, 10))"
        )
        print("Colonna tasks.branch_closed_status aggiunta.")
    else:
        print("Colonna tasks.branch_closed_status già presente.")

    conn.commit()
    conn.close()
    print("Migrazione completata.")


if __name__ == "__main__":
    main()
