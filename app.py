from datetime import date, datetime

from flask import Flask, jsonify, request, render_template
from database import query_db, query_one, execute_db, execute_transaction

app = Flask(__name__)


# status: 1 ATTIVO, 2 IN RITARDO, 3 BLOCCATO, 4 PIANIFICATO, 5 DIPENDENTE,
#         6 DELEGATO, 7 IN LISTA, 8 QUARANTENA, 9 COMPLETATO, 10 INTERROTTO
STATUS_ATTIVO = 1
STATUS_IN_RITARDO = 2
STATUS_BLOCCATO = 3
STATUS_PIANIFICATO = 4
STATUS_DIPENDENTE = 5
STATUS_DELEGATO = 6
STATUS_IN_LISTA = 7
STATUS_QUARANTENA = 8
STATUS_COMPLETATO = 9
STATUS_INTERROTTO = 10

CLOSED_STATUSES = {STATUS_QUARANTENA, STATUS_COMPLETATO, STATUS_INTERROTTO}

# expired non può essere una colonna GENERATED in SQLite perché date('now')
# e' considerata non-deterministica: va calcolata in ogni query.
# Ha senso solo per i task APERTI (i CHIUSI sono terminati).
EXPIRED_SQL = """
       CASE WHEN t.deadline IS NOT NULL
                 AND date('now', 'localtime') >= t.deadline
                 AND t.label = 'APERTO'
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


def validate_status(value):
    if value is None:
        return None
    if not isinstance(value, int) or value < 1 or value > 10:
        raise ValueError(f"Status non valido: {value}")
    return value


def validate_assegnato(value):
    if value is None or value == "":
        return None
    if len(value) > 20:
        raise ValueError("Assegnato troppo lungo (max 20 caratteri)")
    return value


def validate_label(value):
    if value is None:
        return None
    if value not in ("APERTO", "CHIUSO"):
        raise ValueError(f"Label non valida: {value}")
    return value


def enforce_open_task_rules(fields, execution_date, deadline, assegnato, dependency_ids):
    """Regole 1-5 per un task APERTO. Ritorna execution_date (eventualmente auto-riempita)."""
    if execution_date is not None and deadline is None:
        raise ValueError("Impostando la data di esecuzione è necessario impostare anche la deadline")
    if deadline is not None and execution_date is None:
        execution_date = date.today().isoformat()
        fields["execution_date"] = execution_date
    if execution_date is not None and deadline is not None and deadline <= execution_date:
        raise ValueError("La deadline deve essere successiva alla data di esecuzione")
    if assegnato and (execution_date is None or deadline is None):
        raise ValueError("Per assegnare il task servono prima data di esecuzione e deadline")
    if assegnato and dependency_ids:
        raise ValueError("Un task non può avere sia un assegnatario sia delle dipendenze")
    return execution_date


def compute_open_status(execution_date, deadline, assegnato, dep_statuses, today):
    """Calcola (status, escalato) per un task APERTO. Nessuna ricorsione: dep_statuses
    sono valori già memorizzati (uno stato 'risolvente' è sempre 9/10, scritto a mano
    su un task CHIUSO, mai un valore da ricalcolare a sua volta)."""
    has_deps = bool(dep_statuses)
    deps_resolved = (
        has_deps
        and any(s == STATUS_COMPLETATO for s in dep_statuses)
        and all(s in (STATUS_COMPLETATO, STATUS_INTERROTTO) for s in dep_statuses)
    )
    effective_dp = has_deps and not deps_resolved

    if execution_date is None:
        return (STATUS_DIPENDENTE if effective_dp else STATUS_IN_LISTA), False

    if assegnato:
        return (STATUS_IN_RITARDO if today >= deadline else STATUS_DELEGATO), False
    if effective_dp:
        if today < execution_date:
            return STATUS_PIANIFICATO, False
        if today < deadline:
            return STATUS_DIPENDENTE, False
        return STATUS_BLOCCATO, False
    # task semplice, senza assegnatario né dipendenze attive: appena raggiunta
    # la data di esecuzione diventa ATTIVO ed è questa l'unica transizione
    # segnalata con l'escalation (calendario + riga gialla)
    if today < execution_date:
        return STATUS_PIANIFICATO, False
    return STATUS_ATTIVO, True


def has_cycle_from(start_id, graph):
    visiting, visited = set(), set()

    def dfs(node):
        if node in visiting:
            return True
        if node in visited:
            return False
        visiting.add(node)
        for nxt in graph.get(node, ()):
            if dfs(nxt):
                return True
        visiting.discard(node)
        visited.add(node)
        return False

    return dfs(start_id)


def validate_dependencies(task_id, dependency_ids):
    """Verifica che i target esistano e che l'insieme di dipendenze non crei un ciclo
    (anche indiretto). `task_id` è None per un task appena creato (nessun ciclo possibile)."""
    if not dependency_ids:
        return
    if task_id is not None and task_id in dependency_ids:
        raise ValueError("Un task non può dipendere da se stesso")

    existing_ids = {
        r["id"] for r in query_db(
            f"SELECT id FROM tasks WHERE id IN ({','.join('?' * len(dependency_ids))})",
            dependency_ids,
        )
    }
    missing = set(dependency_ids) - existing_ids
    if missing:
        raise ValueError(f"Dipendenza inesistente: {', '.join(map(str, missing))}")

    if task_id is None:
        return  # nodo nuovo: non può ancora far parte di un ciclo

    rows = query_db("SELECT task_id, depends_on_id FROM task_dependencies WHERE task_id != ?", [task_id])
    graph = {}
    for r in rows:
        graph.setdefault(r["task_id"], []).append(r["depends_on_id"])
    graph[task_id] = list(dependency_ids)

    if has_cycle_from(task_id, graph):
        raise ValueError("Questa dipendenza creerebbe un ciclo (anche indiretto)")


def replace_dependencies_statements(task_id, dependency_ids):
    statements = [("DELETE FROM task_dependencies WHERE task_id = ?", (task_id,))]
    for dep_id in dependency_ids:
        statements.append((
            "INSERT INTO task_dependencies (task_id, depends_on_id) VALUES (?, ?)",
            (task_id, dep_id),
        ))
    return statements


def get_dependency_ids(task_id):
    rows = query_db("SELECT depends_on_id FROM task_dependencies WHERE task_id = ?", [task_id])
    return [r["depends_on_id"] for r in rows]


def get_task(task_id):
    return query_one(
        f"""
        SELECT t.*,
               (SELECT COUNT(*) FROM tasks c WHERE c.parent_id = t.id) AS children_count,
               {EXPIRED_SQL}
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
               {EXPIRED_SQL}
        FROM tasks t
        ORDER BY t.id
        """
    )

    deps_by_task = {}
    for r in query_db("SELECT task_id, depends_on_id FROM task_dependencies"):
        deps_by_task.setdefault(r["task_id"], []).append(r["depends_on_id"])

    status_by_id = {t["id"]: t["status"] for t in tasks}
    today = date.today().isoformat()

    for t in tasks:
        t["dependency_ids"] = deps_by_task.get(t["id"], [])
        t["escalation"] = False
        if t["label"] == "APERTO":
            dep_statuses = [status_by_id[d] for d in t["dependency_ids"] if d in status_by_id]
            computed_status, escalated = compute_open_status(
                t["execution_date"], t["deadline"], t["assegnato"], dep_statuses, today
            )
            t["status"] = computed_status
            t["escalation"] = escalated and not t["escalation_seen"]

    return jsonify(tasks)


@app.route("/tasks", methods=["POST"])
def create_task():
    data = request.get_json() or {}

    try:
        title = validate_title(data.get("title"))
        description = validate_description(data.get("description"))
        deadline = validate_date(data.get("deadline"), "deadline")
        execution_date = validate_date(data.get("execution_date"), "execution_date")
        assegnato = validate_assegnato(data.get("assegnato"))
        label = validate_label(data.get("label")) or "APERTO"
        status = validate_status(data.get("status"))
        dependency_ids = [int(x) for x in data.get("dependency_ids") or []]

        fields = {}
        if label == "APERTO":
            execution_date = enforce_open_task_rules(fields, execution_date, deadline, assegnato, dependency_ids)
            status = None
        else:
            if status not in CLOSED_STATUSES:
                raise ValueError("Un task chiuso richiede status QUARANTENA, COMPLETATO o INTERROTTO")
            dependency_ids = []

        validate_dependencies(None, dependency_ids)
    except ValueError as e:
        return {"error": str(e)}, 400

    parent_id = data.get("parent_id")
    parent = None
    if parent_id is not None:
        parent = get_task(parent_id)
        if parent is None:
            return {"error": "Nodo padre non trovato"}, 404
        if parent["children_count"] == 0 and parent["label"] == "CHIUSO":
            return {"error": "Non è possibile creare sotto-attività da questa foglia (chiusa)"}, 409

    new_id = execute_db(
        """
        INSERT INTO tasks (parent_id, title, description, deadline, execution_date,
                            assegnato, label, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (parent_id, title, description, deadline, execution_date, assegnato, label, status),
    )

    statements = []
    # una foglia che diventa nodo padre perde status/focus/label e le sue dipendenze
    if parent is not None and parent["children_count"] == 0:
        statements.append((
            "UPDATE tasks SET status = NULL, focus = 0, label = NULL, assegnato = NULL WHERE id = ?",
            (parent_id,),
        ))
        statements.append((
            "DELETE FROM task_dependencies WHERE task_id = ? OR depends_on_id = ?",
            (parent_id, parent_id),
        ))
    if dependency_ids:
        statements.extend(replace_dependencies_statements(new_id, dependency_ids))

    if statements:
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
        if "assegnato" in data:
            fields["assegnato"] = validate_assegnato(data["assegnato"])
        if "label" in data:
            fields["label"] = validate_label(data["label"])
        if "status" in data:
            fields["status"] = validate_status(data["status"])
        if "urgent" in data:
            fields["urgent"] = 1 if data["urgent"] else 0
    except ValueError as e:
        return {"error": str(e)}, 400

    dependency_ids = data.get("dependency_ids")
    if dependency_ids is not None:
        dependency_ids = [int(x) for x in dependency_ids]

    if not fields and dependency_ids is None:
        return {"error": "Nessun campo da aggiornare"}, 400

    label = fields.get("label", task["label"])
    if (fields.get("label") is not None or fields.get("status") is not None) and task["children_count"] > 0:
        return {"error": "Un nodo con figli non può avere status/label"}, 409

    execution_date = fields.get("execution_date", task["execution_date"])
    deadline = fields.get("deadline", task["deadline"])
    assegnato = fields.get("assegnato", task["assegnato"])
    final_dependency_ids = dependency_ids if dependency_ids is not None else get_dependency_ids(task_id)

    try:
        if label == "APERTO":
            if "status" in fields:
                return {"error": "Lo status di un task APERTO è calcolato automaticamente"}, 409
            execution_date = enforce_open_task_rules(fields, execution_date, deadline, assegnato, final_dependency_ids)
            fields["status"] = None
        else:
            final_status = fields.get("status", task["status"])
            if final_status not in CLOSED_STATUSES:
                return {"error": "Un task chiuso richiede status QUARANTENA, COMPLETATO o INTERROTTO"}, 400
            fields["status"] = final_status
            if dependency_ids:
                return {"error": "Un task chiuso non può avere dipendenze"}, 409
            final_dependency_ids = []

        if dependency_ids is not None:
            validate_dependencies(task_id, dependency_ids)
    except ValueError as e:
        return {"error": str(e)}, 400

    # il salvataggio dalla finestra di configurazione spegne il badge di escalation;
    # se però le date che lo determinano cambiano davvero, si riarma (potrebbe
    # ripresentarsi con un significato nuovo) invece di restare spento per sempre
    new_ex = fields.get("execution_date", task["execution_date"])
    new_dl = fields.get("deadline", task["deadline"])
    if new_ex != task["execution_date"] or new_dl != task["deadline"]:
        fields["escalation_seen"] = 0
    else:
        fields["escalation_seen"] = 1

    statements = []
    if fields:
        set_clause = ", ".join(f"{key} = ?" for key in fields)
        statements.append((f"UPDATE tasks SET {set_clause} WHERE id = ?", (*fields.values(), task_id)))
    if dependency_ids is not None:
        statements.extend(replace_dependencies_statements(task_id, dependency_ids))

    execute_transaction(statements)

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
        if task["label"] == "CHIUSO":
            return {"error": "Un task chiuso non può avere il focus"}, 409
        execute_transaction([
            ("UPDATE tasks SET focus = 0 WHERE focus = 1", ()),
            ("UPDATE tasks SET focus = 1 WHERE id = ?", (task_id,)),
        ])
    else:
        execute_db("UPDATE tasks SET focus = 0 WHERE id = ?", (task_id,))

    return {"status": "ok"}


@app.route("/tasks/<int:task_id>/parent", methods=["PATCH"])
def move_task(task_id):
    task = get_task(task_id)
    if task is None:
        return {"error": "Task non trovato"}, 404

    data = request.get_json() or {}
    new_parent_id = data.get("parent_id")

    new_parent = None
    if new_parent_id is not None:
        new_parent = get_task(new_parent_id)
        if new_parent is None:
            return {"error": "Nodo padre non trovato"}, 404
        if new_parent["children_count"] == 0 and new_parent["label"] == "CHIUSO":
            return {"error": "Non è possibile spostare un nodo sotto questa foglia (chiusa)"}, 409

        # il nuovo padre non può essere il nodo stesso né un suo discendente (ciclo)
        subtree_ids = {r["id"] for r in query_db(
            """
            WITH RECURSIVE subtree(id) AS (
                SELECT id FROM tasks WHERE id = ?
                UNION ALL
                SELECT t.id FROM tasks t JOIN subtree s ON t.parent_id = s.id
            )
            SELECT id FROM subtree
            """,
            [task_id],
        )}
        if new_parent_id in subtree_ids:
            return {"error": "Non puoi spostare un nodo dentro se stesso o un suo discendente"}, 409

    if task["parent_id"] == new_parent_id:
        return {"status": "ok"}

    statements = [("UPDATE tasks SET parent_id = ? WHERE id = ?", (new_parent_id, task_id))]

    # se il nuovo padre era una foglia, diventa un ramo: stessa transizione già
    # usata in create_task quando una foglia guadagna il primo figlio
    if new_parent is not None and new_parent["children_count"] == 0:
        statements.append((
            "UPDATE tasks SET status = NULL, focus = 0, label = NULL, assegnato = NULL WHERE id = ?",
            (new_parent_id,),
        ))
        statements.append((
            "DELETE FROM task_dependencies WHERE task_id = ? OR depends_on_id = ?",
            (new_parent_id, new_parent_id),
        ))

    execute_transaction(statements)
    return {"status": "ok"}


@app.route("/tasks/<int:task_id>", methods=["DELETE"])
def delete_task(task_id):
    # ON DELETE CASCADE elimina automaticamente sotto-albero, note e dipendenze collegate
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
