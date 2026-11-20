"""Connettore MCP (Model Context Protocol) per Leaf: permette a Claude Desktop di
interrogare i task di Leaf in SOLA LETTURA.

Gira sul PC di chi lo usa (lanciato da Claude Desktop via claude_desktop_config.json),
parla MCP con Claude su stdin/stdout e chiama l'API HTTP di Leaf sulla rete aziendale
con un token personale. Usa solo la libreria standard di Python: nessun `pip install`.

Configurazione (variabili d'ambiente, impostate nel config di Claude Desktop):
  LEAF_URL    indirizzo di Leaf, es. http://192.168.13.114:8000
  LEAF_TOKEN  token personale (lo emette l'amministratore: manage_users.py create-token)

Vedi GUIDA_CONNETTORE_CLAUDE.md per l'installazione.
"""

import json
import os
import sys
import urllib.error
import urllib.request
from datetime import date

SERVER_NAME = "leaf"
SERVER_VERSION = "1.0.0"
DEFAULT_PROTOCOL_VERSION = "2025-06-18"
HTTP_TIMEOUT_SECONDS = 20

STATUS_NAMES = {
    1: "Attivo", 2: "In ritardo", 3: "Bloccato", 4: "Pianificato", 5: "Dipendente",
    6: "Delegato", 7: "In lista", 8: "Quarantena", 9: "Completato", 10: "Interrotto",
}
STATUS_BY_NAME = {name.lower(): code for code, name in STATUS_NAMES.items()}


class LeafError(Exception):
    """Errore comprensibile da mostrare a Claude (e quindi all'utente)."""


# ---------------------------------------------------------------------------
# Accesso all'API di Leaf
# ---------------------------------------------------------------------------

def leaf_get(path):
    base = os.environ.get("LEAF_URL", "").strip().rstrip("/")
    token = os.environ.get("LEAF_TOKEN", "").strip()
    if not base or not token:
        raise LeafError(
            "Connettore non configurato: mancano LEAF_URL e/o LEAF_TOKEN nella configurazione "
            "di Claude Desktop (vedi la guida)."
        )
    request = urllib.request.Request(
        base + path,
        headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
        method="GET",
    )
    try:
        with urllib.request.urlopen(request, timeout=HTTP_TIMEOUT_SECONDS) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        if e.code == 401:
            raise LeafError("Token non valido o revocato: chiedi un nuovo token all'amministratore di Leaf.")
        if e.code == 404:
            raise LeafError("Elemento non trovato (o non visibile al tuo utente).")
        raise LeafError(f"Leaf ha risposto con errore HTTP {e.code}.")
    except urllib.error.URLError as e:
        raise LeafError(
            f"Impossibile raggiungere Leaf su {base} ({e.reason}). Controlla di essere in rete "
            "aziendale (o VPN) e che il server Leaf sia acceso."
        )


def load_tasks():
    tasks = leaf_get("/tasks")
    return tasks, {t["id"]: t for t in tasks}


# ---------------------------------------------------------------------------
# Formattazione (testo compatto: è ciò che Claude legge)
# ---------------------------------------------------------------------------

def status_name(task):
    if task.get("children_count", 0) > 0:
        return "Ramo"
    if task.get("label") == "CHIUSO" and task.get("status") is None:
        return "Chiuso"
    return STATUS_NAMES.get(task.get("status"), "?")


def breadcrumb(task, tasks_by_id):
    names = []
    parent_id = task.get("parent_id")
    seen = set()
    while parent_id is not None and parent_id in tasks_by_id and parent_id not in seen:
        seen.add(parent_id)
        parent = tasks_by_id[parent_id]
        names.append(parent["title"])
        parent_id = parent.get("parent_id")
    return " > ".join(reversed(names))


def format_days(value):
    if value is None:
        return None
    return f"{value:g} gg"


def task_line(task, tasks_by_id):
    flags = []
    if task.get("expired"):
        flags.append("SCADUTO")
    elif task.get("deadline_approaching"):
        flags.append("scadenza vicina")
    if task.get("urgent"):
        flags.append("urgente")
    if task.get("focus"):
        flags.append("focus")
    if task.get("completion_pending"):
        flags.append("completamento da confermare")
    if task.get("delegation_status") == "in_attesa":
        flags.append("delega in attesa")

    parts = [f"#{task['id']} [{status_name(task)}] {task['title']}"]
    path = breadcrumb(task, tasks_by_id)
    if path:
        parts.append(f"in: {path}")
    code = project_code(task, tasks_by_id)
    if code:
        parts.append(f"progetto {code}")
    dates = []
    if task.get("execution_date"):
        dates.append(f"EX {task['execution_date']}")
    if task.get("deadline"):
        dates.append(f"DL {task['deadline']}")
    if dates:
        parts.append(" ".join(dates))
    if task.get("estimated_days") is not None:
        parts.append(f"stima {format_days(task['estimated_days'])}")
    if task.get("executor_username"):
        parts.append(f"esecutore {task['executor_username']}")
    if task.get("committente_username"):
        parts.append(f"committente {task['committente_username']}")
    if task.get("assegnato"):
        parts.append(f"assegnato a {task['assegnato']}")
    if flags:
        parts.append("(" + ", ".join(flags) + ")")
    return " | ".join(parts)


def project_code(task, tasks_by_id):
    node = task
    seen = set()
    while node is not None and node["id"] not in seen:
        seen.add(node["id"])
        if node.get("project_code"):
            return node["project_code"]
        node = tasks_by_id.get(node.get("parent_id"))
    return task.get("ticket_project_code")


def is_leaf(task):
    return task.get("children_count", 0) == 0


def is_open(task):
    return is_leaf(task) and task.get("label") == "APERTO"


def descendants_ids(root_id, tasks):
    children = {}
    for t in tasks:
        if t.get("parent_id") is not None:
            children.setdefault(t["parent_id"], []).append(t["id"])
    result, stack = set(), [root_id]
    while stack:
        node = stack.pop()
        for child in children.get(node, []):
            if child not in result:
                result.add(child)
                stack.append(child)
    return result


def limit_lines(lines, limit, noun="task"):
    if not lines:
        return f"Nessun {noun} corrisponde ai criteri."
    shown = lines[:limit]
    text = "\n".join(shown)
    if len(lines) > limit:
        text += f"\n… altri {len(lines) - limit} {noun} non mostrati (restringi i filtri o aumenta 'limit')."
    return f"{len(lines)} risultati:\n" + text


# ---------------------------------------------------------------------------
# Tool
# ---------------------------------------------------------------------------

def tool_whoami(_args):
    me = leaf_get("/me")
    role = "superuser" if me.get("is_superuser") else "utente"
    return f"Connesso a Leaf come {me['username']} ({role}). Data odierna: {date.today().isoformat()}."


def tool_list_tasks(args):
    tasks, by_id = load_tasks()
    selected = tasks

    if args.get("project_id") is not None:
        ids = descendants_ids(int(args["project_id"]), tasks) | {int(args["project_id"])}
        selected = [t for t in selected if t["id"] in ids]
    if args.get("project_code"):
        code = args["project_code"].strip().lower()
        selected = [t for t in selected if (project_code(t, by_id) or "").lower() == code]

    only_leaves = args.get("only_leaves", True)
    if only_leaves:
        selected = [t for t in selected if is_leaf(t)]
    if args.get("open_only", True):
        selected = [t for t in selected if t.get("label") == "APERTO" or not is_leaf(t)]
        if only_leaves:
            selected = [t for t in selected if is_open(t)]
    if not args.get("include_hidden", False):
        selected = [t for t in selected if not t.get("hidden_in_foglie")]

    if args.get("status"):
        wanted = args["status"].strip().lower()
        if wanted not in STATUS_BY_NAME:
            raise LeafError("Stato sconosciuto. Valori ammessi: " + ", ".join(STATUS_NAMES.values()) + ".")
        selected = [t for t in selected if t.get("status") == STATUS_BY_NAME[wanted]]
    if args.get("deadline_before"):
        limit_date = args["deadline_before"]
        selected = [t for t in selected if t.get("deadline") and t["deadline"] <= limit_date]
    if args.get("overdue"):
        selected = [t for t in selected if t.get("expired")]
    if args.get("executor"):
        who = args["executor"].strip().lower()
        selected = [t for t in selected if (t.get("executor_username") or "").lower() == who]
    if args.get("text"):
        needle = args["text"].strip().lower()
        selected = [t for t in selected if needle in (t["title"] + " " + (t.get("description") or "")).lower()]

    selected.sort(key=lambda t: (t.get("deadline") or "9999-99-99", t["id"]))
    lines = [task_line(t, by_id) for t in selected]
    return limit_lines(lines, int(args.get("limit", 50)))


def tool_search_tasks(args):
    query = (args.get("query") or "").strip().lower()
    if not query:
        raise LeafError("Indica il testo da cercare in 'query'.")
    tasks, by_id = load_tasks()
    hits = []
    for t in tasks:
        haystack = " ".join([
            t["title"], t.get("description") or "", project_code(t, by_id) or "",
            t.get("assegnato") or "", t.get("executor_username") or "", t.get("owner_username") or "",
        ]).lower()
        if query in haystack:
            hits.append(t)
    hits.sort(key=lambda t: t["id"])
    return limit_lines([task_line(t, by_id) for t in hits], int(args.get("limit", 30)))


def truncate(text, size):
    text = (text or "").strip()
    return text if len(text) <= size else text[:size] + "… [troncata]"


def tool_get_task(args):
    task_id = int(args["task_id"])
    tasks, by_id = load_tasks()
    task = by_id.get(task_id)
    if task is None:
        raise LeafError(f"Task #{task_id} non trovato (o non visibile al tuo utente).")

    out = [task_line(task, by_id)]
    if task.get("description"):
        out.append(f"Descrizione: {task['description']}")
    out.append(f"Proprietario: {task.get('owner_username')}")
    if task.get("dependency_ids"):
        deps = [f"#{d} {by_id[d]['title']}" if d in by_id else f"#{d}" for d in task["dependency_ids"]]
        out.append("Dipende da: " + "; ".join(deps))
    if task.get("branch_closed_status"):
        out.append(f"Ramo chiuso come: {STATUS_NAMES.get(task['branch_closed_status'])}")
    if task.get("carico_lavoro") is not None:
        out.append(f"Carico di lavoro odierno: {task['carico_lavoro']}%")

    children = sorted((t for t in tasks if t.get("parent_id") == task_id), key=lambda t: t["id"])
    if children:
        out.append(f"\nSotto-attività ({len(children)}):")
        out.extend("  " + task_line(c, by_id) for c in children)

    try:
        checklist = leaf_get(f"/tasks/{task_id}/checklist")
    except LeafError:
        checklist = []  # non visibile al committente: nessun errore, semplicemente assente
    if checklist:
        out.append(f"\nChecklist ({sum(1 for c in checklist if c['completed'])}/{len(checklist)} fatte):")
        for item in checklist:
            extra = f" (DL {item['deadline']})" if item.get("deadline") else ""
            out.append(f"  [{'x' if item['completed'] else ' '}] {item['description']}{extra}")

    try:
        notes = leaf_get(f"/notes/{task_id}")
    except LeafError:
        notes = []
    if notes:
        recent = notes[-3:][::-1]
        out.append(f"\nNote (ultime {len(recent)} di {len(notes)}, usa get_notes per tutte):")
        for n in recent:
            out.append(f"  --- {n['note_date']} ---\n{truncate(n['text'], 800)}")
    return "\n".join(out)


def tool_get_task_tree(args):
    tasks, by_id = load_tasks()
    max_depth = max(1, min(int(args.get("max_depth", 3)), 8))
    children = {}
    for t in tasks:
        children.setdefault(t.get("parent_id"), []).append(t)
    for kids in children.values():
        kids.sort(key=lambda t: t["id"])

    if args.get("task_id") is not None:
        root = by_id.get(int(args["task_id"]))
        if root is None:
            raise LeafError("Task non trovato (o non visibile al tuo utente).")
        roots = [root]
    else:
        # radici: nodi senza genitore visibile (comprende le deleghe, che per l'esecutore
        # sono radici nel suo albero)
        roots = [t for t in tasks if t.get("parent_id") is None or t["parent_id"] not in by_id]
        roots.sort(key=lambda t: t["id"])

    lines = []

    def walk(node, depth):
        lines.append("  " * depth + task_line_short(node))
        if depth + 1 >= max_depth:
            hidden = len(children.get(node["id"], []))
            if hidden:
                lines.append("  " * (depth + 1) + f"… {hidden} sotto-attività (aumenta max_depth)")
            return
        for child in children.get(node["id"], []):
            walk(child, depth + 1)

    for r in roots:
        walk(r, 0)
    if len(lines) > 400:
        lines = lines[:400] + ["… albero troncato: indica un task_id o riduci max_depth."]
    return "\n".join(lines) if lines else "Nessun task."


def task_line_short(task):
    bits = [f"#{task['id']} [{status_name(task)}] {task['title']}"]
    if task.get("deadline"):
        bits.append(f"DL {task['deadline']}")
    if task.get("expired"):
        bits.append("SCADUTO")
    if task.get("executor_username"):
        bits.append(f"→ {task['executor_username']}")
    return " | ".join(bits)


def tool_get_notes(args):
    task_id = int(args["task_id"])
    subtree = args.get("subtree", False)
    limit = int(args.get("limit", 10))
    notes = leaf_get(f"/tasks/{task_id}/notes-subtree" if subtree else f"/notes/{task_id}")
    if not notes:
        return "Nessuna nota."
    tasks, by_id = load_tasks()
    notes = sorted(notes, key=lambda n: n["note_date"], reverse=True)
    out = [f"{len(notes)} note (mostro le {min(limit, len(notes))} più recenti):"]
    for n in notes[:limit]:
        title = by_id.get(n["task_id"], {}).get("title", "?")
        out.append(f"\n--- {n['note_date']} · task #{n['task_id']} {title} ---\n{truncate(n['text'], 3000)}")
    return "\n".join(out)


def tool_get_workload(_args):
    users = leaf_get("/workload")
    out = []
    for u in sorted(users, key=lambda u: -u["workload_today"]):
        out.append(f"{u['username']}: carico odierno {u['workload_today']}%, {u['delegated_count']} progetti/deleghe")
        for entry in u["delegated"] + u["own_projects"]:
            out.append(
                f"    {entry['project_code']} {entry['title']} — carico {entry['carico_lavoro']}%, "
                f"avanzamento {entry['avanzamento']}%, DL {entry['deadline'] or '-'}"
                if entry.get("avanzamento") is not None else
                f"    {entry['project_code']} {entry['title']} — carico {entry['carico_lavoro']}%, "
                f"DL {entry['deadline'] or '-'}"
            )
    return "\n".join(out) if out else "Nessun dato di carico di lavoro."


TOOLS = {
    "whoami": {
        "fn": tool_whoami,
        "description": "Dice con quale utente Leaf è connesso il connettore e la data odierna. Utile per verificare la connessione.",
        "schema": {"type": "object", "properties": {}},
    },
    "list_tasks": {
        "fn": tool_list_tasks,
        "description": (
            "Elenca i task di Leaf dell'utente, ordinati per scadenza. Di default solo le foglie aperte (le "
            "attività davvero lavorabili). Filtri opzionali: progetto, stato, scadenza, esecutore, testo. "
            "Stati: Attivo, In ritardo, Bloccato, Pianificato, Dipendente, Delegato, In lista, Quarantena, "
            "Completato, Interrotto. Date in formato AAAA-MM-GG."
        ),
        "schema": {
            "type": "object",
            "properties": {
                "project_id": {"type": "integer", "description": "ID di un nodo: limita a quel sottoalbero."},
                "project_code": {"type": "string", "description": "Codice progetto, es. 123-2026."},
                "status": {"type": "string", "description": "Nome dello stato (solo foglie)."},
                "deadline_before": {"type": "string", "description": "Solo task con scadenza (DL) entro questa data."},
                "overdue": {"type": "boolean", "description": "Solo task scaduti."},
                "executor": {"type": "string", "description": "Username dell'esecutore (task delegati)."},
                "text": {"type": "string", "description": "Testo da cercare in titolo/descrizione."},
                "only_leaves": {"type": "boolean", "description": "Solo foglie (default true). false include anche i rami."},
                "open_only": {"type": "boolean", "description": "Solo aperti (default true). false include i chiusi."},
                "include_hidden": {"type": "boolean", "description": "Includi i rami nascosti perché chiusi (default false)."},
                "limit": {"type": "integer", "description": "Numero massimo di risultati (default 50)."},
            },
        },
    },
    "search_tasks": {
        "fn": tool_search_tasks,
        "description": "Cerca testo in titolo, descrizione, codice progetto, assegnatario, proprietario ed esecutore di tutti i task (anche chiusi e rami).",
        "schema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Testo da cercare."},
                "limit": {"type": "integer", "description": "Numero massimo di risultati (default 30)."},
            },
            "required": ["query"],
        },
    },
    "get_task": {
        "fn": tool_get_task,
        "description": "Dettaglio completo di un task: percorso, date, stato, dipendenze, sotto-attività, checklist e ultime note.",
        "schema": {
            "type": "object",
            "properties": {"task_id": {"type": "integer", "description": "ID del task (il numero dopo # nei risultati)."}},
            "required": ["task_id"],
        },
    },
    "get_task_tree": {
        "fn": tool_get_task_tree,
        "description": "Mostra la struttura ad albero (progetto → sotto-attività). Senza task_id parte da tutte le radici.",
        "schema": {
            "type": "object",
            "properties": {
                "task_id": {"type": "integer", "description": "Nodo da cui partire (opzionale)."},
                "max_depth": {"type": "integer", "description": "Livelli da mostrare (default 3, max 8)."},
            },
        },
    },
    "get_notes": {
        "fn": tool_get_notes,
        "description": "Note datate di un task, dalle più recenti. Con subtree=true include anche le note dei sotto-task.",
        "schema": {
            "type": "object",
            "properties": {
                "task_id": {"type": "integer"},
                "subtree": {"type": "boolean", "description": "Includi le note di tutto il sottoalbero (default false)."},
                "limit": {"type": "integer", "description": "Numero massimo di note (default 10)."},
            },
            "required": ["task_id"],
        },
    },
    "get_workload": {
        "fn": tool_get_workload,
        "description": "Carico di lavoro per utente: progetti/deleghe attive di ciascuno con carico odierno e avanzamento.",
        "schema": {"type": "object", "properties": {}},
    },
}


# ---------------------------------------------------------------------------
# Protocollo MCP su stdio (JSON-RPC 2.0, un messaggio JSON per riga)
# ---------------------------------------------------------------------------

def send(message):
    sys.stdout.write(json.dumps(message, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def reply(request_id, result):
    send({"jsonrpc": "2.0", "id": request_id, "result": result})


def reply_error(request_id, code, message):
    send({"jsonrpc": "2.0", "id": request_id, "error": {"code": code, "message": message}})


def handle(message):
    method = message.get("method")
    request_id = message.get("id")
    params = message.get("params") or {}

    if request_id is None:
        return  # notifica (es. notifications/initialized): nessuna risposta

    if method == "initialize":
        reply(request_id, {
            "protocolVersion": params.get("protocolVersion", DEFAULT_PROTOCOL_VERSION),
            "capabilities": {"tools": {}},
            "serverInfo": {"name": SERVER_NAME, "version": SERVER_VERSION},
        })
    elif method == "ping":
        reply(request_id, {})
    elif method == "tools/list":
        reply(request_id, {"tools": [
            {"name": name, "description": t["description"], "inputSchema": t["schema"]}
            for name, t in TOOLS.items()
        ]})
    elif method == "tools/call":
        name = params.get("name")
        tool = TOOLS.get(name)
        if tool is None:
            reply_error(request_id, -32602, f"Tool sconosciuto: {name}")
            return
        try:
            text = tool["fn"](params.get("arguments") or {})
            reply(request_id, {"content": [{"type": "text", "text": text}]})
        except LeafError as e:
            reply(request_id, {"content": [{"type": "text", "text": str(e)}], "isError": True})
        except (KeyError, TypeError, ValueError) as e:
            reply(request_id, {"content": [{"type": "text", "text": f"Parametri non validi: {e!r}"}], "isError": True})
        except Exception as e:  # mai far cadere il processo per un errore in un tool
            print(f"errore inatteso in {name}: {e!r}", file=sys.stderr)
            reply(request_id, {"content": [{"type": "text", "text": f"Errore interno del connettore: {e!r}"}], "isError": True})
    else:
        reply_error(request_id, -32601, f"Metodo non supportato: {method}")


def main():
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            message = json.loads(line)
        except json.JSONDecodeError:
            continue
        handle(message)


if __name__ == "__main__":
    main()
