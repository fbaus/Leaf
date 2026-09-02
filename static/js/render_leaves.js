import { state, reload, rerender } from "./state.js";
import {
  isLeaf,
  byId,
  rootTitle,
  truncate,
  STATUS_META,
  STATUS_GROUPS,
  matchesStatusGroup,
  sortRows,
  rootIdOf,
  SORT_LABELS,
  sortableHeader,
  makeBadge,
} from "./utils.js";
import { setFocus, fetchAncestors } from "./api.js";
import { openEditModal } from "./modal.js";

function getRootNodes(tasks) {
  return tasks.filter((t) => t.parent_id === null);
}

function isRootIncluded(rootId) {
  return state.leafFilters.rootIds === null || state.leafFilters.rootIds.has(rootId);
}

async function jumpToTree(nodeId) {
  const ancestorIds = await fetchAncestors(nodeId);
  ancestorIds.forEach((id) => state.expandedIds.add(id));
  state.currentView = "albero";
  state.scrollToNodeId = nodeId;
  rerender();
}

function renderFilterBar(mainPanel) {
  const bar = document.createElement("div");
  bar.className = "leaf-filter-bar";
  Object.keys(STATUS_GROUPS).forEach((groupKey) => {
    const btn = document.createElement("button");
    btn.textContent = groupKey;
    btn.className = "filter-group-btn";
    btn.classList.toggle("active", state.leafFilters.statusGroup === groupKey);
    btn.onclick = () => {
      state.leafFilters.statusGroup = groupKey;
      rerender();
    };
    bar.appendChild(btn);
  });
  mainPanel.appendChild(bar);
}

// percentuali (sommano a 100): progetto, titolo, status, focus, descrizione, deadline, esecuzione, azioni
const COLUMN_WIDTHS = [13, 16, 12, 5, 29, 9, 12, 4];

function renderColgroup(table) {
  const colgroup = document.createElement("colgroup");
  COLUMN_WIDTHS.forEach((width) => {
    const col = document.createElement("col");
    col.style.width = `${width}%`;
    colgroup.appendChild(col);
  });
  table.appendChild(colgroup);
}

function renderTable(mainPanel, tasksById) {
  let leaves = state.tasks.filter(isLeaf);
  leaves = leaves.filter((n) => matchesStatusGroup(n, state.leafFilters.statusGroup));
  leaves = leaves.filter((n) => isRootIncluded(rootIdOf(n, tasksById)));
  leaves = sortRows(leaves, tasksById, state.leafFilters.sortBy);

  const table = document.createElement("table");
  table.className = "leaves-table";
  renderColgroup(table);

  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  const onSort = (key) => {
    state.leafFilters.sortBy = key;
    rerender();
  };
  headRow.appendChild(sortableHeader(SORT_LABELS.padre, "padre", state.leafFilters.sortBy, onSort));
  headRow.appendChild(document.createElement("th")).textContent = "Titolo";
  headRow.appendChild(sortableHeader(SORT_LABELS.status, "status", state.leafFilters.sortBy, onSort));
  headRow.appendChild(document.createElement("th")).textContent = "Focus";
  headRow.appendChild(document.createElement("th")).textContent = "Descrizione";
  headRow.appendChild(sortableHeader(SORT_LABELS.deadline, "deadline", state.leafFilters.sortBy, onSort));
  headRow.appendChild(
    sortableHeader(SORT_LABELS.execution_date, "execution_date", state.leafFilters.sortBy, onSort)
  );
  headRow.appendChild(document.createElement("th"));
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  leaves.forEach((node) => {
    const tr = document.createElement("tr");

    const tdParent = document.createElement("td");
    tdParent.textContent = rootTitle(node, tasksById);
    tr.appendChild(tdParent);

    const tdTitle = document.createElement("td");
    tdTitle.textContent = node.title;
    tdTitle.className = "leaf-title-cell";
    tdTitle.title = "Vai nell'albero";
    tdTitle.onclick = () => jumpToTree(node.id);
    tr.appendChild(tdTitle);

    const tdStatus = document.createElement("td");
    if (node.status) {
      const meta = STATUS_META[node.status];
      tdStatus.textContent = `${meta.symbol} ${meta.label}`;
      tdStatus.style.color = meta.color;
    } else {
      tdStatus.textContent = "—";
    }
    tr.appendChild(tdStatus);

    const tdFocus = document.createElement("td");
    const focusBtn = document.createElement("button");
    focusBtn.textContent = node.focus ? "🎯" : "○";
    focusBtn.title = node.focus ? "Disattiva focus" : "Attiva focus";
    focusBtn.onclick = async () => {
      try {
        await setFocus(node.id, !node.focus);
        await reload();
      } catch (err) {
        alert(err.message);
      }
    };
    tdFocus.appendChild(focusBtn);
    tr.appendChild(tdFocus);

    const tdDesc = document.createElement("td");
    tdDesc.textContent = truncate(node.description, 60);
    tr.appendChild(tdDesc);

    const tdDeadline = document.createElement("td");
    tdDeadline.append(node.deadline || "—");
    if (node.expired) tdDeadline.appendChild(makeBadge("⚠", "Scaduto"));
    tr.appendChild(tdDeadline);

    const tdExecutionDate = document.createElement("td");
    tdExecutionDate.append(node.execution_date || "—");
    if (node.reminder) tdExecutionDate.appendChild(makeBadge("🔔", "Promemoria"));
    tr.appendChild(tdExecutionDate);

    const tdActions = document.createElement("td");
    const editBtn = document.createElement("button");
    editBtn.textContent = "⚙";
    editBtn.onclick = () => openEditModal(node);
    tdActions.appendChild(editBtn);
    tr.appendChild(tdActions);

    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  mainPanel.appendChild(table);
}

function renderChecklist(sidePanel) {
  const box = document.createElement("div");
  box.className = "root-checklist";

  const heading = document.createElement("h3");
  heading.textContent = "Progetti";
  box.appendChild(heading);

  getRootNodes(state.tasks).forEach((root) => {
    const label = document.createElement("label");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = isRootIncluded(root.id);
    checkbox.onchange = () => {
      if (state.leafFilters.rootIds === null) {
        state.leafFilters.rootIds = new Set(getRootNodes(state.tasks).map((t) => t.id));
      }
      if (checkbox.checked) state.leafFilters.rootIds.add(root.id);
      else state.leafFilters.rootIds.delete(root.id);
      rerender();
    };
    label.appendChild(checkbox);
    label.appendChild(document.createTextNode(" " + root.title));
    box.appendChild(label);
  });

  sidePanel.appendChild(box);
}

export function renderLeaves(mainPanel, sidePanel) {
  const tasksById = byId(state.tasks);
  renderFilterBar(mainPanel);
  renderTable(mainPanel, tasksById);
  renderChecklist(sidePanel);
}
