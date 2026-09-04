import { state, reload, rerender } from "./state.js";
import {
  buildTree,
  isLeaf,
  matchesSearch,
  STATUS_META,
  makeBadge,
  extraBadges,
} from "./utils.js";
import { deleteTask, setFocus, moveTask } from "./api.js";
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

// ---------------------------------------------------------------------------
// Drag & drop: sposta un nodo (e il suo sottoalbero) su un padre diverso
// ---------------------------------------------------------------------------

function collectDescendantIds(node) {
  const ids = [];
  node.children.forEach((child) => {
    ids.push(child.id, ...collectDescendantIds(child));
  });
  return ids;
}

let draggedNode = null;
let draggedDescendantIds = new Set();

async function performMove(newParentId) {
  if (draggedNode === null) return;
  try {
    await moveTask(draggedNode.id, newParentId);
    await reload();
  } catch (err) {
    alert(err.message);
  }
}

function attachDragHandlers(row, node) {
  row.draggable = true;

  row.addEventListener("dragstart", (e) => {
    draggedNode = node;
    draggedDescendantIds = new Set(collectDescendantIds(node));
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", String(node.id));
    row.classList.add("dragging");
  });

  row.addEventListener("dragend", () => {
    row.classList.remove("dragging");
    draggedNode = null;
    draggedDescendantIds = new Set();
  });

  row.addEventListener("dragover", (e) => {
    if (draggedNode === null) return;
    if (draggedNode.id === node.id || draggedDescendantIds.has(node.id)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    row.classList.add("drop-target");
  });

  row.addEventListener("dragleave", () => {
    row.classList.remove("drop-target");
  });

  row.addEventListener("drop", (e) => {
    e.preventDefault();
    e.stopPropagation();
    row.classList.remove("drop-target");
    if (draggedNode === null || draggedNode.id === node.id) return;
    performMove(node.id);
  });
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

// ---------------------------------------------------------------------------
// Menu contestuale (tasto destro sulla riga di un nodo)
// ---------------------------------------------------------------------------

let closeOpenMenu = null;

function closeContextMenu() {
  if (closeOpenMenu) {
    closeOpenMenu();
    closeOpenMenu = null;
  }
}

function showContextMenu(x, y, items) {
  closeContextMenu();

  const menu = document.createElement("div");
  menu.className = "context-menu";

  items.forEach((item) => {
    const btn = document.createElement("button");
    btn.textContent = item.label;
    btn.disabled = !!item.disabled;
    btn.onclick = () => {
      closeContextMenu();
      item.onClick();
    };
    menu.appendChild(btn);
  });

  document.body.appendChild(menu);

  // posiziona dopo l'inserimento per poter correggere se sfora la finestra
  const rect = menu.getBoundingClientRect();
  const left = Math.min(x, window.innerWidth - rect.width - 4);
  const top = Math.min(y, window.innerHeight - rect.height - 4);
  menu.style.left = `${Math.max(4, left)}px`;
  menu.style.top = `${Math.max(4, top)}px`;

  const onDocClick = (e) => {
    if (!menu.contains(e.target)) closeContextMenu();
  };
  const onKeyDown = (e) => {
    if (e.key === "Escape") closeContextMenu();
  };
  // registrato al giro successivo: evita che il click destro che ha aperto
  // il menu lo richiuda subito tramite lo stesso evento
  setTimeout(() => {
    document.addEventListener("click", onDocClick);
    document.addEventListener("contextmenu", onDocClick);
    document.addEventListener("keydown", onKeyDown);
  }, 0);

  closeOpenMenu = () => {
    menu.remove();
    document.removeEventListener("click", onDocClick);
    document.removeEventListener("contextmenu", onDocClick);
    document.removeEventListener("keydown", onKeyDown);
  };
}

function nodeContextMenuItems(node, hasChildren) {
  const items = [];

  items.push({
    label: node.focus ? "Disattiva focus" : "Attiva focus",
    disabled: !isLeaf(node),
    onClick: async () => {
      try {
        await setFocus(node.id, !node.focus);
        await reload();
      } catch (err) {
        alert(err.message);
      }
    },
  });

  const canAddChild = hasChildren || node.label !== "CHIUSO";
  items.push({
    label: "Aggiungi foglia",
    disabled: !canAddChild,
    onClick: () => openCreateModal(node.id),
  });

  items.push({
    label: "Note",
    onClick: () => {
      state.selectedNoteNodeId = node.id;
      state.focusNewNoteInput = true;
      rerender();
    },
  });

  items.push({
    label: "Configurazione",
    onClick: () => openEditModal(node),
  });

  items.push({
    label: "Elimina",
    onClick: async () => {
      const ok = confirm("Eliminare questo task e tutte le sotto-attività?");
      if (!ok) return;
      try {
        await deleteTask(node.id);
        await reload();
      } catch (err) {
        alert(err.message);
      }
    },
  });

  return items;
}

function renderNode(node, searchText) {
  const li = document.createElement("li");
  li.dataset.nodeId = node.id;

  const row = document.createElement("div");
  row.className = "tree-row";
  if (state.scrollToNodeId === node.id) row.classList.add("highlight");
  // il rosso (scaduto) prevale sul giallo (escalation) se coincidono
  if (node.expired) row.classList.add("row-expired");
  else if (node.escalation) row.classList.add("row-escalation");
  attachDragHandlers(row, node);

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
  title.title = "Clic sinistro: leggi le note. Clic destro: azioni sul nodo.";
  if (state.selectedNoteNodeId === node.id) title.classList.add("selected-node");
  title.textContent = node.title;
  title.onclick = () => {
    state.selectedNoteNodeId = node.id;
    rerender();
  };
  row.appendChild(title);

  row.appendChild(extraBadges(node));
  if (node.expired) row.appendChild(makeBadge("⏰", "Deadline superata"));
  else if (node.escalation) row.appendChild(makeBadge("📅", "Data di esecuzione raggiunta: era delegato"));

  row.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    showContextMenu(e.clientX, e.clientY, nodeContextMenuItems(node, hasChildren));
  });

  li.appendChild(row);

  if (childrenUl) {
    node.children
      .filter((c) => !searchText || subtreeMatches(c, searchText))
      .forEach((c) => childrenUl.appendChild(renderNode(c, searchText)));
    li.appendChild(childrenUl);
  }

  return li;
}

// il container (#main-panel) è un elemento persistente riusato a ogni render:
// i listener vanno agganciati una sola volta, altrimenti si accumulano
function ensureRootDropZone(container) {
  if (container.dataset.dropZoneReady) return;
  container.dataset.dropZoneReady = "true";

  container.addEventListener("dragover", (e) => {
    if (e.target !== container || draggedNode === null) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    container.classList.add("drop-target-root");
  });
  container.addEventListener("dragleave", (e) => {
    if (e.target === container) container.classList.remove("drop-target-root");
  });
  container.addEventListener("drop", (e) => {
    if (e.target !== container || draggedNode === null) return;
    e.preventDefault();
    container.classList.remove("drop-target-root");
    performMove(null);
  });
}

export function renderTree(container) {
  ensureRootDropZone(container);

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
