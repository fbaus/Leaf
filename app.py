import mimetypes
import os
import re
from datetime import date, datetime, timedelta

from flask import Flask, jsonify, request, render_template, send_file, session
from werkzeug.security import check_password_hash
from config import load_secret_key
from database import query_db, query_one, execute_db, execute_transaction

# Su alcune installazioni Windows il registro di sistema associa .js/.css a un
# Content-Type sbagliato (es. text/plain): i browser rifiutano di eseguire
# <script type="module"> se il server non risponde con un mimetype JS corretto.
# Flask/Werkzeug leggono il tipo tramite mimetypes.guess_type, che si basa sul
# registro di Windows — queste righe forzano l'associazione corretta a prescindere
# da come è configurata la macchina che serve l'app.
mimetypes.add_type("application/javascript", ".js")
mimetypes.add_type("text/css", ".css")

app = Flask(__name__)
app.secret_key = load_secret_key()
app.permanent_session_lifetime = timedelta(days=30)


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

DELEGATION_IN_ATTESA = "in_attesa"
DELEGATION_ACCETTATA = "accettata"
DELEGATION_NOTICE_POSTICIPATA = "posticipata"
DELEGATION_NOTICE_ANTICIPATA = "anticipata"
DELEGATION_NOTICE_ACCETTATA = "accettata"

# Vista "Carico di lavoro" (Fase 5): parametro medio unico per tutti gli utenti — non ancora
# personalizzabile per esecutore, vedi CLAUDE.md/discussione di progetto per i piani futuri.
CAPACITA_PRODUTTIVA_MEDIA = 0.6
# pavimento minimo per il tempo disponibile (in giorni lavorativi equivalenti): senza di
# questo, EX == DL in un giorno di weekend produrrebbe 0 giorni lavorativi disponibili e
# quindi una divisione per zero — 1 ora è un compromesso che tiene il numero finito e
# comunque molto alto, senza dover gestire un caso speciale "non calcolabile"
TEMPO_DISPONIBILE_MINIMO_GIORNI = 1 / 24

# expired non può essere una colonna GENERATED in SQLite perché date('now')
# e' considerata non-deterministica: va calcolata in ogni query.
# Ha senso solo per i task APERTI (i CHIUSI sono terminati).
EXPIRED_SQL = """
       CASE WHEN t.deadline IS NOT NULL
                 AND date('now', 'localtime') >= t.deadline
                 AND t.label = 'APERTO'
            THEN 1 ELSE 0 END AS expired
"""

# preavviso: 7 giorni prima della deadline, stesso ambito di validità di EXPIRED_SQL (solo
# APERTI). Non esclude l'intervallo già scaduto (Data >= DL): il frontend dà priorità al
# badge di scadenza vera e propria quando entrambi risulterebbero veri.
DEADLINE_APPROACHING_SQL = """
       CASE WHEN t.deadline IS NOT NULL
                 AND date('now', 'localtime') >= date(t.deadline, '-7 days')
                 AND t.label = 'APERTO'
            THEN 1 ELSE 0 END AS deadline_approaching
"""


@app.route("/")
def index():
    return render_template("index.html")


# ---------------------------------------------------------------------------
# Autenticazione: sessione a cookie firmato (flask.session), nessun token. Ogni
# route (tranne login/logout/index/static) richiede una sessione valida; la
# visibilità dei task si ferma a "solo quelli creati dall'utente corrente" —
# niente delega/superuser ancora (arrivano in fasi successive).
# ---------------------------------------------------------------------------

PUBLIC_ENDPOINTS = {"index", "login", "logout", "static"}


@app.before_request
def require_login():
    if request.endpoint is None or request.endpoint in PUBLIC_ENDPOINTS:
        return None
    if "user_id" not in session:
        return {"error": "Non autenticato"}, 401


def current_user_id():
    return session["user_id"]


def current_username():
    row = query_one("SELECT username FROM users WHERE id = ?", [current_user_id()])
    return row["username"] if row else "?"


def require_owned_task(task_id):
    """Come get_task, ma torna None sia se il task non esiste sia se esiste ma è di
    un altro utente — le due situazioni devono produrre la stessa risposta (404) per
    non rivelare l'esistenza di nodi altrui."""
    task = get_task(task_id)
    if task is None or task["owner_id"] != current_user_id():
        return None
    return task


def get_owned_note(note_id):
    return query_one(
        """
        SELECT n.* FROM notes n JOIN tasks t ON t.id = n.task_id
        WHERE n.id = ? AND t.owner_id = ?
        """,
        [note_id, current_user_id()],
    )


def get_owned_checklist_item(item_id):
    return query_one(
        """
        SELECT c.* FROM checklist_items c JOIN tasks t ON t.id = c.task_id
        WHERE c.id = ? AND t.owner_id = ?
        """,
        [item_id, current_user_id()],
    )


def get_owned_planning_block(block_id):
    return query_one(
        """
        SELECT pb.* FROM planning_blocks pb JOIN tasks t ON t.id = pb.task_id
        WHERE pb.id = ? AND t.owner_id = ?
        """,
        [block_id, current_user_id()],
    )


def require_visible_task(task_id):
    """Come require_owned_task, ma include anche il committente di un task delegato
    (sola lettura + Note): usata solo dove la visibilità del committente deve estendersi
    oltre il filtro owner-only standard."""
    task = get_task(task_id)
    if task is None or (task["owner_id"] != current_user_id() and task["committente_user_id"] != current_user_id()):
        return None
    return task


def require_movable_task(task_id):
    """Chi può riposizionare un nodo nell'albero (PATCH .../parent). Un task NON delegato
    segue la regola normale (solo l'owner). Un task delegato internamente ANCORATO nell'albero
    del committente (il suo genitore attuale appartiene a lui) può essere spostato SOLO dal
    committente, mai dall'esecutore: l'esecutore lo vede comunque come una radice nel proprio
    albero (il vero padre, del committente, non gli è visibile), quindi spostarlo fra i propri
    rami lo scollegherebbe dalla struttura/progetto del committente senza alcun beneficio — e
    potrebbe fargli perdere in silenzio un codice progetto ereditato dal ramo originale.

    Un "ticket" (delegato ma senza un genitore che appartiene al committente — o non l'ha mai
    avuto, creato senza casa nell'albero, o l'esecutore l'ha già incorporato altrove) non ha
    invece nessuna struttura del committente da proteggere: è l'esecutore a poterlo spostare
    liberamente nel proprio albero, esattamente come farebbe con un proprio nodo."""
    task = get_task(task_id)
    if task is None:
        return None
    if task["committente_user_id"] is not None:
        parent_owner_id = None
        if task["parent_id"] is not None:
            parent = query_one("SELECT owner_id FROM tasks WHERE id = ?", [task["parent_id"]])
            parent_owner_id = parent["owner_id"] if parent else None
        if parent_owner_id != task["committente_user_id"]:
            return task if task["executor_user_id"] == current_user_id() else None
        return task if task["committente_user_id"] == current_user_id() else None
    return task if task["owner_id"] == current_user_id() else None


def get_visible_note(note_id):
    return query_one(
        """
        SELECT n.* FROM notes n JOIN tasks t ON t.id = n.task_id
        WHERE n.id = ? AND (t.owner_id = ? OR t.committente_user_id = ?)
        """,
        [note_id, current_user_id(), current_user_id()],
    )


@app.route("/login", methods=["POST"])
def login():
    data = request.get_json() or {}
    username = data.get("username")
    password = data.get("password")
    user = query_one("SELECT * FROM users WHERE username = ?", [username]) if username else None
    if user is None or not check_password_hash(user["password_hash"], password or ""):
        # stesso messaggio per utente inesistente o password errata: non si rivela quale dei due
        return {"error": "Credenziali non valide"}, 401
    session.clear()
    session["user_id"] = user["id"]
    session.permanent = True
    return {
        "id": user["id"],
        "username": user["username"],
        "is_superuser": bool(user["is_superuser"]),
        "can_set_project_code": bool(user["can_set_project_code"]),
    }


@app.route("/logout", methods=["POST"])
def logout():
    session.clear()
    return {"status": "ok"}


@app.route("/me", methods=["GET"])
def me():
    user = query_one(
        "SELECT id, username, is_superuser, can_set_project_code FROM users WHERE id = ?", [current_user_id()]
    )
    return {
        "id": user["id"],
        "username": user["username"],
        "is_superuser": bool(user["is_superuser"]),
        "can_set_project_code": bool(user["can_set_project_code"]),
    }


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


def validate_minutes(value, field_name):
    if not isinstance(value, int) or isinstance(value, bool):
        raise ValueError(f"{field_name} deve essere un numero di minuti")
    if value < 0 or value > 1440:
        raise ValueError(f"{field_name} deve essere fra 0 e 1440")
    return value


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


def validate_estimated_days(value):
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError("Tempo stimato deve essere un numero")
    if value <= 0:
        raise ValueError("Tempo stimato deve essere maggiore di zero")
    return round(value, 1)


PROJECT_CODE_RE = re.compile(r"^\d{3}-20\d{2}$")


def validate_project_code(value):
    if value is None or value == "":
        return None
    if not isinstance(value, str) or not PROJECT_CODE_RE.match(value):
        raise ValueError("Codice progetto non valido: formato richiesto XXX-20AA, solo numeri")
    return value


def current_user_can_set_project_code():
    user = query_one("SELECT can_set_project_code FROM users WHERE id = ?", [current_user_id()])
    return bool(user and user["can_set_project_code"])


def current_user_is_superuser():
    user = query_one("SELECT is_superuser FROM users WHERE id = ?", [current_user_id()])
    return bool(user and user["is_superuser"])


def find_project_code_owner_username(project_code, exclude_task_id=None):
    """Unica query che attraversa deliberatamente i confini di owner_id: la segnalazione
    "codice già usato da [utente]" richiede di vedere chi, fra TUTTI gli utenti, ha già
    quel codice — è l'eccezione esplicitamente voluta dalla specifica, non una dimenticanza
    del filtro per-owner applicato ovunque altrove."""
    query = "SELECT u.username FROM tasks t JOIN users u ON u.id = t.owner_id WHERE t.project_code = ?"
    args = [project_code]
    if exclude_task_id is not None:
        query += " AND t.id != ?"
        args.append(exclude_task_id)
    row = query_one(query, args)
    return row["username"] if row else None


def resolve_root_project_code_unscoped(task_id, chain_by_id):
    """Risale parent_id ignorando deliberatamente ownership/visibilità, fino alla radice,
    e ne restituisce il project_code. Serve al committente di un ticket per vedere il
    codice progetto anche dopo che l'esecutore lo ha incorporato in profondità nel proprio
    albero — una parte di struttura che al committente non è altrimenti mai visibile."""
    seen = set()
    current_id = task_id
    while current_id not in seen:
        seen.add(current_id)
        row = chain_by_id.get(current_id)
        if row is None:
            return None
        if row["parent_id"] is None:
            return row["project_code"]
        current_id = row["parent_id"]
    return None


def enforce_open_task_rules(fields, execution_date, deadline, assegnato, dependency_ids):
    """Regole 1-5 per un task APERTO. Ritorna execution_date (eventualmente auto-riempita)."""
    if execution_date is not None and deadline is None:
        raise ValueError("Impostando la data di esecuzione è necessario impostare anche la deadline")
    if deadline is not None and execution_date is None:
        execution_date = date.today().isoformat()
        fields["execution_date"] = execution_date
    if execution_date is not None and deadline is not None and deadline < execution_date:
        raise ValueError("La deadline non può essere precedente alla data di esecuzione")
    if assegnato and (execution_date is None or deadline is None):
        raise ValueError("Per assegnare il task servono prima data di esecuzione e deadline")
    return execution_date


def _compute_open_status_base(execution_date, deadline, assegnato, dep_statuses, today):
    """Calcola (status, escalato) per un task APERTO. Nessuna ricorsione: dep_statuses
    sono valori già memorizzati (uno stato 'risolvente' è sempre 9/10, scritto a mano
    su un task CHIUSO, mai un valore da ricalcolare a sua volta).

    L'assegnatario ha priorità sulle dipendenze non risolte: un task assegnato segue
    sempre il binario DELEGATO/IN RITARDO in base alla sola deadline (come se non avesse
    dipendenze), anche con dipendenze ancora aperte — CH5 e CH6 della tabella dei casi
    producono lo stesso status."""
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


def compute_open_status(execution_date, deadline, assegnato, dep_statuses, today, is_delegated_internally=False):
    """Wrapper su _compute_open_status_base: per un task delegato internamente (owner
    corrente = esecutore) la progressione di stato resta quella normale, ma una volta
    superata la deadline lo stato passa comunque a IN RITARDO — a differenza della delega
    esterna (`assegnato`), che segue invece il binario DELEGATO/IN RITARDO invariato.

    L'escalation (badge 📅 + riga gialla) non scatta mai per un task delegato, esattamente
    come già non scatta per la delega esterna (il ramo `assegnato` di _compute_open_status_base
    restituisce sempre escalated=False): senza questa esclusione, un task delegato
    internamente che raggiunge la sua data di esecuzione veniva trattato come un task
    "semplice" appena diventato ATTIVO — ma `assegnato` è sempre NULL per la delega interna,
    quindi il ramo `if assegnato` della funzione base non lo intercetta mai da solo. Il badge
    risultante restava perennemente acceso per il committente, che non ha alcun modo di
    "salvare" il task (form in sola lettura) per spegnere escalation_seen come farebbe
    normalmente il proprietario."""
    status, escalated = _compute_open_status_base(execution_date, deadline, assegnato, dep_statuses, today)
    if is_delegated_internally:
        escalated = False
        if deadline is not None and today >= deadline and status != STATUS_IN_RITARDO:
            status = STATUS_IN_RITARDO
    return status, escalated


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


def compute_estimated_days_rollup(node_id, tasks_by_id, children_by_parent, cache, exclude_in_lista=False):
    """Tempo stimato 'effettivo' di un nodo: per una foglia è il suo valore proprio, ma solo
    se è attiva (label APERTO — una foglia CHIUSA è esclusa dal calcolo di qualsiasi
    antenato, anche se il suo valore resta salvato e visibile su se stessa); per un ramo è
    la somma ricorsiva del tempo stimato dei figli attivi (foglie APERTE o altri rami — un
    ramo non ha mai una label propria, quindi conta sempre come "attivo" ai fini di questo
    calcolo). Una foglia delegata (esterna via `assegnato`, o interna via
    `executor_user_id`) è esclusa dal calcolo esattamente come una foglia CHIUSA: il tempo
    stimato passa sotto la responsabilità dell'esecutore, non è più "nostro" da sommare.

    `exclude_in_lista=True` (usato solo dalla Vista Carico di lavoro, non dal "Tempo stimato"
    generico mostrato su un ramo in Albero/Foglie) esclude anche le foglie in stato IN LISTA
    (nessuna data di esecuzione ancora impostata): un task non ancora pianificato non deve
    gonfiare il carico di lavoro *odierno*, anche se ha già una stima. Richiede che
    `t["status"]` sia già stato calcolato sulle righe (vedi il loop status prima del rollup).

    Se anche un solo figlio attivo (foglia aperta o ramo) non ha un valore determinato —
    foglia senza stima, o ramo il cui calcolo è a sua volta indeterminato — l'intero nodo
    risulta indeterminato: niente somma parziale che ignora i "buchi", l'intera stima sale
    come "---" fino a dove serve. Se invece un ramo non ha NESSUN figlio attivo (tutti i
    suoi figli sono foglie chiuse, delegate o in lista — un ramo figlio non è mai escluso da
    questo filtro, quindi è l'unico modo in cui active_children può risultare vuoto), il suo
    lavoro residuo è 0, non indeterminato: altrimenti un singolo sotto-ramo già interamente
    concluso in un angolo del progetto azzererebbe a "—" la stima dell'intero progetto, anche
    con tutte le foglie ancora aperte regolarmente stimate."""
    if node_id in cache:
        return cache[node_id]
    task = tasks_by_id[node_id]
    if task["children_count"] == 0:
        result = task["estimated_days"] if task["label"] == "APERTO" else None
        cache[node_id] = result
        return result

    active_children = [
        c for c in children_by_parent.get(node_id, [])
        if not (
            c["children_count"] == 0
            and (
                c["label"] != "APERTO"
                or c["assegnato"]
                or c["executor_user_id"]
                or (exclude_in_lista and c.get("status") == STATUS_IN_LISTA)
            )
        )
    ]
    if not active_children:
        result = 0.0
    else:
        total = 0.0
        for child in active_children:
            child_value = compute_estimated_days_rollup(child["id"], tasks_by_id, children_by_parent, cache, exclude_in_lista)
            if child_value is None:
                result = None
                break
            total += child_value
        else:
            result = round(total, 1)
    cache[node_id] = result
    return result


def compute_estimated_days_rollup_unscoped(node_id):
    """Stessa identica logica di compute_estimated_days_rollup, ma cammina nel database
    reale invece che nella sola porzione di albero visibile al viewer corrente (interroga il
    db a ogni livello invece di usare children_by_parent). Serve per il rollup di un ramo
    delegato internamente che il committente vede: l'esecutore può trasformarlo in un ramo
    con propri figli, ma quei figli non compaiono mai in GET /tasks per il committente (sono
    di un altro owner), quindi children_by_parent per lui sarebbe sempre vuoto e il rollup
    "in memoria" darebbe sempre '—' anche quando l'esecutore ha regolarmente stimato i suoi
    figli. Usata solo per questi nodi di confine (pochi per richiesta), non nel percorso
    normale — il costo di query ripetute qui non è un problema a questa scala."""
    row = query_one(
        """
        SELECT id, label, estimated_days, assegnato, executor_user_id,
               (SELECT COUNT(*) FROM tasks c WHERE c.parent_id = tasks.id) AS children_count
        FROM tasks WHERE id = ?
        """,
        [node_id],
    )
    if row is None:
        return None
    if row["children_count"] == 0:
        return row["estimated_days"] if row["label"] == "APERTO" else None

    children = query_db(
        """
        SELECT id, label, assegnato, executor_user_id,
               (SELECT COUNT(*) FROM tasks c WHERE c.parent_id = tasks.id) AS children_count
        FROM tasks WHERE parent_id = ?
        """,
        [node_id],
    )
    active_children = [
        c for c in children
        if not (c["children_count"] == 0 and (c["label"] != "APERTO" or c["assegnato"] or c["executor_user_id"]))
    ]
    if not active_children:
        return 0.0  # tutti i figli chiusi/delegati: lavoro residuo nullo, non indeterminato
    total = 0.0
    for child in active_children:
        child_value = compute_estimated_days_rollup_unscoped(child["id"])
        if child_value is None:
            return None
        total += child_value
    return round(total, 1)


def compute_avanzamento(execution_date, deadline):
    """Percentuale di avanzamento *temporale* (non basato sul completamento delle foglie):
    quanta parte della finestra EX→DL è già trascorsa oggi. Richiede EX definita, altrimenti
    None (mostrato '—' dal frontend). Troncata a [0, 100]: un task non ancora iniziato o già
    in ritardo non deve mostrare percentuali fuori scala. Vale sia per una foglia (le sue
    date proprie) sia per un ramo/progetto (le sue date, già un rollup salvato dei figli —
    stessa funzione, nessun caso speciale)."""
    if not execution_date:
        return None
    today = date.today()
    ex = date.fromisoformat(execution_date)
    if not deadline or deadline == execution_date:
        return 100.0 if today >= ex else 0.0
    dl = date.fromisoformat(deadline)
    frac = (today - ex).days / (dl - ex).days
    return round(min(max(frac, 0.0), 1.0) * 100, 1)


def count_business_days(start_date, end_date):
    """Numero di giorni lavorativi (lun-ven) nell'intervallo [start_date, end_date], inclusi
    entrambi gli estremi. 0 se end_date precede start_date."""
    if end_date < start_date:
        return 0
    total_days = (end_date - start_date).days + 1
    full_weeks, remainder = divmod(total_days, 7)
    business_days = full_weeks * 5
    for i in range(remainder):
        if (start_date + timedelta(days=full_weeks * 7 + i)).weekday() < 5:
            business_days += 1
    return business_days


def _leaf_is_schedulable(node):
    """Foglia aperta, con stima e date proprie, non IN LISTA — condizione comune a
    _leaf_carico_lavoro e a collect_active_leaves: una foglia CHIUSA, delegata (il chiamante
    la esclude già prima di ricorrere, vedi compute_carico_lavoro_rollup/collect_active_leaves),
    IN LISTA o senza stima/date non pesa mai nel carico di lavoro."""
    return (
        node["label"] == "APERTO"
        and node["status"] != STATUS_IN_LISTA
        and node["estimated_days"] is not None
        and bool(node["execution_date"])
        and bool(node["deadline"])
    )


def _leaf_plateau_value(node):
    """Altezza costante (%) del carico di una foglia programmabile per tutta la sua finestra
    EX-DL (giorni lavorativi, weekend esclusi dal tempo disponibile) — non dipende da quale
    giorno sia "oggi", solo dalla stima e dalla durata lavorativa della finestra: usata sia
    per il carico odierno (_leaf_carico_lavoro, zero se oggi è fuori dalla finestra) sia per
    il grafico storico (collect_active_leaves, che manda al frontend l'intera finestra)."""
    ex = date.fromisoformat(node["execution_date"])
    dl = date.fromisoformat(node["deadline"])
    giorni_disponibili = count_business_days(ex, dl)
    tempo_disponibile = max(
        giorni_disponibili * CAPACITA_PRODUTTIVA_MEDIA,
        TEMPO_DISPONIBILE_MINIMO_GIORNI,
    )
    return round(node["estimated_days"] / tempo_disponibile * 100, 1)


def _leaf_carico_lavoro(node, today):
    """Base della ricorsione di compute_carico_lavoro_rollup: il carico costante di UNA
    foglia, diverso da zero solo nei giorni della sua finestra EX-DL — 0.0 se non è
    programmabile (vedi _leaf_is_schedulable) o se oggi è fuori dalla finestra (prima di EX o
    dopo DL: il carico non deve né crescere approssimandosi alla deadline né restare acceso a
    tempo indefinito dopo che la finestra pianificata è terminata)."""
    if not _leaf_is_schedulable(node):
        return 0.0
    ex = date.fromisoformat(node["execution_date"])
    dl = date.fromisoformat(node["deadline"])
    if not (ex <= today <= dl):
        return 0.0
    return _leaf_plateau_value(node)


def collect_active_leaves(node_id, tasks_by_id, children_by_parent):
    """Foglie attive (programmabili, non delegate a qualunque livello di annidamento) nel
    sottoalbero di node_id, con i soli campi che servono al grafico storico del carico
    (render_workload_chart.js): ciascuna pesa nel grafico solo nei giorni della propria
    finestra EX-DL con l'altezza costante `value`, mai spalmata sull'intera durata del
    progetto — stessa identica regola di compute_carico_lavoro_rollup, di cui questa è la
    versione "elenca le foglie" invece di "sommane il carico odierno"."""
    node = tasks_by_id[node_id]
    children = children_by_parent.get(node_id, [])
    if not children:
        if not _leaf_is_schedulable(node):
            return []
        return [{
            "execution_date": node["execution_date"],
            "deadline": node["deadline"],
            "value": _leaf_plateau_value(node),
        }]
    leaves = []
    for child in children:
        if child["executor_user_id"] is not None or child["assegnato"]:
            continue
        leaves.extend(collect_active_leaves(child["id"], tasks_by_id, children_by_parent))
    return leaves


def compute_carico_lavoro_rollup(node_id, tasks_by_id, children_by_parent, cache, today=None):
    """Carico di lavoro *odierno* (%) di un nodo. Per una foglia, `_leaf_carico_lavoro`. Per
    un ramo, la somma ricorsiva del carico dei figli — MAI il tempo stimato totale diviso
    per la durata dell'intera finestra del progetto (quella formula assumeva un ritmo
    costante su tutto l'arco del progetto, che cresceva in modo scorretto quando le finestre
    dei singoli task erano più brevi o sfalsate rispetto a quella complessiva). Un figlio
    delegato è escluso dalla somma a qualunque livello di annidamento, anche se è diventato a
    sua volta un ramo (il suo carico appartiene interamente alla voce dell'esecutore in
    get_workload, non va contato due volte)."""
    if node_id in cache:
        return cache[node_id]
    if today is None:
        today = date.today()
    node = tasks_by_id[node_id]
    children = children_by_parent.get(node_id, [])
    if not children:
        result = _leaf_carico_lavoro(node, today)
    else:
        total = 0.0
        for child in children:
            if child["executor_user_id"] is not None or child["assegnato"]:
                continue
            total += compute_carico_lavoro_rollup(child["id"], tasks_by_id, children_by_parent, cache, today)
        result = round(total, 1)
    cache[node_id] = result
    return result


def compute_carico_lavoro_rollup_unscoped(node_id, today=None):
    """Stessa logica di compute_carico_lavoro_rollup, ma cammina nel database reale invece
    che nella sola porzione di albero visibile al viewer corrente — stesso motivo di
    compute_estimated_days_rollup_unscoped: un ramo delegato internamente che il committente
    vede può avere figli reali (di un altro owner) mai presenti in GET /tasks per lui, quindi
    children_by_parent per lui sarebbe sempre vuoto.
    Semplificazione accettata: a differenza di _leaf_is_schedulable, non esclude le foglie
    IN LISTA (bloccate da dipendenze non risolte), perché richiederebbe di ricostruire anche
    la risoluzione delle dipendenze fuori dall'albero visibile al committente — un confine
    raro (delega interna trasformata in ramo, con dentro una foglia ulteriormente bloccata da
    dipendenze) per cui questa foglia può risultare leggermente sovrastimata."""
    if today is None:
        today = date.today()
    row = query_one(
        """
        SELECT id, label, execution_date, deadline, estimated_days,
               (SELECT COUNT(*) FROM tasks c WHERE c.parent_id = tasks.id) AS children_count
        FROM tasks WHERE id = ?
        """,
        [node_id],
    )
    if row is None:
        return 0.0
    if row["children_count"] == 0:
        if row["label"] != "APERTO" or row["estimated_days"] is None or not row["execution_date"] or not row["deadline"]:
            return 0.0
        ex = date.fromisoformat(row["execution_date"])
        dl = date.fromisoformat(row["deadline"])
        if not (ex <= today <= dl):
            return 0.0
        return _leaf_plateau_value(row)

    children = query_db("SELECT id, assegnato, executor_user_id FROM tasks WHERE parent_id = ?", [node_id])
    total = 0.0
    for child in children:
        if child["executor_user_id"] is not None or child["assegnato"]:
            continue
        total += compute_carico_lavoro_rollup_unscoped(child["id"], today)
    return round(total, 1)


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
            f"SELECT id FROM tasks WHERE owner_id = ? AND id IN ({','.join('?' * len(dependency_ids))})",
            [current_user_id(), *dependency_ids],
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

    fields = {"execution_date": new_execution_date, "deadline": new_deadline}
    # se questo nodo è la cima di una delega, un cambio di deadline dovuto al rollup dei
    # figli dell'esecutore deve avvisare il committente esattamente come un cambio diretto
    # (vedi update_task) — altrimenti, una volta che il nodo delegato diventa un ramo, la
    # deadline cambia sempre per questa via (mai più con una PUT diretta sul nodo stesso,
    # che ora è bloccata perché ha figli) e la notifica non scatterebbe più
    if (
        node["committente_user_id"] is not None
        and new_deadline != node["deadline"]
        and new_deadline
        and node["deadline"]
    ):
        if new_deadline > node["deadline"]:
            fields["delegation_notice"] = DELEGATION_NOTICE_POSTICIPATA
        elif new_deadline > date.today().isoformat():
            fields["delegation_notice"] = DELEGATION_NOTICE_ANTICIPATA

    set_clause = ", ".join(f"{key} = ?" for key in fields)
    execute_db(f"UPDATE tasks SET {set_clause} WHERE id = ?", (*fields.values(), node_id))
    if node["parent_id"] is not None:
        recompute_rollup_dates(node["parent_id"])


def recompute_subtree_rollup(node_id):
    """'Auto-guarigione' del rollup su tutto un sottoalbero: a differenza di
    recompute_rollup_dates (che aggiorna un nodo dai suoi figli e propaga verso l'alto),
    questa scende PRIMA in tutti i rami discendenti (dal basso verso l'alto, figli prima
    dei genitori) così ognuno usa già i valori aggiornati dei propri figli. Serve a
    correggere derive che l'aggiornamento incrementale potrebbe in teoria non aver
    coperto (es. dati storici precedenti all'introduzione del rollup automatico) — viene
    richiamata quando si apre la vista Gantt o la configurazione di un ramo, non a ogni
    modifica (per quello basta e avanza recompute_rollup_dates)."""
    node = get_task(node_id)
    if node is None or node["children_count"] == 0:
        return
    for child in query_db("SELECT id FROM tasks WHERE parent_id = ?", [node_id]):
        recompute_subtree_rollup(child["id"])
    recompute_rollup_dates(node_id)


@app.route("/tasks/<int:task_id>/recompute-rollup", methods=["POST"])
def recompute_rollup(task_id):
    if require_owned_task(task_id) is None:
        return {"error": "Task non trovato"}, 404
    recompute_subtree_rollup(task_id)
    return {"status": "ok"}


# preambolo condiviso da get_carico_leaves e get_leaves_carico: tutti i task visibili
# all'utente corrente (come owner o come committente) con lo status "live" ricalcolato
# (dipendenze comprese) esattamente come in GET /tasks — la colonna status in tabella può
# essere superata da un cambiamento altrove nel grafo delle dipendenze, mai aggiornata da
# una semplice lettura, quindi va sempre ricalcolata qui, non letta as-is dal db
def _owned_tasks_status_context():
    tasks = query_db(
        "SELECT t.*, (SELECT COUNT(*) FROM tasks c WHERE c.parent_id = t.id) AS children_count "
        "FROM tasks t WHERE t.owner_id = ? OR t.committente_user_id = ?",
        [current_user_id(), current_user_id()],
    )
    tasks_by_id = {t["id"]: t for t in tasks}
    children_by_parent = {}
    for t in tasks:
        if t["parent_id"] is not None:
            children_by_parent.setdefault(t["parent_id"], []).append(t)

    deps_by_task = {}
    for r in query_db("SELECT task_id, depends_on_id FROM task_dependencies"):
        if r["task_id"] in tasks_by_id:
            deps_by_task.setdefault(r["task_id"], []).append(r["depends_on_id"])

    resolution_cache = {}
    today = date.today().isoformat()
    for t in tasks:
        if t["label"] == "APERTO":
            dep_statuses = [
                resolve_dependency_status(d, tasks_by_id, children_by_parent, resolution_cache)
                for d in deps_by_task.get(t["id"], []) if d in tasks_by_id
            ]
            t["status"], _ = compute_open_status(
                t["execution_date"], t["deadline"], t["assegnato"], dep_statuses, today,
                is_delegated_internally=t["executor_user_id"] is not None,
            )

    return tasks_by_id, children_by_parent


# usata dal grafico "carico complessivo" in cima alla Vista Gantt (render_gantt.js): riusa
# collect_active_leaves (stessa funzione della Vista Carico di lavoro) invece di duplicare
# in JS la formula del carico — già corretta due volte in questa sessione, va tenuta in un
# solo posto. Owner-gated come "Vista Gantt" stessa (mai proposta al committente).
@app.route("/tasks/<int:task_id>/carico-leaves", methods=["GET"])
def get_carico_leaves(task_id):
    if require_owned_task(task_id) is None:
        return {"error": "Task non trovato"}, 404
    tasks_by_id, children_by_parent = _owned_tasks_status_context()
    return jsonify(collect_active_leaves(task_id, tasks_by_id, children_by_parent))


# usata dal grafico del carico di lavoro sopra la vista Calendario in Vista Foglie
# (render_leaves.js/render_calendar.js): a differenza di get_carico_leaves non cammina un
# sottoalbero, riceve direttamente l'elenco (già appiattito e filtrato lato client secondo
# i filtri di Vista Foglie selezionati) delle foglie attualmente visualizzate, e ne calcola
# il carico con la stessa formula (_leaf_is_schedulable/_leaf_plateau_value), mai duplicata
# in JS. Conta solo le foglie di cui l'utente corrente è owner — dopo una delega è
# l'esecutore (il vero owner_id aggiornato), mai il solo committente: stessa esclusione che
# collect_active_leaves applica scendendo da un progetto (mai contare due volte, sotto il
# progetto originale E sotto la propria vista, lo stesso carico delegato altrove)
@app.route("/leaves-carico", methods=["POST"])
def get_leaves_carico():
    data = request.get_json() or {}
    try:
        ids = [int(x) for x in (data.get("ids") or [])]
    except (TypeError, ValueError):
        return {"error": "ids non valido"}, 400
    if not ids:
        return jsonify([])

    tasks_by_id, _ = _owned_tasks_status_context()
    result = [
        {
            "execution_date": t["execution_date"],
            "deadline": t["deadline"],
            "value": _leaf_plateau_value(t),
        }
        for leaf_id in ids
        if (t := tasks_by_id.get(leaf_id)) is not None
        and t["owner_id"] == current_user_id()
        and _leaf_is_schedulable(t)
    ]
    return jsonify(result)


# ---------------------------------------------------------------------------
# Tasks API
# ---------------------------------------------------------------------------

@app.route("/tasks", methods=["GET"])
def get_tasks():
    # ?all=1, solo per un superuser: vista di supervisione su tutto il db (tutti i progetti
    # di tutti gli utenti), non solo i propri task come owner/committente. Il resto della
    # funzione non cambia: la logica di "punto di vista" più sotto (confronti con
    # current_user_id()) semplicemente non scatta per i task altrui, quindi il superuser vede
    # lo status interno reale di ogni nodo invece della versione filtrata per il committente
    see_all = request.args.get("all") == "1" and current_user_is_superuser()

    if see_all:
        tasks = query_db(
            f"""
            SELECT t.*,
                   (SELECT COUNT(*) FROM tasks c WHERE c.parent_id = t.id) AS children_count,
                   {EXPIRED_SQL},
                   {DEADLINE_APPROACHING_SQL}
            FROM tasks t
            ORDER BY t.id
            """
        )
    else:
        tasks = query_db(
            f"""
            SELECT t.*,
                   (SELECT COUNT(*) FROM tasks c WHERE c.parent_id = t.id) AS children_count,
                   {EXPIRED_SQL},
                   {DEADLINE_APPROACHING_SQL}
            FROM tasks t
            WHERE t.owner_id = ? OR t.committente_user_id = ?
            ORDER BY t.id
            """,
            [current_user_id(), current_user_id()],
        )

    users_by_id = {u["id"]: u["username"] for u in query_db("SELECT id, username FROM users")}
    for t in tasks:
        t["owner_username"] = users_by_id.get(t["owner_id"])
        t["committente_username"] = users_by_id.get(t["committente_user_id"])
        t["executor_username"] = users_by_id.get(t["executor_user_id"])

    # codice progetto "effettivo" di un ticket, calcolato ignorando i confini di visibilità
    # (vedi resolve_root_project_code_unscoped): serve solo a chi ha creato il ticket
    # (ticket_owner_id, stabile anche se non delegato/rifiutato — a differenza di
    # committente_user_id), per gli altri task resta None e la UI usa rootProjectCode()
    # lato client come sempre
    ticket_ids = {t["id"] for t in tasks if t["ticket_owner_id"] == current_user_id()}
    if ticket_ids:
        chain_by_id = {r["id"]: r for r in query_db("SELECT id, parent_id, project_code FROM tasks")}
        for t in tasks:
            t["ticket_project_code"] = (
                resolve_root_project_code_unscoped(t["id"], chain_by_id) if t["id"] in ticket_ids else None
            )
    else:
        for t in tasks:
            t["ticket_project_code"] = None

    task_ids = {t["id"] for t in tasks}
    deps_by_task = {}
    for r in query_db("SELECT task_id, depends_on_id FROM task_dependencies"):
        if r["task_id"] in task_ids:
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
                t["execution_date"], t["deadline"], t["assegnato"], dep_statuses, today,
                is_delegated_internally=t["executor_user_id"] is not None,
            )
            t["status"] = computed_status
            t["escalation"] = escalated and not t["escalation_seen"]

            # il committente non deve vedere la progressione interna dell'esecutore (Pianificato/
            # Dipendente/Bloccato/Attivo sono "affari" dell'esecutore): per lui un task delegato
            # internamente resta un generico DELEGATO finché non scade la deadline, esattamente
            # come già accade per la delega esterna — stessa etichetta/colore, stesso significato
            if t["committente_user_id"] == current_user_id() and t["status"] != STATUS_IN_RITARDO:
                t["status"] = STATUS_DELEGATO

    # se l'esecutore trasforma il nodo delegato in un ramo (aggiungendogli figli), per il
    # committente resta comunque concettualmente "quella foglia delegata": lui non vede mai i
    # figli reali (di un altro owner), quindi deve continuare a vederlo come un task lavorabile
    # con uno status, non come un ramo "vuoto" senza status che sparirebbe anche da Vista
    # Foglie. Le date restano quelle già in colonna (rollup salvato, aggiornato dall'esecutore
    # a ogni modifica dei suoi figli — vedi recompute_rollup_dates), quindi il confronto con
    # la deadline resta valido anche qui
    for t in tasks:
        if t["committente_user_id"] == current_user_id() and t["executor_user_id"] is not None and t["children_count"] > 0:
            t["status"] = STATUS_IN_RITARDO if (t["deadline"] and today >= t["deadline"]) else STATUS_DELEGATO

    # tempo stimato di un ramo: mai memorizzato (la colonna resta NULL, azzerata nello
    # stesso istante in cui una foglia guadagna il primo figlio), sempre ricalcolato qui
    # come somma delle foglie discendenti attive — sovrascrive solo per i rami, il valore
    # di una foglia è già quello vero letto dal db (SELECT t.* più sopra)
    estimated_cache = {}
    # per un ramo delegato (children_by_parent, limitato a ciò che QUESTO viewer vede, non
    # conterrebbe i figli reali se il viewer è il committente e l'esecutore li ha creati),
    # pre-carica in cache il valore vero calcolato interrogando il database reale: la
    # ricorsione sotto lo trova già pronto (prima riga della funzione: "if node_id in
    # cache") e lo somma correttamente anche negli antenati, invece di propagare "—" verso
    # l'alto solo perché il committente non vede quel sottoalbero
    for t in tasks:
        if t["children_count"] > 0 and t["committente_user_id"] == current_user_id():
            estimated_cache[t["id"]] = compute_estimated_days_rollup_unscoped(t["id"])
    for t in tasks:
        if t["children_count"] > 0:
            t["estimated_days"] = compute_estimated_days_rollup(t["id"], tasks_by_id, children_by_parent, estimated_cache)

    # carico di lavoro odierno (%) di ogni nodo (mostrato nella finestra di configurazione):
    # stessa idea del rollup del tempo stimato appena sopra — un ramo delegato internamente
    # visibile al committente può avere figli reali (di un altro owner) assenti da
    # children_by_parent per lui, quindi si pre-carica in cache il valore vero
    carico_cache = {}
    today_date = date.today()
    for t in tasks:
        if t["children_count"] > 0 and t["committente_user_id"] == current_user_id():
            carico_cache[t["id"]] = compute_carico_lavoro_rollup_unscoped(t["id"], today_date)
    for t in tasks:
        t["carico_lavoro"] = compute_carico_lavoro_rollup(t["id"], tasks_by_id, children_by_parent, carico_cache, today_date)

    # propaga "expired" verso l'alto (padre, nonno, ... fino alla radice): un ramo non è mai
    # "expired" di suo (la sua deadline è il rollup MAX dei figli, quindi in genere non ancora
    # raggiunta anche quando un figlio più urgente lo è già), ma deve comunque segnalare la
    # presenza di una foglia scaduta al suo interno senza dover essere espanso.
    # Un nodo delegato diventato ramo non ha mai `expired` true (EXPIRED_SQL richiede
    # label='APERTO', che un ramo non ha più) anche quando per il committente il suo status è
    # IN_RITARDO: senza includerlo esplicitamente qui, quel ritardo non risalirebbe mai verso
    # gli antenati con l'albero collassato.
    for t in tasks:
        t["expired_descendant"] = False
    for t in tasks:
        is_delegated_branch_late = (
            t["committente_user_id"] == current_user_id()
            and t["executor_user_id"] is not None
            and t["children_count"] > 0
            and t["status"] == STATUS_IN_RITARDO
        )
        if not t["expired"] and not is_delegated_branch_late:
            continue
        pid = t["parent_id"]
        while pid is not None:
            parent = tasks_by_id.get(pid)
            if parent is None or parent["expired_descendant"]:
                break
            parent["expired_descendant"] = True
            pid = parent["parent_id"]

    # stessa propagazione verso l'alto, questa volta per la notifica di delega non ancora
    # vista dal committente: senza risalire fino alla radice, una notifica su una foglia
    # profonda resterebbe invisibile con l'albero collassato. Risale solo lungo gli antenati
    # del committente stesso (tasks_by_id è già filtrato per lui), che sono sempre gli stessi
    # a cui appartiene anche il nodo delegato (la delega non cambia mai il parent_id)
    for t in tasks:
        t["notice_descendant"] = False
    for t in tasks:
        if t["committente_user_id"] != current_user_id() or not t["delegation_notice"]:
            continue
        pid = t["parent_id"]
        while pid is not None:
            parent = tasks_by_id.get(pid)
            if parent is None or parent["notice_descendant"]:
                break
            parent["notice_descendant"] = True
            pid = parent["parent_id"]

    # stessa propagazione verso l'alto per le due fasi di attesa-decisione (delega da
    # accettare, completamento da confermare): a differenza di notice_descendant sopra non
    # serve filtrare per committente_user_id, perché tasks_by_id è già la sola porzione di
    # albero visibile al viewer corrente (owner o committente) — la stessa logica copre
    # quindi "sia lato committente che lato esecutore" senza bisogno di due varianti. Lato
    # esecutore in pratica non risale mai: il nodo delegato non ha un genitore visibile nel
    # suo result set (resta un "figlio orfano" trattato come radice), quindi il while sotto
    # trova subito parent is None e non propaga nulla, correttamente
    for t in tasks:
        t["delegation_pending_descendant"] = False
        t["completion_pending_descendant"] = False
    for t in tasks:
        if t["delegation_status"] != DELEGATION_IN_ATTESA:
            continue
        pid = t["parent_id"]
        while pid is not None:
            parent = tasks_by_id.get(pid)
            if parent is None or parent["delegation_pending_descendant"]:
                break
            parent["delegation_pending_descendant"] = True
            pid = parent["parent_id"]
    for t in tasks:
        if not t["completion_pending"]:
            continue
        pid = t["parent_id"]
        while pid is not None:
            parent = tasks_by_id.get(pid)
            if parent is None or parent["completion_pending_descendant"]:
                break
            parent["completion_pending_descendant"] = True
            pid = parent["parent_id"]

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
        estimated_days = validate_estimated_days(data.get("estimated_days"))
        project_code = validate_project_code(data.get("project_code"))
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
        parent = require_owned_task(parent_id)
        if parent is None:
            return {"error": "Nodo padre non trovato"}, 404
        if parent["children_count"] == 0 and parent["label"] == "CHIUSO":
            return {"error": "Non è possibile creare sotto-attività da questa foglia (chiusa)"}, 409

    if project_code is not None:
        if parent_id is not None:
            return {"error": "Il codice progetto è impostabile solo su un progetto radice"}, 409
        if not current_user_can_set_project_code():
            return {"error": "Non sei autorizzato a impostare il codice progetto"}, 403
        existing_owner = find_project_code_owner_username(project_code)
        if existing_owner is not None:
            return {"error": f"Codice progetto già utilizzato da {existing_owner}."}, 409

    # canale "ticket" (vedi ticket_owner_id in init_db.py): una foglia creata senza casa
    # nell'albero del creatore, per essere delegata subito a un collega esterno ai suoi
    # progetti — sempre e solo una radice, mai sotto-attività di qualcosa
    is_ticket = bool(data.get("is_ticket"))
    if is_ticket and parent_id is not None:
        return {"error": "Una banana non può avere un nodo padre"}, 400
    ticket_owner_id = current_user_id() if is_ticket else None

    new_id = execute_db(
        """
        INSERT INTO tasks (parent_id, owner_id, title, description, deadline, execution_date,
                            assegnato, label, status, estimated_days, project_code, ticket_owner_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (parent_id, current_user_id(), title, description, deadline, execution_date, assegnato, label, status,
         estimated_days, project_code, ticket_owner_id),
    )

    statements = []
    # una foglia che diventa nodo padre perde status/focus/label e le sue dipendenze
    if parent is not None and parent["children_count"] == 0:
        statements.append((
            "UPDATE tasks SET status = NULL, focus = 0, label = NULL, assegnato = NULL, estimated_days = NULL WHERE id = ?",
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

    return {"id": new_id}, 201


@app.route("/tasks/<int:task_id>", methods=["PUT"])
def update_task(task_id):
    task = require_owned_task(task_id)
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
        if "estimated_days" in data:
            fields["estimated_days"] = validate_estimated_days(data["estimated_days"])
        if "project_code" in data:
            fields["project_code"] = validate_project_code(data["project_code"])
    except ValueError as e:
        return {"error": str(e)}, 400

    dependency_ids = data.get("dependency_ids")
    if dependency_ids is not None:
        dependency_ids = [int(x) for x in dependency_ids]

    if not fields and dependency_ids is None:
        return {"error": "Nessun campo da aggiornare"}, 400

    # un task delegato completato E già confermato dal committente (completion_pending
    # tornato a 0 dopo /confirm-completion, non semplicemente mai stato delegato) non è più
    # modificabile nemmeno dall'esecutore: resta libero solo lo stato aperto/chiuso, per
    # poterlo comunque riaprire se davvero necessario. I campi possono essere reinviati
    # invariati (il modale rimanda sempre l'intero form): si blocca solo un cambio vero
    locked_complete = (
        task["executor_user_id"] is not None
        and task["label"] == "CHIUSO"
        and task["status"] == STATUS_COMPLETATO
        and not task["completion_pending"]
    )
    if locked_complete:
        changed_other_fields = any(key not in ("label", "status") and fields[key] != task[key] for key in fields)
        changed_dependencies = dependency_ids is not None and set(dependency_ids) != set(get_dependency_ids(task_id))
        if changed_other_fields or changed_dependencies:
            return {
                "error": "Un task completato e con completamento confermato non è più modificabile: resta libero solo lo stato aperto/chiuso"
            }, 409

    label = fields.get("label", task["label"])
    if (fields.get("label") is not None or fields.get("status") is not None) and task["children_count"] > 0:
        return {"error": "Un nodo con figli non può avere status/label"}, 409

    if "project_code" in fields:
        if task["parent_id"] is not None:
            return {"error": "Il codice progetto è impostabile solo su un progetto radice"}, 409
        if not current_user_can_set_project_code():
            return {"error": "Non sei autorizzato a impostare il codice progetto"}, 403
        if fields["project_code"] is not None:
            existing_owner = find_project_code_owner_username(fields["project_code"], exclude_task_id=task_id)
            if existing_owner is not None:
                return {"error": f"Codice progetto già utilizzato da {existing_owner}."}, 409

    execution_date = fields.get("execution_date", task["execution_date"])
    deadline = fields.get("deadline", task["deadline"])
    assegnato = fields.get("assegnato", task["assegnato"])
    final_dependency_ids = dependency_ids if dependency_ids is not None else get_dependency_ids(task_id)

    try:
        if task["children_count"] > 0:
            # un nodo con figli non ha label/status (non è né APERTO né CHIUSO) e le sue
            # date/tempo stimato non si impostano più a mano: sono sempre calcolati
            # automaticamente dai figli
            if "execution_date" in fields or "deadline" in fields or "estimated_days" in fields:
                return {
                    "error": "Le date e il tempo stimato di un nodo con figli sono calcolati automaticamente dai figli"
                }, 409
            enforce_open_task_rules(fields, execution_date, deadline, assegnato, final_dependency_ids)
        elif label == "APERTO":
            if "status" in fields:
                return {"error": "Lo status di un task APERTO è calcolato automaticamente"}, 409
            # una volta delegato internamente, l'esecutore può spostare le date ma non
            # azzerarle: altrimenti lo status tornerebbe IN LISTA, che per un task delegato
            # non ha senso (il committente lo vedrebbe come "delegato" senza che lo sia più)
            if task["executor_user_id"] is not None and (execution_date is None or deadline is None):
                return {
                    "error": "Un task delegato internamente non può restare senza data di esecuzione o deadline"
                }, 409
            execution_date = enforce_open_task_rules(fields, execution_date, deadline, assegnato, final_dependency_ids)
            fields["status"] = None
            fields["completion_pending"] = 0
        else:
            final_status = fields.get("status", task["status"])
            if final_status not in CLOSED_STATUSES:
                return {"error": "Un task chiuso richiede status QUARANTENA, COMPLETATO o INTERROTTO"}, 400
            fields["status"] = final_status
            if dependency_ids:
                return {"error": "Un task chiuso non può avere dipendenze"}, 409
            final_dependency_ids = []
            # l'esecutore che chiude una propria foglia delegata come COMPLETATO non la
            # chiude davvero: apre la fase di accettazione del completamento (analoga a
            # quella della delega), il committente deve confermare o rifiutare — vedi
            # /confirm-completion e /reject-completion. QUARANTENA/INTERROTTO restano
            # chiusure istantanee come oggi, così come qualunque chiusura non delegata
            fields["completion_pending"] = 1 if (
                task["executor_user_id"] is not None and final_status == STATUS_COMPLETATO
            ) else 0

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

    # l'esecutore può sempre spostare la deadline di un task delegato: il committente deve
    # accorgersene subito, quindi il titolo si colora finché non apre la configurazione.
    # Eccezione: se l'anticipo porta la deadline a oggi o prima, niente notifica verde —
    # il task è già (o sta per essere) IN RITARDO, e quella gestione segnala già la cosa
    # da sola (stesso status per esecutore e committente) senza bisogno di un avviso in più
    if task["committente_user_id"] is not None and new_dl != task["deadline"] and new_dl and task["deadline"]:
        if new_dl > task["deadline"]:
            fields["delegation_notice"] = DELEGATION_NOTICE_POSTICIPATA
        elif new_dl > date.today().isoformat():
            fields["delegation_notice"] = DELEGATION_NOTICE_ANTICIPATA

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
    task = require_owned_task(task_id)
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
            ("UPDATE tasks SET focus = 0 WHERE focus = 1 AND owner_id = ?", (current_user_id(),)),
            ("UPDATE tasks SET focus = 1 WHERE id = ?", (task_id,)),
        ])
    else:
        execute_db("UPDATE tasks SET focus = 0 WHERE id = ?", (task_id,))

    return {"status": "ok"}


@app.route("/tasks/<int:task_id>/parent", methods=["PATCH"])
def move_task(task_id):
    task = require_movable_task(task_id)
    if task is None:
        return {"error": "Task non trovato"}, 404

    data = request.get_json() or {}
    new_parent_id = data.get("parent_id")

    new_parent = None
    if new_parent_id is not None:
        new_parent = require_owned_task(new_parent_id)
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
    # un nodo radice con codice progetto che smette di essere radice (guadagna un padre)
    # perde il codice nello stesso momento — simmetrico al "lo perde se spostato fuori da
    # un progetto codificato": il codice ha senso solo su un nodo che resta radice
    if task["project_code"] is not None and new_parent_id is not None:
        statements = [("UPDATE tasks SET parent_id = ?, project_code = NULL WHERE id = ?", (new_parent_id, task_id))]
    else:
        statements = [("UPDATE tasks SET parent_id = ? WHERE id = ?", (new_parent_id, task_id))]

    # se il nuovo padre era una foglia, diventa un ramo: stessa transizione già
    # usata in create_task quando una foglia guadagna il primo figlio
    if new_parent is not None and new_parent["children_count"] == 0:
        statements.append((
            "UPDATE tasks SET status = NULL, focus = 0, label = NULL, assegnato = NULL, estimated_days = NULL WHERE id = ?",
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
    if task is not None:
        is_superuser = current_user_is_superuser()
        if task["executor_user_id"] is not None:
            # un task delegato (in attesa o già accettato) non è mai eliminabile dal suo
            # esecutore, che pure ne è owner: solo un superuser può farlo
            if not is_superuser:
                return {"error": "Solo un utente superuser può eliminare un task delegato"}, 403
        elif task["owner_id"] != current_user_id():
            # un superuser può eliminare qualunque nodo di qualunque utente, non solo i
            # propri (vedi "SUPERUSER vede tutto il DB"): bypassa il controllo di ownership
            if not is_superuser:
                return {"error": "Task non trovato"}, 404
        elif task["ticket_owner_id"] is not None and task["label"] == "CHIUSO":
            # un ticket chiuso (completato e confermato) resta nel log permanente del
            # committente, come richiesto: eliminabile solo finché è ancora "in bozza" (mai
            # stato chiuso) — es. appena creato, oppure rifiutato/interrotto dall'esecutore e
            # tornato APERTO in attesa di essere modificato e reinviato
            if not is_superuser:
                return {"error": "Una banana chiusa non può essere eliminata"}, 403
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
    if require_visible_task(task_id) is None:
        return {"error": "Task non trovato"}, 404
    return jsonify(get_ancestor_ids(task_id))


# ---------------------------------------------------------------------------
# Delega API — COMMITTENTE: chi delega; ESECUTORE: chi riceve. L'ownership passa
# subito all'esecutore alla delega (non solo dopo l'accettazione): è quello che
# rende gratuita tutta la visibilità dell'esecutore (il filtro owner_id esistente
# gli dà già tutto), mentre il committente vede il solo nodo delegato in sola
# lettura tramite committente_user_id, mai i suoi discendenti.
# ---------------------------------------------------------------------------

@app.route("/users", methods=["GET"])
def get_users():
    users = query_db(
        "SELECT id, username FROM users WHERE id != ? ORDER BY username COLLATE NOCASE",
        [current_user_id()],
    )
    return jsonify(users)


@app.route("/tasks/<int:task_id>/delegate", methods=["POST"])
def delegate_task(task_id):
    task = require_owned_task(task_id)
    if task is None:
        return {"error": "Task non trovato"}, 404
    if task["children_count"] > 0:
        return {"error": "Solo una foglia può essere delegata"}, 409
    if task["label"] != "APERTO":
        return {"error": "Solo una foglia APERTA può essere delegata"}, 409
    if task["deadline"] is None:
        return {"error": "Serve una deadline già impostata per poter delegare"}, 409

    data = request.get_json() or {}
    executor_username = (data.get("executor_username") or "").strip() or None
    external_name = data.get("external_name")
    try:
        external_name = validate_assegnato(external_name)
    except ValueError as e:
        return {"error": str(e)}, 400

    if executor_username and external_name:
        return {"error": "Compila solo uno dei due campi (Interna o Esterna)"}, 400

    if executor_username:
        executor = query_one("SELECT id FROM users WHERE username = ?", [executor_username])
        if executor is None:
            return {"error": "Utente non trovato"}, 404
        if executor["id"] == current_user_id():
            return {"error": "Non puoi delegare un task a te stesso"}, 400
        statements = [
            ("DELETE FROM task_dependencies WHERE task_id = ? OR depends_on_id = ?", (task_id, task_id)),
            (
                """
                UPDATE tasks SET
                    owner_id = ?, committente_user_id = ?, executor_user_id = ?,
                    delegation_status = ?, delegation_notice = NULL, assegnato = NULL, focus = 0
                WHERE id = ?
                """,
                (executor["id"], current_user_id(), executor["id"], DELEGATION_IN_ATTESA, task_id),
            ),
        ]
        execute_transaction(statements)
        return {"status": "ok"}

    if external_name:
        execute_db(
            """
            UPDATE tasks SET
                assegnato = ?, committente_user_id = NULL, executor_user_id = NULL,
                delegation_status = NULL, delegation_notice = NULL
            WHERE id = ?
            """,
            (external_name, task_id),
        )
        return {"status": "ok"}

    # nessuno dei due campi: revoca la delega esterna esistente. Una delega interna attiva
    # non può essere disconnessa così — serve passare da Rifiuta/Interrompi delega lato esecutore.
    if task["executor_user_id"] is not None:
        return {"error": "Usa Rifiuta/Interrompi delega, non è revocabile direttamente dal committente"}, 409
    execute_db(
        "UPDATE tasks SET assegnato = NULL, committente_user_id = NULL, executor_user_id = NULL, "
        "delegation_status = NULL, delegation_notice = NULL WHERE id = ?",
        (task_id,),
    )
    return {"status": "ok"}


@app.route("/tasks/<int:task_id>/accept-delegation", methods=["POST"])
def accept_delegation(task_id):
    task = get_task(task_id)
    if task is None or task["executor_user_id"] != current_user_id() or task["delegation_status"] != DELEGATION_IN_ATTESA:
        return {"error": "Task non trovato"}, 404
    execute_db(
        "UPDATE tasks SET delegation_status = ?, delegation_notice = ? WHERE id = ?",
        (DELEGATION_ACCETTATA, DELEGATION_NOTICE_ACCETTATA, task_id),
    )
    return {"status": "ok"}


@app.route("/tasks/<int:task_id>/decline-delegation", methods=["POST"])
def decline_delegation(task_id):
    """Restituisce il task al committente: stessa transizione sia per il rifiuto di una
    delega non ancora accettata sia per l'interruzione volontaria di una già accettata —
    cambia solo l'etichetta del bottone mostrata dal frontend in base allo stato. Bloccata
    se l'esecutore ha già costruito una discendenza propria sotto il nodo: restituirlo
    lascerebbe quei figli (ancora suoi) appesi sotto un nodo tornato del committente."""
    task = get_task(task_id)
    if task is None or task["executor_user_id"] != current_user_id():
        return {"error": "Task non trovato"}, 404
    if task["children_count"] > 0:
        return {
            "error": "Non è possibile restituire un task delegato che ha già una propria discendenza"
        }, 409
    execute_db(
        """
        UPDATE tasks SET
            owner_id = ?, committente_user_id = NULL, executor_user_id = NULL,
            delegation_status = NULL, delegation_notice = NULL
        WHERE id = ?
        """,
        (task["committente_user_id"], task_id),
    )
    return {"status": "ok"}


@app.route("/tasks/<int:task_id>/ack-delegation-notice", methods=["POST"])
def ack_delegation_notice(task_id):
    task = require_visible_task(task_id)
    if task is None or task["committente_user_id"] != current_user_id():
        return {"error": "Task non trovato"}, 404
    execute_db("UPDATE tasks SET delegation_notice = NULL WHERE id = ?", (task_id,))
    return {"status": "ok"}


@app.route("/tasks/<int:task_id>/confirm-completion", methods=["POST"])
def confirm_completion(task_id):
    """Il committente conferma che il completamento segnato dall'esecutore è conforme:
    il task resta chiuso/COMPLETATO com'era, si spegne solo l'attesa di conferma."""
    task = get_task(task_id)
    if task is None or task["committente_user_id"] != current_user_id() or not task["completion_pending"]:
        return {"error": "Task non trovato"}, 404
    execute_db("UPDATE tasks SET completion_pending = 0 WHERE id = ?", (task_id,))
    return {"status": "ok"}


@app.route("/tasks/<int:task_id>/reject-completion", methods=["POST"])
def reject_completion(task_id):
    """Il committente rifiuta il completamento segnato dall'esecutore: il task torna
    APERTO (stesso percorso generico di qualunque riapertura), di nuovo attivo per
    l'esecutore — nessuna dipendenza pregressa viene ripristinata, stesso limite accettato
    di ogni riapertura di un task chiuso."""
    task = get_task(task_id)
    if task is None or task["committente_user_id"] != current_user_id() or not task["completion_pending"]:
        return {"error": "Task non trovato"}, 404
    execute_db(
        "UPDATE tasks SET label = 'APERTO', status = NULL, completion_pending = 0 WHERE id = ?",
        (task_id,),
    )
    return {"status": "ok"}


@app.route("/tasks/<int:task_id>/ack-escalation", methods=["POST"])
def ack_escalation(task_id):
    """Spegne il badge/riga gialla di escalation alla semplice apertura della
    configurazione, come le altre notifiche temporanee — non serve più salvare. Se le date
    cambiano davvero e si salva, update_task la riarma comunque (escalation_seen torna a 0)."""
    task = require_owned_task(task_id)
    if task is None:
        return {"error": "Task non trovato"}, 404
    execute_db("UPDATE tasks SET escalation_seen = 1 WHERE id = ?", (task_id,))
    return {"status": "ok"}


# azzera in un colpo solo tutte le notifiche temporanee dell'utente corrente (stesso effetto
# di aprire, uno per uno, ogni nodo con un'escalation o una notifica di delega ancora accesa)
# — voce del menu tasto destro sul nodo "utente" fittizio in Albero, vedi render_tree.js
@app.route("/notifications/reset-all", methods=["POST"])
def reset_all_notifications():
    user_id = current_user_id()
    execute_db("UPDATE tasks SET escalation_seen = 1 WHERE owner_id = ?", (user_id,))
    execute_db("UPDATE tasks SET delegation_notice = NULL WHERE committente_user_id = ?", (user_id,))
    return {"status": "ok"}


# ---------------------------------------------------------------------------
# Vista "Carico di lavoro" (Fase 5) — unico endpoint che deliberatamente non è owner/
# committente-scoped: chiunque loggato vede, di chiunque altro, titolo/date/status/stima
# dei SOLI task con un codice progetto (aziendali), mai descrizione/note/dipendenze/
# checklist. I task personali (senza codice) restano privati come ovunque nell'app, anche
# per l'utente stesso — vedi discussione di progetto.
# ---------------------------------------------------------------------------

def resolve_root_project_code(task_id, tasks_by_id):
    node = tasks_by_id.get(task_id)
    while node is not None and node["parent_id"] is not None:
        node = tasks_by_id.get(node["parent_id"])
    return node["project_code"] if node else None


@app.route("/workload", methods=["GET"])
def get_workload():
    tasks = query_db(
        "SELECT t.*, (SELECT COUNT(*) FROM tasks c WHERE c.parent_id = t.id) AS children_count FROM tasks t"
    )
    tasks_by_id = {t["id"]: t for t in tasks}
    children_by_parent = {}
    for t in tasks:
        if t["parent_id"] is not None:
            children_by_parent.setdefault(t["parent_id"], []).append(t)

    deps_by_task = {}
    for r in query_db("SELECT task_id, depends_on_id FROM task_dependencies"):
        deps_by_task.setdefault(r["task_id"], []).append(r["depends_on_id"])

    resolution_cache = {}
    today = date.today().isoformat()
    for t in tasks:
        if t["label"] == "APERTO":
            dep_statuses = [
                resolve_dependency_status(d, tasks_by_id, children_by_parent, resolution_cache)
                for d in deps_by_task.get(t["id"], []) if d in tasks_by_id
            ]
            t["status"], _ = compute_open_status(
                t["execution_date"], t["deadline"], t["assegnato"], dep_statuses, today,
                is_delegated_internally=t["executor_user_id"] is not None,
            )
        # CHIUSO: lo status resta quello reale già in colonna (SELECT t.* iniziale).
        # Ramo (label NULL): la colonna è già NULL di suo, nessun tocco necessario.

    today_date = date.today()
    carico_cache = {}
    users_by_id = {u["id"]: u["username"] for u in query_db("SELECT id, username FROM users")}

    entries_by_executor = {}
    own_projects_by_owner = {}
    for t in tasks:
        if t["executor_user_id"] is not None:
            project_code = resolve_root_project_code(t["id"], tasks_by_id)
            if project_code is None:
                continue  # task delegato ma senza codice progetto: non è "aziendale", escluso
            if t["status"] in CLOSED_STATUSES:
                continue  # non piu' "carico di lavoro attuale"
            entries_by_executor.setdefault(t["executor_user_id"], []).append({
                "id": t["id"],
                "owner_id": t["owner_id"],
                "project_code": project_code,
                "title": t["title"],
                "avanzamento": compute_avanzamento(t["execution_date"], t["deadline"]),
                "carico_lavoro": compute_carico_lavoro_rollup(t["id"], tasks_by_id, children_by_parent, carico_cache, today_date),
                "leaves": collect_active_leaves(t["id"], tasks_by_id, children_by_parent),
                "status": t["status"],
                "committente_username": users_by_id.get(t["committente_user_id"]),
                "executor_username": users_by_id.get(t["executor_user_id"]),
                "execution_date": t["execution_date"],
                "deadline": t["deadline"],
            })
        elif t["parent_id"] is None and t["project_code"] is not None and t["committente_user_id"] is None:
            own_projects_by_owner.setdefault(t["owner_id"], []).append({
                "id": t["id"],
                "owner_id": t["owner_id"],
                "project_code": t["project_code"],
                "title": t["title"],
                "avanzamento": compute_avanzamento(t["execution_date"], t["deadline"]),
                "carico_lavoro": compute_carico_lavoro_rollup(t["id"], tasks_by_id, children_by_parent, carico_cache, today_date),
                "leaves": collect_active_leaves(t["id"], tasks_by_id, children_by_parent),
                "status": t["status"],
                "committente_username": None,
                "executor_username": users_by_id.get(t["owner_id"]),
                "execution_date": t["execution_date"],
                "deadline": t["deadline"],
            })

    def sort_key(entry):
        return entry["deadline"] or "9999-99-99"

    users = []
    for u in query_db("SELECT id, username FROM users ORDER BY username COLLATE NOCASE"):
        delegated = sorted(entries_by_executor.get(u["id"], []), key=sort_key)
        own_projects = sorted(own_projects_by_owner.get(u["id"], []), key=sort_key)
        # un progetto con codice che l'utente si è creato per sé conta comunque nel carico
        # aggregato: avendo un codice è "approvato" dall'azienda, quindi è come se fosse
        # delegato da una decisione strategica esterna al software, non un task personale
        all_entries = delegated + own_projects
        # compute_carico_lavoro_rollup non ritorna mai None (una foglia senza stima, IN LISTA
        # o chiusa contribuisce semplicemente 0, vedi _leaf_carico_lavoro): la somma aggregata
        # è quindi una semplice somma, senza bisogno di ignorare voci mancanti
        workload_today = round(sum(e["carico_lavoro"] for e in all_entries), 1)
        users.append({
            "id": u["id"],
            "username": u["username"],
            "delegated_count": len(all_entries),
            "workload_today": workload_today,
            "delegated": delegated,
            "own_projects": own_projects,
        })

    return jsonify(users)


# ---------------------------------------------------------------------------
# Notes API
# ---------------------------------------------------------------------------

@app.route("/notes/<int:task_id>", methods=["GET"])
def get_notes(task_id):
    if require_visible_task(task_id) is None:
        return {"error": "Task non trovato"}, 404
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

    if require_visible_task(task_id) is None:
        return {"error": "Task non trovato"}, 404

    # il nome utente accanto alla data serve a distinguere chi ha scritto cosa quando più
    # persone (committente/esecutore di un task delegato) leggono e scrivono le stesse note
    stamped_text = f"[{datetime.now().strftime('%d/%m/%Y %H:%M:%S')} {current_username()}] {text.strip()}"

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

    if get_visible_note(note_id) is None:
        return {"error": "Nota non trovata"}, 404

    execute_db(
        "UPDATE notes SET text = ?, updated_at = datetime('now', 'localtime') WHERE id = ?",
        (text, note_id),
    )
    return {"status": "ok"}


@app.route("/tasks/<int:task_id>/notes-subtree", methods=["GET"])
def get_notes_subtree(task_id):
    if require_visible_task(task_id) is None:
        return {"error": "Task non trovato"}, 404
    rows = query_db(
        """
        WITH RECURSIVE subtree(id, owner_id) AS (
            SELECT id, owner_id FROM tasks WHERE id = ?
            UNION ALL
            SELECT t.id, t.owner_id FROM tasks t
            JOIN subtree s ON t.parent_id = s.id
            -- si ferma ai confini di ownership: un nodo delegato può avere discendenti
            -- di un altro owner (creati dall'esecutore), mai visibili a chi ha chiesto
            -- il sottoalbero se non è lui stesso quell'owner
            WHERE s.owner_id = ?
        )
        SELECT n.id, n.task_id, n.note_date, n.text, n.updated_at
        FROM notes n
        JOIN subtree s ON n.task_id = s.id
        ORDER BY n.note_date
        """,
        [task_id, current_user_id()],
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
    if require_owned_task(task_id) is None:
        return {"error": "Task non trovato"}, 404
    rows = query_db("SELECT * FROM checklist_items WHERE task_id = ?", [task_id])
    return jsonify(rows)


@app.route("/tasks/<int:task_id>/checklist", methods=["POST"])
def add_checklist_item(task_id):
    task = require_owned_task(task_id)
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
        if execution_date and deadline and deadline < execution_date:
            raise ValueError("La deadline non può essere precedente alla data di esecuzione")
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
    item = get_owned_checklist_item(item_id)
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
        if execution_date and deadline and deadline < execution_date:
            raise ValueError("La deadline non può essere precedente alla data di esecuzione")
    except ValueError as e:
        return {"error": str(e)}, 400

    if not fields:
        return {"error": "Nessun campo da aggiornare"}, 400

    set_clause = ", ".join(f"{key} = ?" for key in fields)
    execute_db(f"UPDATE checklist_items SET {set_clause} WHERE id = ?", (*fields.values(), item_id))
    return {"status": "ok"}


@app.route("/checklist/<int:item_id>", methods=["DELETE"])
def delete_checklist_item(item_id):
    if get_owned_checklist_item(item_id) is None:
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
    parent = require_owned_task(task_id)
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

            # a differenza di prima, qui NON si riempie più nulla con "oggi": se l'utente
            # non ha specificato nessuna delle due date sulla riga della checklist, la
            # foglia risultante le eredita entrambe vuote e ricade naturalmente in IN LISTA
            # (compute_open_status) — è la stessa identica logica già usata dalla finestra
            # di configurazione per non forzare mai una data non specificata dall'utente.
            # Se è specificata solo una delle due, l'altra si ricava a ±7 giorni da quella
            # (mai calcolata a partire da "oggi"): stessa finestra di una settimana usata
            # anche altrove nell'app per questo tipo di scarto EX/DL.
            if execution_date is not None and deadline is None:
                deadline = (date.fromisoformat(execution_date) + timedelta(days=7)).isoformat()
            elif deadline is not None and execution_date is None:
                execution_date = (date.fromisoformat(deadline) - timedelta(days=7)).isoformat()

            fields = {}
            if item["completed"]:
                label, status = "CHIUSO", STATUS_COMPLETATO
            else:
                label, status = "APERTO", None
                execution_date = enforce_open_task_rules(fields, execution_date, deadline, assegnato, [])

            statements.append((
                """
                INSERT INTO tasks (parent_id, owner_id, title, deadline, execution_date, assegnato, label, status)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (task_id, current_user_id(), title, deadline, execution_date, assegnato, label, status),
            ))
            statements.append(("DELETE FROM checklist_items WHERE id = ?", (item["id"],)))
    except ValueError as e:
        return {"error": str(e)}, 400

    # una foglia che diventa nodo padre perde status/focus/label e le sue dipendenze
    if parent["children_count"] == 0:
        statements.append((
            "UPDATE tasks SET status = NULL, focus = 0, label = NULL, assegnato = NULL, estimated_days = NULL WHERE id = ?",
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


# ---------------------------------------------------------------------------
# Pianificazione oraria (lavagna usa-e-getta a blocchi di 15 minuti, scorrelata
# da status/EX/DL: solo un riferimento leggero per la giornata, mai uno storico)
# ---------------------------------------------------------------------------

@app.route("/planning", methods=["GET"])
def get_planning_blocks():
    # cancellazione "pigra" del passato: basta aprire/ricaricare la vista perché
    # i blocchi di giorni già trascorsi spariscano, nessun cron necessario
    execute_db("DELETE FROM planning_blocks WHERE day < date('now', 'localtime')")
    rows = query_db(
        """
        SELECT pb.* FROM planning_blocks pb JOIN tasks t ON t.id = pb.task_id
        WHERE t.owner_id = ?
        ORDER BY pb.day, pb.start_min
        """,
        [current_user_id()],
    )
    return jsonify(rows)


@app.route("/planning", methods=["POST"])
def create_planning_block():
    data = request.get_json() or {}
    task_id = data.get("task_id")
    task = require_owned_task(task_id) if task_id is not None else None
    if task is None:
        return {"error": "Task non trovato"}, 404
    if task["children_count"] > 0:
        return {"error": "La pianificazione è disponibile solo sulle foglie"}, 409

    try:
        day = validate_date(data.get("day"), "Giorno")
        if not day:
            raise ValueError("Giorno mancante")
        start_min = validate_minutes(data.get("start_min"), "Inizio")
        end_min = validate_minutes(data.get("end_min"), "Fine")
        if end_min <= start_min:
            raise ValueError("La fine deve essere successiva all'inizio")
    except ValueError as e:
        return {"error": str(e)}, 400

    new_id = execute_db(
        "INSERT INTO planning_blocks (task_id, day, start_min, end_min) VALUES (?, ?, ?, ?)",
        (task_id, day, start_min, end_min),
    )
    block = query_one("SELECT * FROM planning_blocks WHERE id = ?", [new_id])
    return jsonify(block), 201


@app.route("/planning/<int:block_id>", methods=["PUT"])
def update_planning_block(block_id):
    block = get_owned_planning_block(block_id)
    if block is None:
        return {"error": "Blocco non trovato"}, 404

    data = request.get_json() or {}
    fields = {}
    try:
        if "day" in data:
            day = validate_date(data["day"], "Giorno")
            if not day:
                raise ValueError("Giorno mancante")
            fields["day"] = day
        if "start_min" in data:
            fields["start_min"] = validate_minutes(data["start_min"], "Inizio")
        if "end_min" in data:
            fields["end_min"] = validate_minutes(data["end_min"], "Fine")

        start_min = fields.get("start_min", block["start_min"])
        end_min = fields.get("end_min", block["end_min"])
        if end_min <= start_min:
            raise ValueError("La fine deve essere successiva all'inizio")
    except ValueError as e:
        return {"error": str(e)}, 400

    if not fields:
        return {"error": "Nessun campo da aggiornare"}, 400

    set_clause = ", ".join(f"{key} = ?" for key in fields)
    execute_db(f"UPDATE planning_blocks SET {set_clause} WHERE id = ?", (*fields.values(), block_id))
    return {"status": "ok"}


@app.route("/planning/<int:block_id>", methods=["DELETE"])
def delete_planning_block(block_id):
    if get_owned_planning_block(block_id) is None:
        return {"error": "Blocco non trovato"}, 404
    execute_db("DELETE FROM planning_blocks WHERE id = ?", (block_id,))
    return "", 204


if __name__ == "__main__":
    app.run(debug=True)
