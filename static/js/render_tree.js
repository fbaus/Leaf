import { state, reload, rerender, USER_ROOT_KEY } from "./state.js";
import {
  buildTree,
  isLeaf,
  matchesSearch,
  STATUS_META,
  makeBadge,
  escapeHtml,
  byId,
  rootProjectCode,
  isTicketOfMine,
  STATUS_IN_LISTA,
} from "./utils.js";
import { deleteTask, setFocus, moveTask, resetAllNotifications } from "./api.js";
import { openCreateModal, openEditModal } from "./modal.js";
import { showContextMenu } from "./context_menu.js";
import { showConfirmDialog } from "./confirm_dialog.js";
import { openGanttView, openGanttViewForAllProjects } from "./render_gantt.js";

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

  // mirror di delete_task in app.py: un superuser può sempre eliminare (anche nodi altrui,
  // non solo i propri); altrimenti solo il proprietario, mai un task delegato (executor_user_id
  // set) né un ticket già chiuso (resta nel log del committente)
  const isSuperuser = !!state.currentUser?.is_superuser;
  const canDelete = isSuperuser || (
    isOwner
    && node.executor_user_id == null
    && !(node.ticket_owner_id != null && node.label === "CHIUSO")
  );
  if (canDelete) {
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
  // chi può "prendere" il nodo per spostarlo, mirror di require_movable_task in app.py: un
  // task delegato internamente ANCORATO nell'albero del committente (il suo genitore
  // attuale appartiene a lui) si sposta solo dal committente; un "ticket" (nessun genitore
  // che appartiene al committente — non l'ha mai avuto, o l'esecutore l'ha già incorporato
  // altrove) si sposta liberamente dall'esecutore, come un proprio nodo; per tutti gli
  // altri nodi resta il solo owner, come prima
  let canDragOut;
  if (node.committente_user_id != null) {
    const parent = node.parent_id != null ? tasksById[node.parent_id] : null;
    const anchoredInCommittenteTree = parent != null && parent.owner_id === node.committente_user_id;
    canDragOut = anchoredInCommittenteTree
      ? node.committente_user_id === state.currentUser?.id
      : node.executor_user_id === state.currentUser?.id;
  } else {
    canDragOut = isOwner;
  }
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

  // solo i nodi radice possono avere un codice progetto (mai i discendenti, vedi CHECK in
  // init_db.py): un colpo d'occhio in più per distinguere un progetto "ufficiale" senza
  // dover aprire la Configurazione o passare dal filtro Con codice/Senza codice di Foglie
  if (node.parent_id === null && node.project_code) {
    row.appendChild(makeBadge("🎖️", `Codice progetto: ${node.project_code}`));
  }

  // 🍌 distingue una banana (arrivata dal canale di delega "ticket", senza una vera casa
  // nell'albero di chi l'ha creata) da un progetto vero e da una delega interna nata da una
  // foglia già del committente: permanente, in ogni stato (in attesa/accettata/completata),
  // a differenza di 🤝 che segnala solo le due fasi di attesa-decisione — vedi ticket_owner_id
  // in app.py. A sinistra del titolo, non a destra come gli altri badge.
  if (node.ticket_owner_id != null) {
    row.appendChild(makeBadge("🍌", "Banana ricevuta da un collega", null, "delegation-badge"));
  }

  row.appendChild(title);

  // solo nella vista di supervisione del superuser: ogni nodo può avere un owner diverso da
  // quello dei suoi antenati (una foglia delegata cambia owner_id senza mai spostare
  // parent_id — vedi delega esterna/interna in app.py), quindi l'owner va mostrato per
  // singolo nodo, non solo a livello di progetto
  if (state.viewAllUsers && state.currentUser?.is_superuser && node.owner_username) {
    row.appendChild(makeBadge("👤 " + node.owner_username, `Owner: ${node.owner_username}`));
  }

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

  // 🤝 è mirato alle due fasi di attesa-decisione (accettazione della delega, conferma del
  // completamento), non un indicatore permanente "questo task è delegato": durante il
  // normale lavoro già accettato (delegation_status === 'accettata' e nessun completamento
  // in attesa) non compare. Non è temporaneo (a differenza di escalation/delegation_notice):
  // resta acceso finché non arriva davvero una decisione (accetta/rifiuta,
  // conferma/rifiuta completamento), mai spento dalla sola apertura della configurazione
  if (node.executor_user_id != null && (node.delegation_status === "in_attesa" || node.completion_pending)) {
    const tooltip = node.completion_pending
      ? (isOwner ? "Completamento in attesa di conferma del committente" : "Completamento da confermare")
      : (isOwner ? `Delegato da: ${node.committente_username} (in attesa)` : `Delegato a: ${node.executor_username} (in attesa)`);
    row.appendChild(makeBadge("🤝", tooltip, null, "delegation-badge"));
  } else if (node.delegation_pending_descendant || node.completion_pending_descendant) {
    // stessa idea di expired_descendant: un ramo collassato deve comunque segnalare che, in
    // profondità, una delega/un completamento aspetta una decisione, senza doverlo espandere
    const tooltip = node.completion_pending_descendant
      ? "Contiene un completamento in attesa di conferma"
      : "Contiene una delega in attesa di accettazione";
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

function userRootContextMenuItems() {
  return [
    { label: "Vista Gantt (tutti i progetti)", onClick: () => openGanttViewForAllProjects() },
    {
      label: "Resetta tutte le notifiche",
      onClick: async () => {
        try {
          await resetAllNotifications();
          await reload();
        } catch (err) {
          alert(err.message);
        }
      },
    },
  ];
}

// nodo "utente" fittizio (solo grafico, non un vero task) in cima all'albero: racchiude
// tutti i progetti radice, si espande/collassa come un nodo normale (persistito con
// USER_ROOT_KEY in state.expandedIds, incluso da "Espandi tutto" — vedi main.js). Il tasto
// destro apre "Vista Gantt" di tutti i progetti insieme e "Resetta tutte le notifiche"
// (escalation ed avvisi di delega ancora accesi, come aprire uno per uno ogni nodo
// interessato); è il punto naturale dove aggiungere in futuro altre azioni a livello di
// account.
function renderUserRootRow(tree, childrenUl) {
  const li = document.createElement("li");

  const row = document.createElement("div");
  row.className = "tree-row";

  const expanded = state.expandedIds.has(USER_ROOT_KEY);
  const toggle = document.createElement("button");
  toggle.className = "toggle-btn";
  toggle.textContent = expanded ? "▼" : "▶";
  toggle.onclick = () => {
    const isExpanded = state.expandedIds.has(USER_ROOT_KEY);
    if (isExpanded) state.expandedIds.delete(USER_ROOT_KEY);
    else state.expandedIds.add(USER_ROOT_KEY);
    childrenUl.style.display = isExpanded ? "none" : "block";
    toggle.textContent = isExpanded ? "▶" : "▼";
  };
  row.appendChild(toggle);
  row.appendChild(branchToggleButton({ id: USER_ROOT_KEY, children: tree }));

  const title = document.createElement("span");
  title.className = "node-title";
  title.title = "Tasto destro: azioni su tutti i tuoi progetti.";
  title.textContent = state.viewAllUsers && state.currentUser?.is_superuser
    ? "Tutti gli utenti (vista superuser)"
    : (state.currentUser?.username ?? "");
  row.appendChild(title);

  row.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    showContextMenu(e.clientX, e.clientY, userRootContextMenuItems());
  });

  li.appendChild(row);
  childrenUl.style.display = expanded ? "block" : "none";
  li.appendChild(childrenUl);
  return li;
}

export function renderTree(container) {
  ensureRootDropZone(container);
  renderSearchBox(container);

  const searchText = state.searchText.trim();
  const tasksById = byId(state.tasks);
  // i ticket (foglie di cui l'utente è committente ma senza un genitore suo visibile) non
  // sono un suo progetto: vanno esclusi dall'Albero e vivono solo nella vista Ticket, vedi
  // isTicketOfMine in utils.js
  const tree = buildTree(state.tasks).filter(
    (n) => !isTicketOfMine(n, state.currentUser?.id)
  );

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

  const childrenUl = document.createElement("ul");
  childrenUl.className = "tree-children";
  tree
    .filter((n) => !searchText || subtreeMatches(n, searchText))
    .forEach((n) => childrenUl.appendChild(renderNode(n, searchText, tasksById)));

  const ul = document.createElement("ul");
  ul.className = "tree-root";
  ul.appendChild(renderUserRootRow(tree, childrenUl));

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
