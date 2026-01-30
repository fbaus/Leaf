import sqlite3

DB_PATH = "tasks.db"


def get_connection():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def query_db(query, args=()):
    conn = get_connection()
    cur = conn.execute(query, args)
    rows = cur.fetchall()
    conn.close()
    return [dict(row) for row in rows]


def execute_db(query, args=()):
    conn = get_connection()
    cur = conn.execute(query, args)
    conn.commit()
    conn.close()
