import os
import secrets

# Cartella del progetto (indipendente dalla cartella da cui viene lanciato lo script)
BASE_DIR = os.path.dirname(os.path.abspath(__file__))

# Percorso del database SQLite. Di default è "tasks.db" dentro la cartella del
# progetto. Per usare un percorso diverso (es. una cartella cloud sincronizzata
# come OneDrive/Google Drive/Dropbox) impostare la variabile d'ambiente
# LEAF_DB_PATH con il percorso completo desiderato, ad esempio in PowerShell:
#
#   $env:LEAF_DB_PATH = "C:\Users\francesco\OneDrive\Leaf\tasks.db"
#
# La cartella di destinazione deve già esistere: sqlite non la crea da sola.
DB_PATH = os.environ.get("LEAF_DB_PATH", os.path.join(BASE_DIR, "tasks.db"))

# Percorso del file che contiene la chiave usata per firmare i cookie di sessione
# (login multiutente). Non è mai importato/generato a import-time di questo modulo
# (sporcherebbe script come init_db.py/backup_db.py che importano solo DB_PATH) —
# va chiamato load_secret_key() esplicitamente da app.py all'avvio.
SECRET_KEY_PATH = os.environ.get("LEAF_SECRET_KEY_PATH", os.path.join(BASE_DIR, ".secret_key"))


def load_secret_key():
    """Legge la secret key da SECRET_KEY_PATH, generandola una tantum se il file non
    esiste ancora. Deve restare stabile fra riavvii del processo Flask, altrimenti ogni
    riavvio invaliderebbe i cookie di sessione firmati e disconnetterebbe tutti."""
    if os.path.exists(SECRET_KEY_PATH):
        with open(SECRET_KEY_PATH, "r") as f:
            return f.read().strip()
    key = secrets.token_hex(32)
    with open(SECRET_KEY_PATH, "w") as f:
        f.write(key)
    return key
