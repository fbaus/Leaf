import { state, rerender } from "./state.js";
import { byId, truncate, STATUS_META, sortRows, isLeaf, SORT_LABELS, rootTitle, sortableHeader } from "./utils.js";
import { openEditModal } from "./modal.js";

export function renderNodes(mainPanel) {
  const tasksById = byId(state.tasks);
  const nodes = sortRows(state.tasks, tasksById, state.nodeSortBy);

  const table = document.createElement("table");

  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  const onSort = (key) => {
    state.nodeSortBy = key;
    rerender();
  };
  headRow.appendChild(sortableHeader(SORT_LABELS.padre, "padre", state.nodeSortBy, onSort));
  headRow.appendChild(document.createElement("th")).textContent = "Titolo";
  headRow.appendChild(document.createElement("th")).textContent = "Descrizione";
  headRow.appendChild(sortableHeader(SORT_LABELS.deadline, "deadline", state.nodeSortBy, onSort));
  headRow.appendChild(
    sortableHeader(SORT_LABELS.execution_date, "execution_date", state.nodeSortBy, onSort)
  );
  headRow.appendChild(sortableHeader(SORT_LABELS.status, "status", state.nodeSortBy, onSort));
  headRow.appendChild(document.createElement("th"));
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  nodes.forEach((node) => {
    const tr = document.createElement("tr");

    const tdParent = document.createElement("td");
    tdParent.textContent = rootTitle(node, tasksById);
    tr.appendChild(tdParent);

    const tdTitle = document.createElement("td");
    tdTitle.textContent = node.title;
    tr.appendChild(tdTitle);

    const tdDesc = document.createElement("td");
    tdDesc.textContent = truncate(node.description, 20);
    tr.appendChild(tdDesc);

    const tdDeadline = document.createElement("td");
    tdDeadline.textContent = node.deadline || "—";
    tr.appendChild(tdDeadline);

    const tdExecutionDate = document.createElement("td");
    tdExecutionDate.textContent = node.execution_date || "—";
    tr.appendChild(tdExecutionDate);

    const tdStatus = document.createElement("td");
    if (isLeaf(node)) {
      if (node.status) {
        const meta = STATUS_META[node.status];
        tdStatus.textContent = `${meta.symbol} ${meta.label}`;
        tdStatus.style.color = meta.color;
      } else {
        tdStatus.textContent = "—";
      }
    }
    tr.appendChild(tdStatus);

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
