import { state, reload, rerender } from "./state.js";
import {
  buildTree,
  isLeaf,
  matchesSearch,
  STATUS_META,
  BLOCKING_STATUSES,
  makeBadge,
  extraBadges,
} from "./utils.js";
import { deleteTask, setFocus } from "./api.js";
import { openCreateModal, openEditModal } from "./modal.js";

function subtreeMatches(node, searchText) {
  if (matchesSearch(node, searchText)) return true;
  return node.children.some((c) => subtreeMatches(c, searchText));
}

function statusBadge(node) {
  if (node.status) {
    const meta = STATUS_META[node.status];
    return makeBadge(meta.symbol, meta.label, meta.color, "status-badge");
  }
  return makeBadge("○", "Nessuno status", "#999", "status-badge");
}

// nodo stesso + tutti i discendenti che hanno a loro volta figli
// (sono gli unici id il cui stato in expandedIds ha effetto visivo)
function collectExpandableIds(node) {
  if (node.children.length === 0) return [];
  const ids = [node.id];
  node.children.forEach((child) => {
    ids.push(...collectExpandableIds(child));
  });
  return ids;
}

function branchToggleButton(node) {
  const branchIds = collectExpandableIds(node);
  const allExpanded = branchIds.every((id) => state.expandedIds.has(id));

  const btn = document.createElement("button");
  btn.className = "branch-toggle-btn";
  btn.textContent = allExpanded ? "⊖" : "⊕";
  btn.title = allExpanded ? "Collassa tutti i discendenti" : "Espandi tutti i discendenti";
  btn.onclick = () => {
    if (allExpanded) {
      branchIds.forEach((id) => state.expandedIds.delete(id));
    } else {
      branchIds.forEach((id) => state.expandedIds.add(id));
    }
    rerender();
  };
  return btn;
}

function renderNode(node, searchText) {
  const li = document.createElement("li");
  li.dataset.nodeId = node.id;

  const row = document.createElement("div");
  row.className = "tree-row";
  if (state.scrollToNodeId === node.id) row.classList.add("highlight");

  const hasChildren = node.children.length > 0;
  let childrenUl = null;

  if (hasChildren) {
    const toggle = document.createElement("button");
    toggle.className = "toggle-btn";
    const expanded = state.expandedIds.has(node.id);
    toggle.textContent = expanded ? "▼" : "▶";

    childrenUl = document.createElement("ul");
    childrenUl.className = "tree-children";
    childrenUl.style.display = expanded ? "block" : "none";

    toggle.onclick = () => {
      const isExpanded = state.expandedIds.has(node.id);
      if (isExpanded) state.expandedIds.delete(node.id);
      else state.expandedIds.add(node.id);
      childrenUl.style.display = isExpanded ? "none" : "block";
      toggle.textContent = isExpanded ? "▶" : "▼";
    };
    row.appendChild(toggle);
  } else {
    const spacer = document.createElement("span");
    spacer.className = "toggle-spacer";
    row.appendChild(spacer);
  }

  // stesso slot per entrambi: badge di status per le foglie,
  // bottone espandi/collassa ramo per i nodi con figli (li tiene allineati)
  row.appendChild(hasChildren ? branchToggleButton(node) : statusBadge(node));

  const title = document.createElement("span");
  title.className = "node-title";
  title.title = "Clicca per leggere/scrivere le note di questo nodo";
  if (state.selectedNoteNodeId === node.id) title.classList.add("selected-node");
  title.textContent = node.title;
  title.onclick = () => {
    state.selectedNoteNodeId = node.id;
    rerender();
  };
  row.appendChild(title);

  row.appendChild(extraBadges(node));

  const noteBtn = document.createElement("button");
  noteBtn.textContent = "📝";
  noteBtn.title = "Scrivi una nota";
  noteBtn.onclick = () => {
    state.selectedNoteNodeId = node.id;
    state.focusNewNoteInput = true;
    rerender();
  };
  row.appendChild(noteBtn);

  if (isLeaf(node)) {
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
    row.appendChild(focusBtn);
  }

  const canAddChild = hasChildren || !node.status || !BLOCKING_STATUSES.has(node.status);
  const addBtn = document.createElement("button");
  addBtn.textContent = "+";
  addBtn.title = "Aggiungi sotto-attività";
  addBtn.disabled = !canAddChild;
  addBtn.onclick = () => openCreateModal(node.id);
  row.appendChild(addBtn);

  const editBtn = document.createElement("button");
  editBtn.textContent = "⚙";
  editBtn.title = "Configura";
  editBtn.onclick = () => openEditModal(node);
  row.appendChild(editBtn);

  const delBtn = document.createElement("button");
  delBtn.textContent = "🗑";
  delBtn.onclick = async () => {
    const ok = confirm("Eliminare questo task e tutte le sotto-attività?");
    if (!ok) return;
    try {
      await deleteTask(node.id);
      await reload();
    } catch (err) {
      alert(err.message);
    }
  };
  row.appendChild(delBtn);

  li.appendChild(row);

  if (childrenUl) {
    node.children
      .filter((c) => !searchText || subtreeMatches(c, searchText))
      .forEach((c) => childrenUl.appendChild(renderNode(c, searchText)));
    li.appendChild(childrenUl);
  }

  return li;
}

export function renderTree(container) {
  const searchText = state.searchText.trim();
  const tree = buildTree(state.tasks);

  if (searchText) {
    const expandForSearch = (nodes) => {
      nodes.forEach((n) => {
        if (n.children.length > 0 && subtreeMatches(n, searchText)) {
          state.expandedIds.add(n.id);
        }
        expandForSearch(n.children);
      });
    };
    expandForSearch(tree);
  }

  const ul = document.createElement("ul");
  ul.className = "tree-root";
  tree
    .filter((n) => !searchText || subtreeMatches(n, searchText))
    .forEach((n) => ul.appendChild(renderNode(n, searchText)));

  container.appendChild(ul);

  if (state.scrollToNodeId) {
    const el = container.querySelector(`[data-node-id="${state.scrollToNodeId}"]`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      const idToClear = state.scrollToNodeId;
      setTimeout(() => {
        if (state.scrollToNodeId === idToClear) state.scrollToNodeId = null;
      }, 2000);
    }
  }
}
