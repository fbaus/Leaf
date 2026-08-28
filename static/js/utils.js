export const STATUS_META = {
  ATTIVO: { symbol: "●", color: "#2e7d32", label: "Attivo" },
  BLOCCATO: { symbol: "⛔", color: "#c62828", label: "Bloccato" },
  PIANIFICATO: { symbol: "📅", color: "#1565c0", label: "Pianificato" },
  DELEGATO: { symbol: "👤", color: "#6a1b9a", label: "Delegato" },
  "IN ATTESA": { symbol: "⏳", color: "#ef6c00", label: "In attesa" },
  ACCANTONATO: { symbol: "⏸", color: "#757575", label: "Accantonato" },
  "DA VALUTARE": { symbol: "❓", color: "#f9a825", label: "Da valutare" },
  COMPLETATO: { symbol: "✔", color: "#1b5e20", label: "Completato" },
  INTERROTTO: { symbol: "✖", color: "#424242", label: "Interrotto" },
};

export const STATUS_ORDER = Object.keys(STATUS_META);

export const BLOCKING_STATUSES = new Set(["BLOCCATO", "DELEGATO", "COMPLETATO", "INTERROTTO"]);

export const STATUS_GROUPS = {
  FOCUS: null,
  OPERATIVE: ["ATTIVO", "BLOCCATO"],
  PROGRAMMATE: ["PIANIFICATO", "DELEGATO"],
  APERTE: ["ATTIVO", "BLOCCATO", "PIANIFICATO", "DELEGATO", "IN ATTESA"],
  "DA SEGUIRE": ["IN ATTESA", "DA VALUTARE"],
  TUTTE: null,
};

export function isLeaf(node) {
  return node.children_count === 0;
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

export function matchesSearch(node, text) {
  if (!text) return true;
  const needle = text.toLowerCase();
  const title = (node.title || "").toLowerCase();
  const desc = (node.description || "").toLowerCase();
  return title.includes(needle) || desc.includes(needle);
}

function dateSortKey(value) {
  return value ? value : "9999-99-99";
}

export const SORT_LABELS = {
  padre: "Padre",
  deadline: "Deadline",
  execution_date: "Data di esecuzione",
  status: "Status",
};

const ALL_SORT_CRITERIA = ["padre", "deadline", "execution_date", "status"];

function compareBy(criterion, a, b, tasksById) {
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
  return 0;
}

export function sortRows(list, tasksById, primary = "padre") {
  const sequence = [primary, ...ALL_SORT_CRITERIA.filter((c) => c !== primary)];
  return [...list].sort((a, b) => {
    for (const criterion of sequence) {
      const cmp = compareBy(criterion, a, b, tasksById);
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

export function matchesStatusGroup(node, groupKey) {
  if (groupKey === "FOCUS") return !!node.focus;
  if (groupKey === "TUTTE") return true;
  const group = STATUS_GROUPS[groupKey];
  return !!node.status && group.includes(node.status);
}
