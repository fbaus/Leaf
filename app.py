from datetime import datetime

from flask import Flask, jsonify, request, render_template
from database import query_db, query_one, execute_db, execute_transaction

app = Flask(__name__)


ALLOWED_STATUSES = {
    "ATTIVO", "BLOCCATO", "PIANIFICATO", "DELEGATO", "IN ATTESA",
    "ACCANTONATO", "DA VALUTARE", "COMPLETATO", "INTERROTTO",
}
BLOCKING_STATUSES = {"BLOCCATO", "DELEGATO", "COMPLETATO", "INTERROTTO"}
FOCUS_INCOMPATIBLE_STATUSES = {
    "PIANIFICATO", "DELEGATO", "IN ATTESA", "ACCANTONATO",
    "DA VALUTARE", "COMPLETATO", "INTERROTTO",
}

# reminder/expired non possono essere colonne GENERATED in SQLite perché
# date('now') e' considerata non-deterministica: vanno calcolate in ogni query.
# Su un task COMPLETATO o INTERROTTO le notifiche non hanno più senso e vanno spente.
REMINDER_EXPIRED_SQL = """
       CASE WHEN t.execution_date IS NOT NULL
                 AND date('now', 'localtime') >= t.execution_date
                 AND t.status IS NOT 'COMPLETATO' AND t.status IS NOT 'INTERROTTO'
            THEN 1 ELSE 0 END AS reminder,
       CASE WHEN t.deadline IS NOT NULL
                 AND date('now', 'localtime') >= t.deadline
                 AND t.status IS NOT 'COMPLETATO' AND t.status IS NOT 'INTERROTTO'
            THEN 1 ELSE 0 END AS expired
"""


@app.route("/")
def index():
    return render_template("index.html")


# ---------------------------------------------------------------------------
# Validation helpers
# ---------------------------------------------------------------------------

def validate_title(title):
    if not title or not title.strip():
        raise ValueError("Titolo mancante")
    if len(title) > 60:
        raise ValueError("Titolo troppo lungo (max 60 caratteri)")
    return title


def validate_description(description):
    if description is None:
        return None
    if len(description) > 300:
        raise ValueError("Descrizione troppo lunga (max 300 caratteri)")
    return description


def validate_date(value, field_name):
    if value is None:
        return None
    try:
        datetime.strptime(value, "%Y-%m-%d")
    except ValueError:
        raise ValueError(f"{field_name} deve essere una data in formato YYYY-MM-DD")
    return value


def validate_status(status):
    if status is None:
        return None
    if status not in ALLOWED_STATUSES:
        raise ValueError(f"Status non valido: {status}")
    return status


def get_task(task_id):
    return query_one(
        f"""
        SELECT t.*,
               (SELECT COUNT(*) FROM tasks c WHERE c.parent_id = t.id) AS children_count,
               {REMINDER_EXPIRED_SQL}
        FROM tasks t
        WHERE t.id = ?
        """,
        [task_id],
    )


# ---------------------------------------------------------------------------
# Tasks API
# ---------------------------------------------------------------------------

@app.route("/tasks", methods=["GET"])
def get_tasks():
    tasks = query_db(
        f"""
        SELECT t.*,
               (SELECT COUNT(*) FROM tasks c WHERE c.parent_id = t.id) AS children_count,
               {REMINDER_EXPIRED_SQL}
        FROM tasks t
        ORDER BY t.id
        """
    )
    return jsonify(tasks)


@app.route("/tasks", methods=["POST"])
def create_task():
    data = request.get_json() or {}

    try:
        title = validate_title(data.get("title"))
        description = validate_description(data.get("description"))
        deadline = validate_date(data.get("deadline"), "deadline")
        execution_date = validate_date(data.get("execution_date"), "execution_date")
        status = validate_status(data.get("status"))
    except ValueError as e:
        return {"error": str(e)}, 400

    parent_id = data.get("parent_id")
    parent = None
    if parent_id is not None:
        parent = get_task(parent_id)
        if parent is None:
            return {"error": "Nodo padre non trovato"}, 404
        if parent["children_count"] == 0 and parent["status"] in BLOCKING_STATUSES:
            return {"error": "Non è possibile creare sotto-attività da questa foglia (status bloccante)"}, 409

    statements = [(
        """
        INSERT INTO tasks (parent_id, title, description, deadline, execution_date, status)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        (parent_id, title, description, deadline, execution_date, status),
    )]

    # una foglia che diventa nodo padre perde lo status e il focus
    if parent is not None and parent["children_count"] == 0:
        statements.append((
            "UPDATE tasks SET status = NULL, focus = 0 WHERE id = ?",
            (parent_id,),
        ))

    execute_transaction(statements)

    return "", 201


@app.route("/tasks/<int:task_id>", methods=["PUT"])
def update_task(task_id):
    task = get_task(task_id)
    if task is None:
        return {"error": "Task non trovato"}, 404

    data = request.get_json() or {}
    fields = {}

    try:
        if "title" in data:
            fields["title"] = validate_title(data["title"])
        if "description" in data:
            fields["description"] = validate_description(data["description"])
        if "deadline" in data:
            fields["deadline"] = validate_date(data["deadline"], "deadline")
        if "execution_date" in data:
            fields["execution_date"] = validate_date(data["execution_date"], "execution_date")
        if "status" in data:
            fields["status"] = validate_status(data["status"])
        if "urgent" in data:
            fields["urgent"] = 1 if data["urgent"] else 0
    except ValueError as e:
        return {"error": str(e)}, 400

    if not fields:
        return {"error": "Nessun campo da aggiornare"}, 400

    if fields.get("status") is not None and task["children_count"] > 0:
        return {"error": "Un nodo con figli non può avere uno status"}, 409

    # alcuni status non sono compatibili con il focus: se il task lo aveva, va spento
    if fields.get("status") in FOCUS_INCOMPATIBLE_STATUSES and task["focus"]:
        fields["focus"] = 0

    set_clause = ", ".join(f"{key} = ?" for key in fields)
    execute_db(
        f"UPDATE tasks SET {set_clause} WHERE id = ?",
        (*fields.values(), task_id),
    )

    return {"status": "ok"}


@app.route("/tasks/<int:task_id>/focus", methods=["PATCH"])
def set_focus(task_id):
    task = get_task(task_id)
    if task is None:
        return {"error": "Task non trovato"}, 404

    data = request.get_json() or {}
    focus = bool(data.get("focus"))

    if focus:
        if task["children_count"] > 0:
            return {"error": "Solo le foglie possono avere il focus"}, 409
        execute_transaction([
            ("UPDATE tasks SET focus = 0 WHERE focus = 1", ()),
            ("UPDATE tasks SET focus = 1 WHERE id = ?", (task_id,)),
        ])
    else:
        execute_db("UPDATE tasks SET focus = 0 WHERE id = ?", (task_id,))

    return {"status": "ok"}


@app.route("/tasks/<int:task_id>", methods=["DELETE"])
def delete_task(task_id):
    # ON DELETE CASCADE elimina automaticamente sotto-albero e note collegate
    execute_db("DELETE FROM tasks WHERE id = ?", (task_id,))
    return {"status": "ok"}


@app.route("/tasks/<int:task_id>/ancestors", methods=["GET"])
def get_ancestors(task_id):
    rows = query_db(
        """
        WITH RECURSIVE ancestors(id, parent_id) AS (
            SELECT id, parent_id FROM tasks WHERE id = ?
            UNION ALL
            SELECT t.id, t.parent_id
            FROM tasks t
            JOIN ancestors a ON t.id = a.parent_id
        )
        SELECT id FROM ancestors
        """,
        [task_id],
    )
    return jsonify([r["id"] for r in rows])


# ---------------------------------------------------------------------------
# Notes API
# ---------------------------------------------------------------------------

@app.route("/notes/<int:task_id>", methods=["GET"])
def get_notes(task_id):
    notes = query_db(
        """
        SELECT id, task_id, note_date, text, updated_at
        FROM notes
        WHERE task_id = ?
        ORDER BY note_date
        """,
        [task_id],
    )
    return jsonify(notes)


@app.route("/notes/<int:task_id>", methods=["POST"])
def add_note(task_id):
    data = request.get_json() or {}
    text = data.get("text")

    if not text or not text.strip():
        return {"error": "Nota vuota"}, 400

    if get_task(task_id) is None:
        return {"error": "Task non trovato"}, 404

    stamped_text = f"[{datetime.now().strftime('%H:%M')}] {text.strip()}"

    execute_db(
        """
        INSERT INTO notes (task_id, note_date, text)
        VALUES (?, date('now', 'localtime'), ?)
        ON CONFLICT(task_id, note_date)
        DO UPDATE SET
            text = notes.text || char(10) || excluded.text,
            updated_at = datetime('now', 'localtime')
        """,
        (task_id, stamped_text),
    )

    return {"status": "ok"}, 201


@app.route("/notes/<int:note_id>", methods=["PUT"])
def update_note(note_id):
    data = request.get_json() or {}
    text = data.get("text")

    if text is None or not text.strip():
        return {"error": "Nota vuota"}, 400

    if query_one("SELECT id FROM notes WHERE id = ?", [note_id]) is None:
        return {"error": "Nota non trovata"}, 404

    execute_db(
        "UPDATE notes SET text = ?, updated_at = datetime('now', 'localtime') WHERE id = ?",
        (text, note_id),
    )
    return {"status": "ok"}


@app.route("/tasks/<int:task_id>/notes-subtree", methods=["GET"])
def get_notes_subtree(task_id):
    rows = query_db(
        """
        WITH RECURSIVE subtree(id) AS (
            SELECT id FROM tasks WHERE id = ?
            UNION ALL
            SELECT t.id FROM tasks t JOIN subtree s ON t.parent_id = s.id
        )
        SELECT n.id, n.task_id, n.note_date, n.text, n.updated_at
        FROM notes n
        JOIN subtree s ON n.task_id = s.id
        ORDER BY n.note_date
        """,
        [task_id],
    )
    return jsonify(rows)


if __name__ == "__main__":
    app.run(debug=True)
