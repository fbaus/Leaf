import os

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
