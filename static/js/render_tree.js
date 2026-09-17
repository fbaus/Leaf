import { state, reload, rerender } from "./state.js";
import {
  buildTree,
  isLeaf,
  matchesSearch,
  STATUS_META,
  makeBadge,
  escapeHtml,
  byId,
  rootProjectCode,
  STATUS_IN_LISTA,
} from "./utils.js";
import { deleteTask, setFocus, moveTask } from "./api.js";
import { openCreateModal, openEditModal } from "./modal.js";
import { showContextMenu } from "./context_menu.js";
import { showConfirmDialog } from "./confirm_dialog.js";
import { openGanttView } from "./render_gantt.js";

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

// due capacità distinte, non sempre entrambe presenti sulla stessa riga: poter "prendere"
// il nodo per spostarlo altrove, e poter "accettare" un nodo trascinato come nuovo figlio.
// Per un task delegato internamente divergono: solo il committente può prenderlo (vedi
// require_movable_task in app.py), ma resta solo l'esecutore a poter accettare nuovi figli
// sotto di esso (stessa autorizzazione di "Aggiungi foglia")
function attachDragSource(row, node) {
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
}

function attachDropTarget(row, node) {
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

async function confirmDeletion(node) {
  const name = `<strong>${escapeHtml(node.title)}</strong>`;
  const first = await showConfirmDialog(`Eliminare ${name} e tutte le sotto-attività?`);
  if (!first) return false;
  return showConfirmDialog(`Confermi in modo definitivo l'eliminazione di ${name}?`);
}

// un nodo visibile solo come committente (non owner) di una foglia delegata è di fatto in
// sola lettura: solo Note (per negoziare) e Configurazione (in sola lettura) restano
// disponibili — le altre azioni fallirebbero comunque lato server (route owner-only)
function nodeContextMenuItems(node, hasChildren, isOwner) {
  const items = [];

  if (isOwner) {
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
  }

  items.push({
    label: "Note",
    onClick: () => {
      state.selectedNoteNodeId = node.id;
      state.focusNewNoteInput = true;
      rerender();
    },
  });

  if (isOwner) {
    items.push({
      label: "Vista Gantt",
      disabled: !hasChildren,
      onClick: () => openGanttView(node),
    });
  }

  items.push({
    label: "Configurazione",
    onClick: () => openEditModal(node),
  });

  if (isOwner) {
    items.push({
      label: "Elimina",
      onClick: async () => {
        const ok = await confirmDeletion(node);
        if (!ok) return;
        try {
          await deleteTask(node.id);
          await reload();
        } catch (err) {
          alert(err.message);
        }
      },
    });
  }

  return items;
}

// pallino rosso permanente: foglia aperta, non delegata (né esterna né interna), di un
// progetto con codice, priva di tempo stimato — lo stesso incentivo già dato dal rollup
// "tutto o niente" (vedi compute_estimated_days_rollup), qui reso visibile subito sulla
// foglia stessa invece che solo come "—" più in alto nell'albero
function missingEstimateOnCodedProject(node, tasksById) {
  return (
    isLeaf(node)
    && node.label === "APERTO"
    && node.status !== STATUS_IN_LISTA
    && !node.assegnato
    && node.executor_user_id == null
    && node.estimated_days == null
    && rootProjectCode(node, tasksById) != null
  );
}

function renderNode(node, searchText, tasksById) {
  const isOwner = node.owner_id === state.currentUser?.id;
  const li = document.createElement("li");
  li.dataset.nodeId = node.id;

  const row = document.createElement("div");
  row.className = "tree-row";
  if (state.scrollToNodeId === node.id) row.classList.add("highlight");
  // il rosso (scaduto) prevale sul giallo (escalation) se coincidono
  if (node.expired) row.classList.add("row-expired");
  else if (node.escalation) row.classList.add("row-escalation");
  if (state.highlightedDepsIds.has(node.id)) row.classList.add("row-dep-highlight");
  // chi può "prendere" il nodo per spostarlo: per un task delegato internamente è SOLO il
  // committente (mai l'esecutore, vedi require_movable_task in app.py); per tutti gli altri
  // nodi resta il solo owner, come prima
  const canDragOut = node.committente_user_id != null
    ? node.committente_user_id === state.currentUser?.id
    : isOwner;
  // chi può "accettare" il nodo trascinato come figlio: sempre e solo l'owner (stessa
  // autorizzazione di "Aggiungi foglia") — il committente può riposizionare un task delegato
  // fra i propri rami, ma non creargli figli sotto, che restano affari dell'esecutore
  if (canDragOut) attachDragSource(row, node);
  if (isOwner) attachDropTarget(row, node);

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
  // il colore temporaneo è un avviso per il COMMITTENTE (è lui che deve accorgersi del
  // cambiamento fatto dall'esecutore): l'esecutore stesso, che l'ha appena causato, non lo vede
  if (node.delegation_notice && node.committente_user_id === state.currentUser?.id) {
    title.classList.add(`delegation-notice-${node.delegation_notice}`);
  }
  title.title = "Clic sinistro: leggi le note. Clic destro: azioni sul nodo.";
  if (state.selectedNoteNodeId === node.id) title.classList.add("selected-node");
  title.textContent = node.title;
  title.onclick = () => {
    state.selectedNoteNodeId = node.id;
    rerender();
  };
  row.appendChild(title);

  if (missingEstimateOnCodedProject(node, tasksById)) {
    const dot = document.createElement("span");
    dot.className = "missing-estimate-dot";
    dot.title = "Foglia aperta di un progetto con codice, senza tempo stimato";
    row.appendChild(dot);
  }

  if (node.expired) row.appendChild(makeBadge("⏰", "Deadline superata"));
  else if (node.escalation) row.appendChild(makeBadge("📅", "Data di esecuzione raggiunta: era delegato"));
  // un ramo non è mai "expired" di suo (vedi expired_descendant in app.py): il badge segnala
  // solo la presenza, in profondità, di una foglia scaduta senza dover espandere il ramo
  else if (node.expired_descendant) row.appendChild(makeBadge("⏰", "Contiene una sotto-attività con deadline superata"));

  if (node.executor_user_id != null) {
    const stato = node.delegation_status === "accettata" ? "accettata" : "in attesa";
    const tooltip = isOwner
      ? `Delegato da: ${node.committente_username} (${stato})`
      : `Delegato a: ${node.executor_username} (${stato})`;
    row.appendChild(makeBadge("🤝", tooltip, null, "delegation-badge"));
  }

  // stessa idea di expired_descendant: un ramo collassato deve comunque segnalare che, in
  // profondità, un task delegato ha una notifica (cambio deadline o accettazione) ancora da
  // vedere — altrimenti resterebbe invisibile finché non si espande tutto il sottoalbero
  if (node.notice_descendant) {
    row.appendChild(makeBadge("🔔", "Contiene un task delegato con una notifica non ancora vista", null, "delegation-badge"));
  }

  row.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    showContextMenu(e.clientX, e.clientY, nodeContextMenuItems(node, hasChildren, isOwner));
  });

  li.appendChild(row);

  if (childrenUl) {
    node.children
      .filter((c) => !searchText || subtreeMatches(c, searchText))
      .forEach((c) => childrenUl.appendChild(renderNode(c, searchText, tasksById)));
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

function renderSearchBox(container) {
  const input = document.createElement("input");
  input.type = "text";
  input.id = "tree-search-box";
  input.className = "tree-search-box";
  input.placeholder = "Cerca nell'albero per titolo o descrizione...";
  input.value = state.searchText;
  input.dataset.preserveFocusKey = "tree-search";
  input.oninput = (e) => {
    state.searchText = e.target.value;
    rerender();
  };
  container.appendChild(input);
}

export function renderTree(container) {
  ensureRootDropZone(container);
  renderSearchBox(container);

  const searchText = state.searchText.trim();
  const tree = buildTree(state.tasks);
  const tasksById = byId(state.tasks);

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
    .forEach((n) => ul.appendChild(renderNode(n, searchText, tasksById)));

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
