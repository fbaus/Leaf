"""CLI per la gestione degli account utente (login multiutente). Nessuna UI di
amministrazione esiste ancora — per ora si usano questi sottocomandi da terminale.

Uso:
  python manage_users.py create-user --username mario [--superuser]
  python manage_users.py list-users
  python manage_users.py set-password --username mario
"""

import argparse
import getpass
import sqlite3

from werkzeug.security import generate_password_hash

from config import DB_PATH


def connect():
    conn = sqlite3.connect(DB_PATH)
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def create_user(username, is_superuser):
    conn = connect()
    cur = conn.cursor()
    cur.execute("SELECT id FROM users WHERE username = ?", (username,))
    if cur.fetchone() is not None:
        print(f'Esiste già un utente "{username}".')
        conn.close()
        return
    password = getpass.getpass(f"Password per {username}: ")
    confirm = getpass.getpass("Conferma password: ")
    if not password or password != confirm:
        print("Password vuota o non corrispondente, operazione annullata.")
        conn.close()
        return
    cur.execute(
        "INSERT INTO users (username, password_hash, is_superuser) VALUES (?, ?, ?)",
        (username, generate_password_hash(password), 1 if is_superuser else 0),
    )
    conn.commit()
    conn.close()
    print(f'Utente "{username}" creato' + (" (superuser)." if is_superuser else "."))


def list_users():
    conn = connect()
    rows = conn.execute(
        "SELECT id, username, is_superuser, created_at FROM users ORDER BY id"
    ).fetchall()
    conn.close()
    if not rows:
        print("Nessun utente registrato.")
        return
    for id_, username, is_superuser, created_at in rows:
        tag = " [superuser]" if is_superuser else ""
        print(f"{id_}\t{username}{tag}\t{created_at}")


def set_password(username):
    conn = connect()
    cur = conn.cursor()
    cur.execute("SELECT id FROM users WHERE username = ?", (username,))
    row = cur.fetchone()
    if row is None:
        print(f'Nessun utente "{username}".')
        conn.close()
        return
    password = getpass.getpass(f"Nuova password per {username}: ")
    confirm = getpass.getpass("Conferma password: ")
    if not password or password != confirm:
        print("Password vuota o non corrispondente, operazione annullata.")
        conn.close()
        return
    cur.execute(
        "UPDATE users SET password_hash = ? WHERE id = ?",
        (generate_password_hash(password), row[0]),
    )
    conn.commit()
    conn.close()
    print(f'Password aggiornata per "{username}".')


def main():
    parser = argparse.ArgumentParser(description="Gestione utenti Leaf")
    sub = parser.add_subparsers(dest="command", required=True)

    p_create = sub.add_parser("create-user")
    p_create.add_argument("--username", required=True)
    p_create.add_argument("--superuser", action="store_true")

    sub.add_parser("list-users")

    p_setpw = sub.add_parser("set-password")
    p_setpw.add_argument("--username", required=True)

    args = parser.parse_args()

    if args.command == "create-user":
        create_user(args.username, args.superuser)
    elif args.command == "list-users":
        list_users()
    elif args.command == "set-password":
        set_password(args.username)


if __name__ == "__main__":
    main()
