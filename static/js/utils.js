// 1 ATTIVO, 2 IN RITARDO, 3 BLOCCATO, 4 PIANIFICATO, 5 DIPENDENTE,
// 6 DELEGATO, 7 IN LISTA, 8 QUARANTENA, 9 COMPLETATO, 10 INTERROTTO
export const STATUS_META = {
  1: { symbol: "⬤", color: "#2cce34", label: "Attivo" },
  2: { symbol: "⏰", color: "#c62828", label: "In ritardo" },
  3: { symbol: "⛔", color: "#ef6c00", label: "Bloccato" },
  4: { symbol: "📅", color: "#1565c0", label: "Pianificato" },
  5: { symbol: "🔗", color: "#de6be2", label: "Dipendente" },
  6: { symbol: "👤", color: "#8e24aa", label: "Delegato" },
  7: { symbol: "⏸", color: "#757575", label: "In lista" },
  8: { symbol: "🔍", color: "#f9a825", label: "Quarantena" },
  9: { symbol: "✔", color: "#41e9d8", label: "Completato" },
  10: { symbol: "✖", color: "#424242", label: "Interrotto" },
};

// DIPENDENTE (5) prima di PIANIFICATO (4): solo il rango d'ordinamento, non l'ID di
// status né colore/simbolo/etichetta (che restano in STATUS_META, legati al numero)
export const STATUS_ORDER = [1, 2, 3, 5, 4, 6, 7, 8, 9, 10];

export const CLOSED_STATUSES = new Set([8, 9, 10]);

export const STATUS_IN_LISTA = 7;

export const STATUS_GROUPS = {
  FOCUS: null,
  OPERATIVE: [1, 2, 3, 5],
  PROGRAMMATE: [4, 5, 6],
  APERTE: [1, 2, 3, 4, 5, 6, 7],
  "DA VALUTARE": [8],
  TUTTE: null,
};

export function isLeaf(node) {
  return node.children_count === 0;
}

// per il committente, un task delegato resta "quella foglia" anche se l'esecutore lo
// trasforma in un ramo: i figli reali (di un altro owner) non gli sono comunque mai
// visibili, quindi in Vista Foglie deve continuare a comparire come lavorabile invece di
// sparire perché ha strutturalmente guadagnato dei figli — vedi lo status DELEGATO/IN
// RITARDO che il backend gli assegna in questo stesso caso (app.py, GET /tasks)
export function isLeafForViewer(node, currentUserId) {
  if (isLeaf(node)) return true;
  return node.committente_user_id === currentUserId && node.executor_user_id != null;
}

// una dipendenza (foglia diretta, o foglia dentro un ramo dipendenza) conta come "aperta"
// solo se non è in uno stato chiuso — le stesse regole di STATUS_GROUPS.APERTE
export function isOpenLeaf(node) {
  return isLeaf(node) && !!node.status && !CLOSED_STATUSES.has(node.status);
}

// mappa parent_id -> figli diretti, usata per scendere ricorsivamente dentro un ramo
export function childrenIndex(tasks) {
  const map = {};
  tasks.forEach((t) => {
    if (t.parent_id !== null) {
      (map[t.parent_id] ??= []).push(t);
    }
  });
  return map;
}

// tutte le foglie "aperte" contenute (ricorsivamente) dentro un ramo — usata per decidere se
// mostrare/evidenziare una dipendenza verso un ramo in base al suo contenuto reale, non allo
// stato del ramo stesso (i rami non hanno status)
export function openLeafDescendants(branchNode, childrenByParent) {
  const result = [];
  const stack = [...(childrenByParent[branchNode.id] || [])];
  while (stack.length > 0) {
    const n = stack.pop();
    if (isLeaf(n)) {
      if (isOpenLeaf(n)) result.push(n);
    } else {
      stack.push(...(childrenByParent[n.id] || []));
    }
  }
  return result;
}

export function truncate(text, n) {
  if (!text) return "";
  return text.length > n ? text.slice(0, n) + "…" : text;
}

export function buildTree(tasks) {
  const map = {};
  const roots = [];
  tasks.forEach((t) => {
    map[t.id] = { ...t, children: [] };
  });
  tasks.forEach((t) => {
    if (t.parent_id !== null && map[t.parent_id]) {
      map[t.parent_id].children.push(map[t.id]);
    } else {
      roots.push(map[t.id]);
    }
  });
  return roots;
}

// un "ticket" del punto di vista di currentUserId: `ticket_owner_id` (a differenza di
// committente_user_id) è valorizzato una volta sola alla creazione e non torna mai NULL, in
// nessuno stato — pendente, accettato, rifiutato/interrotto (tornato "in bozza", riassegnabile),
// completato. Va quindi sempre escluso dall'Albero di chi l'ha creato (non è un suo progetto
// vero) e mostrato solo nella vista Ticket dedicata, in ogni stato — le due viste usano questo
// stesso helper per restare in sincrono.
export function isTicketOfMine(node, currentUserId) {
  return node.ticket_owner_id === currentUserId;
}

export function byId(tasks) {
  const map = {};
  tasks.forEach((t) => {
    map[t.id] = t;
  });
  return map;
}

export function rootIdOf(node, tasksById) {
  let current = node;
  while (current.parent_id !== null) {
    const parent = tasksById[current.parent_id];
    if (!parent) break;
    current = parent;
  }
  return current.id;
}

export function rootTitle(node, tasksById) {
  if (node.parent_id === null) return "—";
  const root = tasksById[rootIdOf(node, tasksById)];
  return root ? root.title : "—";
}

// il codice progetto vive solo sul nodo radice (mai copiato sui discendenti): un
// discendente lo "eredita" risalendo alla radice qui, stessa tecnica di rootTitle — così
// uno spostamento fra progetti aggiorna il codice effettivo senza dover propagare nulla
export function rootProjectCode(node, tasksById) {
  if (node.parent_id === null) return node.project_code || null;
  const root = tasksById[rootIdOf(node, tasksById)];
  return root ? root.project_code || null : null;
}

// testo per la colonna "Assegnato" (vista Foglie/Albero) che copre sia la delega esterna
// (testo libero, invariata) sia quella interna (che non valorizza mai `assegnato`, quindi
// deve essere derivato da committente/esecutore in base al punto di vista di chi guarda)
export function delegationCellText(node, currentUserId) {
  if (node.assegnato) return node.assegnato;
  if (node.executor_user_id == null) return null;
  const stato = node.delegation_status === "accettata" ? "accettata" : "in attesa";
  const suffix = node.completion_pending ? " — completamento da confermare" : "";
  if (node.executor_user_id === currentUserId) return `Da: ${node.committente_username} (${stato})${suffix}`;
  if (node.committente_user_id === currentUserId) return `A: ${node.executor_username} (${stato})${suffix}`;
  return null;
}

// 1 giornata lavorativa = 8 ore: solo una convenzione per convertire il campo "ore" (più
// comodo per stime brevi) nel valore in giorni che il backend salva e usa per il carico di
// lavoro — non c'entra con CAPACITA_PRODUTTIVA_MEDIA (quella è quanto di una giornata è
// davvero disponibile in media, questa è solo l'unità di misura dell'input)
export const ORE_PER_GIORNO = 8;

// scompone un estimated_days (unico valore, quello salvato/usato dal backend per il carico
// di lavoro) nei due campi "giorni"/"ore" del form — solo per la UI, arrotonda alla mezz'ora
// più vicina per evitare differenze illeggibili dovute ai decimali
export function splitEstimatedDays(value) {
  if (value == null) return { days: 0, hours: 0 };
  const totalHours = Math.round(value * ORE_PER_GIORNO * 2) / 2;
  const days = Math.floor(totalHours / ORE_PER_GIORNO);
  const hours = Math.round((totalHours - days * ORE_PER_GIORNO) * 10) / 10;
  return { days, hours };
}

// inverso di splitEstimatedDays: dai due campi del form al valore unico che il backend si
// aspetta — null se entrambi vuoti/zero (nessuna stima), come il vecchio campo singolo
export function combineEstimatedDays(daysValue, hoursValue) {
  const days = daysValue ? Number(daysValue) : 0;
  const hours = hoursValue ? Number(hoursValue) : 0;
  if (!days && !hours) return null;
  return days + hours / ORE_PER_GIORNO;
}

export function formatEstimatedDays(value) {
  if (value == null) return "—";
  const { days, hours } = splitEstimatedDays(value);
  const parts = [];
  if (days) parts.push(`${days}g`);
  if (hours) parts.push(`${hours}h`);
  return parts.length ? parts.join(" ") : "0g";
}

export function matchesSearch(node, text) {
  if (!text) return true;
  const needle = text.toLowerCase();
  const title = (node.title || "").toLowerCase();
  const desc = (node.description || "").toLowerCase();
  return title.includes(needle) || desc.includes(needle);
}

export function dateSortKey(value) {
  return value ? value : "9999-99-99";
}

export const SORT_LABELS = {
  padre: "Progetto",
  deadline: "Deadline",
  execution_date: "Data di esecuzione",
  status: "Status",
  assegnato: "Assegnato",
};

const ALL_SORT_CRITERIA = ["padre", "deadline", "execution_date", "status", "assegnato"];

function assegnatoSortKey(value) {
  return value || "￿";
}

function compareBy(criterion, a, b, tasksById, currentUserId) {
  if (criterion === "padre") {
    return rootTitle(a, tasksById).localeCompare(rootTitle(b, tasksById));
  }
  if (criterion === "deadline") {
    return dateSortKey(a.deadline).localeCompare(dateSortKey(b.deadline));
  }
  if (criterion === "execution_date") {
    return dateSortKey(a.execution_date).localeCompare(dateSortKey(b.execution_date));
  }
  if (criterion === "status") {
    const sa = a.status ? STATUS_ORDER.indexOf(a.status) : STATUS_ORDER.length;
    const sb = b.status ? STATUS_ORDER.indexOf(b.status) : STATUS_ORDER.length;
    return sa - sb;
  }
  if (criterion === "assegnato") {
    const ka = assegnatoSortKey(delegationCellText(a, currentUserId) || a.assegnato);
    const kb = assegnatoSortKey(delegationCellText(b, currentUserId) || b.assegnato);
    return ka.localeCompare(kb);
  }
  return 0;
}

// `secondaryDateField` ("execution_date" | "deadline" | null): sorting secondario scelto a
// mano dall'utente (bottoni EX/DL nella vista calendario di FOGLIE), applicato a tutti gli
// status subito dopo il criterio primario, prima degli altri tie-break di default
export function sortRows(list, tasksById, primary = "padre", secondaryDateField = null, currentUserId = null) {
  let sequence = [primary, ...ALL_SORT_CRITERIA.filter((c) => c !== primary)];
  if (secondaryDateField && secondaryDateField !== primary) {
    sequence = [primary, secondaryDateField, ...sequence.slice(1).filter((c) => c !== secondaryDateField)];
  }
  return [...list].sort((a, b) => {
    for (const criterion of sequence) {
      const cmp = compareBy(criterion, a, b, tasksById, currentUserId);
      if (cmp !== 0) return cmp;
    }
    return 0;
  });
}

export function sortableHeader(label, key, currentSort, onSortClick) {
  const th = document.createElement("th");
  th.textContent = label + " ";

  const btn = document.createElement("button");
  btn.className = "sort-btn" + (currentSort === key ? " active" : "");
  btn.textContent = currentSort === key ? "▲" : "⇅";
  btn.title = "Ordina per " + label;
  btn.onclick = () => onSortClick(key);
  th.appendChild(btn);

  return th;
}

export function makeBadge(symbol, title, color, className = "extra-badge") {
  const span = document.createElement("span");
  span.className = className;
  span.textContent = symbol;
  span.title = title;
  if (color) span.style.color = color;
  return span;
}

export function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text ?? "";
  return div.innerHTML;
}

export function matchesStatusGroup(node, groupKey) {
  if (groupKey === "FOCUS") return !!node.focus;
  if (groupKey === "TUTTE") return true;
  const group = STATUS_GROUPS[groupKey];
  return !!node.status && group.includes(node.status);
}
