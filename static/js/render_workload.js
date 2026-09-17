// Vista "Carico di lavoro" (Fase 5): elenco degli utenti registrati con, per ciascuno, il
// numero di task delegati aperti e il carico di lavoro odierno (somma percentuale). Espandendo
// un utente si vede il dettaglio dei singoli task (delegati a lui, o progetti con codice
// creati da lui) con Avanzamento/Carico di lavoro/Status dal punto di vista dell'esecutore.
// Scopo: valutare il carico di un collega prima di assegnargli un nuovo task — per questo è
// l'unica vista che mostra dati di utenti diversi dal proprio (solo task con un codice
// progetto aziendale: i personali restano privati come ovunque nell'app).
import { state, rerender } from "./state.js";
import { STATUS_META } from "./utils.js";
import { fetchWorkload } from "./api.js";
import { renderCalendarOverlay } from "./render_calendar.js";

function fmtPercent(value) {
  return value === null || value === undefined ? "—" : `${value}%`;
}

function statusText(status) {
  if (!status) return "—";
  const meta = STATUS_META[status];
  return meta ? `${meta.symbol} ${meta.label}` : "—";
}

function allEntriesOf(user) {
  return [...user.delegated, ...user.own_projects];
}

// ---------------------------------------------------------------------------
// Elenco utenti espandibile (vista di default)
// ---------------------------------------------------------------------------

const DETAIL_COLUMNS = [
  { key: "project_code", label: "Progetto" },
  { key: "title", label: "Titolo" },
  { key: "avanzamento", label: "Avanzamento", fmt: fmtPercent },
  { key: "carico_lavoro", label: "Carico di lavoro", fmt: fmtPercent },
  { key: "status", label: "Status", fmt: statusText },
  { key: "committente_username", label: "Committente" },
  { key: "executor_username", label: "Esecutore" },
  { key: "execution_date", label: "Data esecuzione" },
  { key: "deadline", label: "Deadline" },
];

function renderDetailTable(entries) {
  const table = document.createElement("table");
  table.className = "workload-detail-table";
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  DETAIL_COLUMNS.forEach((col) => {
    const th = document.createElement("th");
    th.textContent = col.label;
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  entries.forEach((entry) => {
    const tr = document.createElement("tr");
    DETAIL_COLUMNS.forEach((col) => {
      const td = document.createElement("td");
      const raw = entry[col.key];
      td.textContent = col.fmt ? col.fmt(raw) : raw || "—";
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  return table;
}

function renderUserRow(user) {
  const wrapper = document.createElement("div");
  wrapper.className = "workload-user";

  const row = document.createElement("div");
  row.className = "workload-user-row";

  const expanded = state.expandedWorkloadUserIds.has(user.id);
  const toggle = document.createElement("button");
  toggle.className = "toggle-btn";
  toggle.textContent = expanded ? "▼" : "▶";
  toggle.onclick = () => {
    if (expanded) state.expandedWorkloadUserIds.delete(user.id);
    else state.expandedWorkloadUserIds.add(user.id);
    rerender();
  };
  row.appendChild(toggle);

  const name = document.createElement("span");
  name.className = "workload-user-name";
  name.textContent = user.username;
  row.appendChild(name);

  const count = document.createElement("span");
  count.className = "workload-user-count";
  count.textContent = `${user.delegated_count} task delegati`;
  row.appendChild(count);

  const load = document.createElement("span");
  load.className = "workload-user-load";
  load.textContent = `Carico odierno: ${fmtPercent(user.workload_today)}`;
  row.appendChild(load);

  wrapper.appendChild(row);

  if (expanded) {
    const entries = allEntriesOf(user);
    if (entries.length === 0) {
      const empty = document.createElement("div");
      empty.className = "workload-empty";
      empty.textContent = "Nessun task aziendale delegato o progetto proprio con codice.";
      wrapper.appendChild(empty);
    } else {
      wrapper.appendChild(renderDetailTable(entries));
    }
  }

  return wrapper;
}

function renderUserList(mainPanel) {
  const list = document.createElement("div");
  list.className = "workload-user-list";
  state.workloadUsers.forEach((user) => list.appendChild(renderUserRow(user)));
  mainPanel.appendChild(list);
}

// ---------------------------------------------------------------------------
// Vista Calendario: tabella piatta di tutti i task (di tutti gli utenti) con colonna
// "Utente" in più, stessa infrastruttura del calendario di Vista Foglie (render_calendar.js)
// ---------------------------------------------------------------------------

const FLAT_COLUMN_WIDTHS = [10, 10, 20, 8, 8, 10, 10, 10, 7, 7];

function flatEntries() {
  const rows = [];
  state.workloadUsers.forEach((user) => {
    allEntriesOf(user).forEach((entry) => rows.push({ ...entry, username: user.username }));
  });
  return rows;
}

function renderFlatTable(mainPanel) {
  const rows = flatEntries();

  const table = document.createElement("table");
  table.className = "leaves-table workload-flat-table";

  const colgroup = document.createElement("colgroup");
  FLAT_COLUMN_WIDTHS.forEach((width) => {
    const col = document.createElement("col");
    col.style.width = `${width}%`;
    colgroup.appendChild(col);
  });
  table.appendChild(colgroup);

  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  ["Utente", "Progetto", "Titolo", "Avanzamento", "Carico di lavoro", "Status", "Committente", "Esecutore", "Data esecuzione", "Deadline"]
    .forEach((label) => {
      const th = document.createElement("th");
      th.textContent = label;
      headRow.appendChild(th);
    });
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  rows.forEach((entry) => {
    const tr = document.createElement("tr");
    const cells = [
      entry.username,
      entry.project_code || "—",
      entry.title,
      fmtPercent(entry.avanzamento),
      fmtPercent(entry.carico_lavoro),
      statusText(entry.status),
      entry.committente_username || "—",
      entry.executor_username || "—",
      entry.execution_date || "—",
      entry.deadline || "—",
    ];
    cells.forEach((c) => {
      const td = document.createElement("td");
      td.textContent = c;
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);

  mainPanel.appendChild(table);
  return rows;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderToolbar(mainPanel) {
  const bar = document.createElement("div");
  bar.className = "leaf-filter-bar";

  const calBtn = document.createElement("button");
  calBtn.className = "filter-group-btn";
  calBtn.classList.toggle("active", state.workloadCalendarOpen);
  calBtn.textContent = "📅 Calendario";
  calBtn.onclick = () => {
    state.workloadCalendarOpen = !state.workloadCalendarOpen;
    rerender();
  };
  bar.appendChild(calBtn);

  mainPanel.appendChild(bar);
}

export function renderWorkload(mainPanel) {
  renderToolbar(mainPanel);

  if (state.workloadCalendarOpen) {
    const rows = renderFlatTable(mainPanel);
    renderCalendarOverlay(mainPanel, rows, {
      minCol: 2, defaultCol: 5, maxCol: 7,
      hidePianificazione: true, hideDateSort: true,
      afterCommit: async () => {
        state.workloadUsers = await fetchWorkload();
        rerender();
      },
    });
  } else {
    renderUserList(mainPanel);
  }
}
