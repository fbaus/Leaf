// Vista "Carico di lavoro" (Fase 5): elenco degli utenti registrati con, per ciascuno, il
// numero di task delegati aperti e il carico di lavoro odierno (somma percentuale). Espandendo
// un utente si vede il dettaglio dei singoli task (delegati a lui, o progetti con codice
// creati da lui) con Avanzamento/Carico di lavoro/Status dal punto di vista dell'esecutore.
// Scopo: valutare il carico di un collega prima di assegnargli un nuovo task — per questo è
// l'unica vista che mostra dati di utenti diversi dal proprio (solo task con un codice
// progetto aziendale: i personali restano privati come ovunque nell'app).
import { state, rerender } from "./state.js";
import { GRANULARITIES } from "./timeline.js";
import { renderWorkloadChart, colorForIndex } from "./render_workload_chart.js";

function fmtPercent(value) {
  return value === null || value === undefined ? "—" : `${value}%`;
}

function allEntriesOf(user) {
  return [...user.delegated, ...user.own_projects];
}

// ---------------------------------------------------------------------------
// Elenco utenti espandibile (vista di default)
// ---------------------------------------------------------------------------

// Status ed Esecutore non compaiono: lo Status non ha senso su un progetto (solo le sue
// foglie ne hanno uno, vedi domain rules), e l'Esecutore è per costruzione sempre l'utente
// di questa riga (vedi entries_by_executor/own_projects_by_owner in get_workload)
const DETAIL_COLUMNS = [
  { key: "project_code", label: "Progetto" },
  { key: "title", label: "Titolo" },
  { key: "avanzamento", label: "Avanzamento", fmt: fmtPercent },
  { key: "carico_lavoro", label: "Carico di lavoro", fmt: fmtPercent },
  { key: "committente_username", label: "Committente" },
  { key: "execution_date", label: "Data esecuzione" },
  { key: "deadline", label: "Deadline" },
];

// sottoinsieme di `entries` con la spunta "grafico" attiva, nello stesso ordine in cui
// compaiono nella tabella: determina sia il colore sovrapposto nel grafico (colorForIndex)
// sia quello con cui il titolo si evidenzia nella riga corrispondente qui sotto
function checkedEntriesOf(entries) {
  return entries.filter((e) => state.workloadCheckedEntryIds.has(e.id));
}

function renderDetailTable(entries, checked) {
  const colorIndexById = new Map(checked.map((e, i) => [e.id, i]));

  const table = document.createElement("table");
  table.className = "workload-detail-table";
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");

  const thCheck = document.createElement("th");
  const selectAll = document.createElement("input");
  selectAll.type = "checkbox";
  selectAll.title = "Sovrapponi/rimuovi il grafico di tutti i progetti di questo utente";
  selectAll.checked = entries.length > 0 && entries.every((e) => state.workloadCheckedEntryIds.has(e.id));
  selectAll.onchange = () => {
    entries.forEach((e) => {
      if (selectAll.checked) state.workloadCheckedEntryIds.add(e.id);
      else state.workloadCheckedEntryIds.delete(e.id);
    });
    rerender();
  };
  thCheck.appendChild(selectAll);
  headRow.appendChild(thCheck);

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

    const tdCheck = document.createElement("td");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.title = "Sovrapponi il grafico di questo progetto a quello globale";
    checkbox.checked = state.workloadCheckedEntryIds.has(entry.id);
    checkbox.onchange = () => {
      if (checkbox.checked) state.workloadCheckedEntryIds.add(entry.id);
      else state.workloadCheckedEntryIds.delete(entry.id);
      rerender();
    };
    tdCheck.appendChild(checkbox);
    tr.appendChild(tdCheck);

    DETAIL_COLUMNS.forEach((col) => {
      const td = document.createElement("td");
      const raw = entry[col.key];
      td.textContent = col.fmt ? col.fmt(raw) : raw || "—";
      if (col.key === "title" && colorIndexById.has(entry.id)) {
        td.style.color = colorForIndex(colorIndexById.get(entry.id));
        td.style.fontWeight = "bold";
      }
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
      const checked = checkedEntriesOf(entries);

      // il grafico storico non è sempre visibile: si apre a parte, con un secondo bottone
      // freccia indipendente dall'espansione della riga utente (stesso stile del ▶/▼ sopra)
      const chartExpanded = state.expandedWorkloadChartUserIds.has(user.id);
      const chartToggleRow = document.createElement("div");
      chartToggleRow.className = "workload-chart-toggle-row";
      const chartToggle = document.createElement("button");
      chartToggle.className = "toggle-btn";
      chartToggle.textContent = chartExpanded ? "▼" : "▶";
      chartToggle.onclick = () => {
        if (chartExpanded) state.expandedWorkloadChartUserIds.delete(user.id);
        else state.expandedWorkloadChartUserIds.add(user.id);
        rerender();
      };
      chartToggleRow.appendChild(chartToggle);
      const chartToggleLabel = document.createElement("span");
      chartToggleLabel.className = "workload-chart-toggle-label";
      chartToggleLabel.textContent = "Grafico storico";
      chartToggleRow.appendChild(chartToggleLabel);
      wrapper.appendChild(chartToggleRow);

      if (chartExpanded) {
        wrapper.appendChild(renderWorkloadChart(entries, checked, state.workloadGranularity));
      }

      wrapper.appendChild(renderDetailTable(entries, checked));
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
// Rendering
// ---------------------------------------------------------------------------

function renderToolbar(mainPanel) {
  const bar = document.createElement("div");
  bar.className = "leaf-filter-bar";

  // granularità dei grafici storici (render_workload_chart.js), condivisa da tutti gli
  // utenti espansi
  const granGroup = document.createElement("div");
  granGroup.className = "workload-chart-toolbar";
  GRANULARITIES.forEach(({ key, label }) => {
    const btn = document.createElement("button");
    btn.className = "filter-group-btn";
    btn.classList.toggle("active", state.workloadGranularity === key);
    btn.textContent = label;
    btn.onclick = () => {
      state.workloadGranularity = key;
      rerender();
    };
    granGroup.appendChild(btn);
  });
  bar.appendChild(granGroup);

  mainPanel.appendChild(bar);
}

export function renderWorkload(mainPanel) {
  renderToolbar(mainPanel);
  renderUserList(mainPanel);
}
