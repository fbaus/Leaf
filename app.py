import os
from datetime import date, datetime

from flask import Flask, jsonify, request, render_template, send_file
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


def validate_checklist_description(description):
    if not description or not description.strip():
        raise ValueError("Descrizione mancante")
    if len(description) > 60:
        raise ValueError("Descrizione troppo lunga (max 60 caratteri)")
    return description


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
    return execution_date


def compute_open_status(execution_date, deadline, assegnato, dep_statuses, today):
    """Calcola (status, escalato) per un task APERTO. Nessuna ricorsione: dep_statuses
    sono valori già memorizzati (uno stato 'risolvente' è sempre 9/10, scritto a mano
    su un task CHIUSO, mai un valore da ricalcolare a sua volta).

    Con dipendenze non risolte, queste hanno priorità sull'assegnatario: finché non si
    sbloccano, il task resta DIPENDENTE (o BLOCCATO oltre la deadline) anche se assegnato
    a qualcuno, senza passare per PIANIFICATO/DELEGATO."""
    has_deps = bool(dep_statuses)
    deps_resolved = (
        has_deps
        and any(s == STATUS_COMPLETATO for s in dep_statuses)
        and all(s in (STATUS_COMPLETATO, STATUS_INTERROTTO) for s in dep_statuses)
    )
    effective_dp = has_deps and not deps_resolved

    if execution_date is None:
        return (STATUS_DIPENDENTE if effective_dp else STATUS_IN_LISTA), False

    if effective_dp:
        if assegnato:
            return (STATUS_BLOCCATO if today >= deadline else STATUS_DIPENDENTE), False
        if today < execution_date:
            return STATUS_PIANIFICATO, False
        if today < deadline:
            return STATUS_DIPENDENTE, False
        return STATUS_BLOCCATO, False
    if assegnato:
        return (STATUS_IN_RITARDO if today >= deadline else STATUS_DELEGATO), False
    # task semplice, senza assegnatario né dipendenze attive: appena raggiunta
    # la data di esecuzione diventa ATTIVO ed è questa l'unica transizione
    # segnalata con l'escalation (calendario + riga gialla)
    if today < execution_date:
        return STATUS_PIANIFICATO, False
    return STATUS_ATTIVO, True


def resolve_dependency_status(dep_id, tasks_by_id, children_by_parent, cache):
    """Status 'effettivo' di una dipendenza ai fini della risoluzione: per una foglia è il
    suo status reale; per un ramo si calcola ricorsivamente dai figli (foglie o rami), con
    la stessa regola: risolto (COMPLETATO/INTERROTTO, quarantena esclusa) solo se TUTTI i
    figli sono risolti, COMPLETATO se almeno uno di essi lo è davvero. Nessun controllo
    cicli necessario: si cammina solo lungo parent_id, che è sempre un albero."""
    if dep_id in cache:
        return cache[dep_id]
    task = tasks_by_id[dep_id]
    if task["children_count"] == 0:
        return task["status"]
    child_statuses = [
        resolve_dependency_status(c["id"], tasks_by_id, children_by_parent, cache)
        for c in children_by_parent.get(dep_id, [])
    ]
    resolved_all = bool(child_statuses) and all(s in (STATUS_COMPLETATO, STATUS_INTERROTTO) for s in child_statuses)
    if not resolved_all:
        result = None
    elif any(s == STATUS_COMPLETATO for s in child_statuses):
        result = STATUS_COMPLETATO
    else:
        result = STATUS_INTERROTTO
    cache[dep_id] = result
    return result


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

    ancestor_ids = {
        r["id"] for r in query_db(
            """
            WITH RECURSIVE ancestors(id, parent_id) AS (
                SELECT id, parent_id FROM tasks WHERE id = ?
                UNION ALL
                SELECT t.id, t.parent_id FROM tasks t JOIN ancestors a ON t.id = a.parent_id
            )
            SELECT id FROM ancestors
            """,
            [task_id],
        )
    } - {task_id}
    bad_ancestors = set(dependency_ids) & ancestor_ids
    if bad_ancestors:
        raise ValueError("Non puoi dipendere da un nodo antenato")

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


def get_ancestor_ids(task_id):
    rows = query_db(
        """
        WITH RECURSIVE ancestors(id, parent_id) AS (
            SELECT id, parent_id FROM tasks WHERE id = ?
            UNION ALL
            SELECT t.id, t.parent_id
            FROM tasks t
            JOIN ancestors a ON t.id = a.parent_id
        )
        SELECT id FROM ancestors WHERE id != ?
        """,
        [task_id, task_id],
    )
    return [r["id"] for r in rows]


def cleanup_resolved_dependencies(task_id):
    """Una dipendenza risolta (COMPLETATO/INTERROTTO) deve sparire da sola dalla lista
    dipendenze di chi dipende da lei — sia che si tratti di `task_id` stesso sia di uno
    dei suoi antenati (un ramo può diventare risolto proprio a seguito di questa
    modifica, se `task_id` era l'ultimo discendente non risolto)."""
    ids_to_check = [task_id] + get_ancestor_ids(task_id)

    tasks = query_db(
        """
        SELECT t.id, t.parent_id, t.status,
               (SELECT COUNT(*) FROM tasks c WHERE c.parent_id = t.id) AS children_count
        FROM tasks t
        """
    )
    tasks_by_id = {t["id"]: t for t in tasks}
    children_by_parent = {}
    for t in tasks:
        if t["parent_id"] is not None:
            children_by_parent.setdefault(t["parent_id"], []).append(t)

    cache = {}
    resolved_ids = [
        tid for tid in ids_to_check
        if resolve_dependency_status(tid, tasks_by_id, children_by_parent, cache)
        in (STATUS_COMPLETATO, STATUS_INTERROTTO)
    ]
    if resolved_ids:
        placeholders = ",".join("?" * len(resolved_ids))
        execute_db(
            f"DELETE FROM task_dependencies WHERE depends_on_id IN ({placeholders})",
            resolved_ids,
        )


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


def recompute_rollup_dates(node_id):
    """Le date di un nodo con figli non si impostano più a mano: sono sempre il rollup
    automatico dei figli (la minima data di esecuzione, la massima deadline). Va richiamata
    ogni volta che cambia la composizione dei figli di `node_id` o la data di uno di essi;
    se il valore risultante cambia davvero, si propaga ricorsivamente anche al genitore di
    `node_id` (e così via fino alla radice), così una modifica su una foglia profonda
    rimane sempre coerente con tutti i suoi antenati senza doverli toccare a mano."""
    node = get_task(node_id)
    if node is None or node["children_count"] == 0:
        return

    children = query_db("SELECT execution_date, deadline FROM tasks WHERE parent_id = ?", [node_id])
    exec_dates = [c["execution_date"] for c in children if c["execution_date"]]
    deadlines = [c["deadline"] for c in children if c["deadline"]]
    new_execution_date = min(exec_dates) if exec_dates else None
    new_deadline = max(deadlines) if deadlines else None

    if new_execution_date == node["execution_date"] and new_deadline == node["deadline"]:
        return  # nessun cambiamento: niente da propagare più in alto

    execute_db(
        "UPDATE tasks SET execution_date = ?, deadline = ? WHERE id = ?",
        (new_execution_date, new_deadline, node_id),
    )
    if node["parent_id"] is not None:
        recompute_rollup_dates(node["parent_id"])


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

    tasks_by_id = {t["id"]: t for t in tasks}
    children_by_parent = {}
    for t in tasks:
        if t["parent_id"] is not None:
            children_by_parent.setdefault(t["parent_id"], []).append(t)
    resolution_cache = {}
    today = date.today().isoformat()

    for t in tasks:
        t["dependency_ids"] = deps_by_task.get(t["id"], [])
        t["escalation"] = False
        t["execution_passed"] = False
        if t["label"] == "APERTO":
            t["execution_passed"] = bool(t["execution_date"] and t["execution_date"] < today)
            dep_statuses = [
                resolve_dependency_status(d, tasks_by_id, children_by_parent, resolution_cache)
                for d in t["dependency_ids"] if d in tasks_by_id
            ]
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

    # il nuovo figlio partecipa subito al rollup automatico delle date del padre
    # (sia che il padre fosse già un ramo, sia che l'abbia appena diventato)
    if parent_id is not None:
        recompute_rollup_dates(parent_id)

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
        if task["children_count"] > 0:
            # un nodo con figli non ha label/status (non è né APERTO né CHIUSO) e le sue
            # date non si impostano più a mano: sono sempre il rollup automatico dei figli
            if "execution_date" in fields or "deadline" in fields:
                return {"error": "Le date di un nodo con figli sono calcolate automaticamente dai figli"}, 409
            enforce_open_task_rules(fields, execution_date, deadline, assegnato, final_dependency_ids)
        elif label == "APERTO":
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

    # se le date di una foglia sono appena cambiate, il rollup automatico del padre (e dei
    # suoi antenati) va ricalcolato di conseguenza
    if task["children_count"] == 0 and task["parent_id"] is not None:
        if new_ex != task["execution_date"] or new_dl != task["deadline"]:
            recompute_rollup_dates(task["parent_id"])

    # una dipendenza appena risolta (o un ramo diventato risolto grazie a questa modifica)
    # deve sparire da sola dalle dipendenze di chi la usa
    cleanup_resolved_dependencies(task_id)

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

    old_parent_id = task["parent_id"]
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

    # sia il vecchio sia il nuovo padre perdono/guadagnano un figlio: il rollup delle
    # date va ricalcolato per entrambi (ognuno propaga poi verso i propri antenati)
    if old_parent_id is not None:
        recompute_rollup_dates(old_parent_id)
    if new_parent_id is not None:
        recompute_rollup_dates(new_parent_id)

    return {"status": "ok"}


@app.route("/tasks/<int:task_id>", methods=["DELETE"])
def delete_task(task_id):
    task = get_task(task_id)
    parent_id = task["parent_id"] if task is not None else None

    # ON DELETE CASCADE elimina automaticamente sotto-albero, note e dipendenze collegate
    execute_db("DELETE FROM tasks WHERE id = ?", (task_id,))

    if parent_id is not None:
        parent = get_task(parent_id)
        # un ramo che ha appena perso il suo ultimo figlio torna a essere una foglia: il
        # suo status va ricalcolato, cosa che richiede prima di tutto riavere un label
        # (un ramo non ne ha, essendo stato azzerato quando aveva guadagnato il suo primo
        # figlio) — le altre proprietà (execution_date/deadline se presenti) restano e
        # partecipano subito al ricalcolo automatico dello status in GET /tasks
        if parent is not None and parent["children_count"] == 0 and parent["label"] is None:
            execute_db("UPDATE tasks SET label = 'APERTO' WHERE id = ?", (parent_id,))

        # il figlio eliminato non contribuisce più al rollup delle date del padre (se il
        # padre è tornato foglia, la funzione non fa nulla: le sue date restano quelle
        # dell'ultimo rollup, un punto di partenza ragionevole per una foglia appena tornata)
        recompute_rollup_dates(parent_id)

    return {"status": "ok"}


@app.route("/tasks/<int:task_id>/ancestors", methods=["GET"])
def get_ancestors(task_id):
    return jsonify(get_ancestor_ids(task_id))


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

    stamped_text = f"[{datetime.now().strftime('%d/%m/%Y %H:%M:%S')}] {text.strip()}"

    execute_db(
        """
        INSERT INTO notes (task_id, note_date, text)
        VALUES (?, date('now', 'localtime'), ?)
        ON CONFLICT(task_id, note_date)
        DO UPDATE SET
            text = excluded.text || char(10)||char(10)||char(10)||char(10)||char(10) || notes.text,
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


IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".svg"}


def open_file_in_foreground(path):
    """Apre `path` con l'app predefinita e prova a portarla in primo piano.

    os.startfile() da solo lascia la nuova finestra in background: chi la apre è il
    processo Flask (mai in primo piano), non l'utente con un doppio click, quindi Windows
    nega il primo piano per il suo meccanismo anti "focus stealing". ShellExecuteExW
    restituisce l'handle del processo appena creato, che permette di chiamare
    AllowSetForegroundWindow — il modo corretto/documentato per delegare il permesso di
    andare in primo piano a un processo appena avviato (l'app deve comunque richiederlo da
    sé all'avvio, cosa che la stragrande maggioranza delle app fa in automatico).
    """
    import ctypes
    from ctypes import wintypes

    SEE_MASK_NOCLOSEPROCESS = 0x00000040
    SW_SHOWNORMAL = 1

    class SHELLEXECUTEINFOW(ctypes.Structure):
        _fields_ = [
            ("cbSize", wintypes.DWORD),
            ("fMask", ctypes.c_ulong),
            ("hwnd", wintypes.HWND),
            ("lpVerb", wintypes.LPCWSTR),
            ("lpFile", wintypes.LPCWSTR),
            ("lpParameters", wintypes.LPCWSTR),
            ("lpDirectory", wintypes.LPCWSTR),
            ("nShow", ctypes.c_int),
            ("hInstApp", wintypes.HINSTANCE),
            ("lpIDList", ctypes.c_void_p),
            ("lpClass", wintypes.LPCWSTR),
            ("hKeyClass", wintypes.HKEY),
            ("dwHotKey", wintypes.DWORD),
            ("hIconOrMonitor", wintypes.HANDLE),
            ("hProcess", wintypes.HANDLE),
        ]

    sei = SHELLEXECUTEINFOW()
    sei.cbSize = ctypes.sizeof(sei)
    sei.fMask = SEE_MASK_NOCLOSEPROCESS
    sei.lpVerb = "open"
    sei.lpFile = path
    sei.nShow = SW_SHOWNORMAL

    ok = ctypes.windll.shell32.ShellExecuteExW(ctypes.byref(sei))
    if not ok:
        raise OSError(ctypes.WinError().strerror)

    if sei.hProcess:
        try:
            pid = ctypes.windll.kernel32.GetProcessId(sei.hProcess)
            ctypes.windll.user32.AllowSetForegroundWindow(pid)
        finally:
            ctypes.windll.kernel32.CloseHandle(sei.hProcess)


@app.route("/notes/open-path", methods=["POST"])
def open_note_path():
    data = request.get_json() or {}
    path = data.get("path", "")
    if not path or not os.path.exists(path):
        return {"error": "Percorso non trovato"}, 404
    try:
        open_file_in_foreground(path)
    except OSError as e:
        return {"error": str(e)}, 500
    return {"status": "ok"}


@app.route("/notes/preview", methods=["GET"])
def preview_note_path():
    path = request.args.get("path", "")
    if not path or not os.path.isfile(path):
        return {"error": "File non trovato"}, 404
    if os.path.splitext(path)[1].lower() not in IMAGE_EXTENSIONS:
        return {"error": "Non è un'immagine"}, 400
    return send_file(path)


# ---------------------------------------------------------------------------
# Checklist (righe informali di pianificazione dentro un nodo, senza status:
# diventano task veri solo quando vengono trasformate in nodo figlio)
# ---------------------------------------------------------------------------

@app.route("/tasks/<int:task_id>/checklist", methods=["GET"])
def get_checklist(task_id):
    rows = query_db("SELECT * FROM checklist_items WHERE task_id = ?", [task_id])
    return jsonify(rows)


@app.route("/tasks/<int:task_id>/checklist", methods=["POST"])
def add_checklist_item(task_id):
    task = get_task(task_id)
    if task is None:
        return {"error": "Task non trovato"}, 404
    if task["children_count"] > 0:
        return {"error": "La checklist è disponibile solo sulle foglie"}, 409

    data = request.get_json() or {}
    try:
        description = validate_checklist_description(data.get("description"))
        assegnato = validate_assegnato(data.get("assegnato"))
        execution_date = validate_date(data.get("execution_date"), "Data di esecuzione")
        deadline = validate_date(data.get("deadline"), "Deadline")
        if execution_date and deadline and deadline <= execution_date:
            raise ValueError("La deadline deve essere successiva alla data di esecuzione")
    except ValueError as e:
        return {"error": str(e)}, 400

    new_id = execute_db(
        """
        INSERT INTO checklist_items (task_id, description, assegnato, execution_date, deadline)
        VALUES (?, ?, ?, ?, ?)
        """,
        (task_id, description, assegnato, execution_date, deadline),
    )
    item = query_one("SELECT * FROM checklist_items WHERE id = ?", [new_id])
    return jsonify(item), 201


@app.route("/checklist/<int:item_id>", methods=["PUT"])
def update_checklist_item(item_id):
    item = query_one("SELECT * FROM checklist_items WHERE id = ?", [item_id])
    if item is None:
        return {"error": "Voce non trovata"}, 404

    data = request.get_json() or {}
    fields = {}
    try:
        if "description" in data:
            fields["description"] = validate_checklist_description(data["description"])
        if "assegnato" in data:
            fields["assegnato"] = validate_assegnato(data["assegnato"])
        if "execution_date" in data:
            fields["execution_date"] = validate_date(data["execution_date"], "Data di esecuzione")
        if "deadline" in data:
            fields["deadline"] = validate_date(data["deadline"], "Deadline")
        if "completed" in data:
            fields["completed"] = 1 if data["completed"] else 0

        execution_date = fields.get("execution_date", item["execution_date"])
        deadline = fields.get("deadline", item["deadline"])
        if execution_date and deadline and deadline <= execution_date:
            raise ValueError("La deadline deve essere successiva alla data di esecuzione")
    except ValueError as e:
        return {"error": str(e)}, 400

    if not fields:
        return {"error": "Nessun campo da aggiornare"}, 400

    set_clause = ", ".join(f"{key} = ?" for key in fields)
    execute_db(f"UPDATE checklist_items SET {set_clause} WHERE id = ?", (*fields.values(), item_id))
    return {"status": "ok"}


@app.route("/checklist/<int:item_id>", methods=["DELETE"])
def delete_checklist_item(item_id):
    if query_one("SELECT id FROM checklist_items WHERE id = ?", [item_id]) is None:
        return {"error": "Voce non trovata"}, 404
    execute_db("DELETE FROM checklist_items WHERE id = ?", (item_id,))
    return "", 204


@app.route("/tasks/<int:task_id>/checklist/convert-all", methods=["POST"])
def convert_all_checklist_items(task_id):
    """Trasforma TUTTA la checklist di un task in altrettanti nodi figlio, in un
    colpo solo (mai una trasformazione parziale: coerente con la regola di fondo
    dell'app per cui si lavora solo sulle foglie — se la checklist non basta più,
    l'intera foglia diventa ramo). Ricalca la logica di create_task (inclusa la
    transizione "la foglia diventa ramo") ma è scritta a sé: niente refactor di
    create_task per condividerla, per non rischiare regressioni su un endpoint
    già solido."""
    parent = get_task(task_id)
    if parent is None:
        return {"error": "Task non trovato"}, 404
    if parent["children_count"] == 0 and parent["label"] == "CHIUSO":
        return {"error": "Non è possibile creare sotto-attività da questa foglia (chiusa)"}, 409

    items = query_db("SELECT * FROM checklist_items WHERE task_id = ?", [task_id])
    if not items:
        return {"error": "Nessun elemento da trasformare"}, 400

    statements = []
    try:
        for item in items:
            title = validate_checklist_description(item["description"])
            assegnato = validate_assegnato(item["assegnato"])
            execution_date = item["execution_date"]
            deadline = item["deadline"]

            fields = {}
            if item["completed"]:
                label, status = "CHIUSO", STATUS_COMPLETATO
            else:
                label, status = "APERTO", None
                execution_date = enforce_open_task_rules(fields, execution_date, deadline, assegnato, [])

            statements.append((
                """
                INSERT INTO tasks (parent_id, title, deadline, execution_date, assegnato, label, status)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (task_id, title, deadline, execution_date, assegnato, label, status),
            ))
            statements.append(("DELETE FROM checklist_items WHERE id = ?", (item["id"],)))
    except ValueError as e:
        return {"error": str(e)}, 400

    # una foglia che diventa nodo padre perde status/focus/label e le sue dipendenze
    if parent["children_count"] == 0:
        statements.append((
            "UPDATE tasks SET status = NULL, focus = 0, label = NULL, assegnato = NULL WHERE id = ?",
            (task_id,),
        ))
        statements.append((
            "DELETE FROM task_dependencies WHERE task_id = ? OR depends_on_id = ?",
            (task_id, task_id),
        ))

    execute_transaction(statements)

    # i nuovi figli partecipano subito al rollup automatico delle date del padre
    recompute_rollup_dates(task_id)

    # una voce già completata diventa un figlio subito COMPLETATO: se questo risolve
    # il ramo (o uno dei suoi antenati), va rimosso dalle dipendenze di chi dipende da lui
    cleanup_resolved_dependencies(task_id)

    return {"status": "ok", "converted": len(items)}, 201


if __name__ == "__main__":
    app.run(debug=True)
