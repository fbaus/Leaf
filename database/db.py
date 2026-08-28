import sqlite3

DB_PATH = "tasks.db"


def get_connection():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def query_db(query, args=()):
    conn = get_connection()
    cur = conn.execute(query, args)
    rows = cur.fetchall()
    conn.close()
    return [dict(row) for row in rows]


def query_one(query, args=()):
    conn = get_connection()
    cur = conn.execute(query, args)
    row = cur.fetchone()
    conn.close()
    return dict(row) if row else None


def execute_db(query, args=()):
    conn = get_connection()
    cur = conn.execute(query, args)
    conn.commit()
    last_id = cur.lastrowid
    conn.close()
    return last_id


def execute_transaction(statements):
    """statements: list of (query, args) executed atomically in one connection."""
    conn = get_connection()
    try:
        conn.execute("BEGIN IMMEDIATE")
        for query, args in statements:
            conn.execute(query, args)
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()
