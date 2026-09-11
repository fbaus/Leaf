"""Backup del database SQLite. Usa la Backup API di sqlite3 (snapshot coerente anche con
l'app in scrittura, niente bisogno di fermare Flask) e tiene solo gli ultimi MAX_BACKUPS
file, cancellando i più vecchi. Pensato per essere lanciato periodicamente da uno scheduler
esterno (Windows Task Scheduler, vedi setup_backup_task.ps1 per la schedulazione oraria),
non dal processo Flask stesso.
"""

import os
import sqlite3
from datetime import datetime

from config import BASE_DIR, DB_PATH

BACKUP_DIR = os.path.join(BASE_DIR, "backups")
# 2160 = 90 giorni a cadenza oraria. Col db attuale (~80KB) sono pochi MB totali: a questa
# scala lo spazio su disco è trascurabile, il numero conta solo per la finestra di sicurezza
# (90 giorni prima che i backup più vecchi vengano sovrascritti)
MAX_BACKUPS = 2160


def create_backup():
    os.makedirs(BACKUP_DIR, exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    backup_path = os.path.join(BACKUP_DIR, f"tasks_{timestamp}.db")

    source = sqlite3.connect(DB_PATH)
    dest = sqlite3.connect(backup_path)
    try:
        source.backup(dest)
    finally:
        dest.close()
        source.close()

    return backup_path


def enforce_retention():
    backups = sorted(
        (f for f in os.listdir(BACKUP_DIR) if f.startswith("tasks_") and f.endswith(".db")),
        reverse=True,
    )
    for stale in backups[MAX_BACKUPS:]:
        os.remove(os.path.join(BACKUP_DIR, stale))


if __name__ == "__main__":
    path = create_backup()
    enforce_retention()
    print(f"Backup creato: {path}")
