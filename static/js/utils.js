// 1 ATTIVO, 2 IN RITARDO, 3 BLOCCATO, 4 PIANIFICATO, 5 DIPENDENTE,
// 6 DELEGATO, 7 IN LISTA, 8 QUARANTENA, 9 COMPLETATO, 10 INTERROTTO
export const STATUS_META = {
  1: { symbol: "⬤", color: "#2e7d32", label: "Attivo" },
  2: { symbol: "⏰", color: "#c62828", label: "In ritardo" },
  3: { symbol: "⛔", color: "#ef6c00", label: "Bloccato" },
  4: { symbol: "📅", color: "#1565c0", label: "Pianificato" },
  5: { symbol: "🔗", color: "#6a1b9a", label: "Dipendente" },
  6: { symbol: "👤", color: "#8e24aa", label: "Delegato" },
  7: { symbol: "⏸", color: "#757575", label: "In lista" },
  8: { symbol: "🔍", color: "#f9a825", label: "Quarantena" },
  9: { symbol: "✔", color: "#1b5e20", label: "Completato" },
  10: { symbol: "✖", color: "#424242", label: "Interrotto" },
};

export const STATUS_ORDER = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

export const CLOSED_STATUSES = new Set([8, 9, 10]);

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
  if (criterion === "assegnato") {
    return assegnatoSortKey(a.assegnato).localeCompare(assegnatoSortKey(b.assegnato));
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

export function makeBadge(symbol, title, color, className = "extra-badge") {
  const span = document.createElement("span");
  span.className = className;
  span.textContent = symbol;
  span.title = title;
  if (color) span.style.color = color;
  return span;
}

export function extraBadges(node) {
  const frag = document.createDocumentFragment();
  if (node.urgent) frag.appendChild(makeBadge("❗", "Urgente"));
  return frag;
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
