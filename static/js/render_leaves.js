import { state, reload, rerender } from "./state.js";
import {
  isLeaf,
  isLeafForViewer,
  isOpenLeaf,
  byId,
  rootTitle,
  rootProjectCode,
  truncate,
  STATUS_META,
  STATUS_GROUPS,
  matchesStatusGroup,
  sortRows,
  rootIdOf,
  SORT_LABELS,
  sortableHeader,
  makeBadge,
  childrenIndex,
  openLeafDescendants,
  delegationCellText,
  STATUS_IN_LISTA,
} from "./utils.js";
import { setFocus } from "./api.js";
import { openEditModal } from "./modal.js";
import { jumpToTree } from "./navigate.js";
import { toggleDependencyHighlight } from "./deps_highlight.js";
import { renderCalendarOverlay, CHART_ROW_HEIGHT, isWorkloadChartVisible } from "./render_calendar.js";
import { showContextMenu } from "./context_menu.js";

function getRootNodes(tasks) {
  return tasks.filter((t) => t.parent_id === null);
}

function isRootIncluded(rootId) {
  return state.leafFilters.rootIds === null || state.leafFilters.rootIds.has(rootId);
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

  const calBtn = document.createElement("button");
  calBtn.className = "filter-group-btn";
  calBtn.classList.toggle("active", state.calendarOpen);
  calBtn.textContent = "📅 Calendario";
  calBtn.onclick = () => {
    state.calendarOpen = !state.calendarOpen;
    rerender();
  };
  bar.appendChild(calBtn);

  mainPanel.appendChild(bar);
  // l'header della tabella (sticky, vedi .leaves-table thead th in style.css) si aggancia
  // esattamente sotto a questa barra: la sua altezza reale (non fissa, i bottoni possono
  // andare a capo) va misurata qui, non indovinata in CSS
  mainPanel.style.setProperty("--filter-bar-height", `${bar.getBoundingClientRect().height}px`);

  // col grafico del carico di lavoro visibile (vedi CHART_ROW_HEIGHT/isWorkloadChartVisible
  // in render_calendar.js), la <table> reale sotto va spinta più in basso di quel tanto in
  // più: l'overlay del calendario è solo disegnato SOPRA la pagina, non può spingere giù la
  // tabella vera da sé — senza questo margine aggiuntivo il grafico si sovrapporrebbe alle
  // prime barre reali sotto di esso invece di stare nello spazio riservato sopra di loro
  bar.style.marginBottom = isWorkloadChartVisible()
    ? `${parseFloat(getComputedStyle(bar).marginBottom) + CHART_ROW_HEIGHT}px`
    : "";
}

// percentuali (sommano a 100):
// progetto, titolo, status, assegnato, descrizione, esecuzione, deadline
const COLUMN_WIDTHS = [13, 22, 6, 8, 31, 10, 10];
// stessa somma, con una colonna "Owner" in più (solo vista di supervisione del superuser —
// vedi showOwnerColumn sotto): tolto lo spazio quasi tutto a descrizione
const COLUMN_WIDTHS_WITH_OWNER = [13, 22, 6, 8, 23, 10, 10, 8];

function renderColgroup(table, showOwnerColumn) {
  const colgroup = document.createElement("colgroup");
  (showOwnerColumn ? COLUMN_WIDTHS_WITH_OWNER : COLUMN_WIDTHS).forEach((width) => {
    const col = document.createElement("col");
    col.style.width = `${width}%`;
    colgroup.appendChild(col);
  });
  table.appendChild(colgroup);
}

function renderTable(mainPanel, tasksById) {
  let leaves = state.tasks.filter((n) => isLeafForViewer(n, state.currentUser?.id));
  leaves = leaves.filter((n) => matchesStatusGroup(n, state.leafFilters.statusGroup));
  leaves = leaves.filter((n) => isRootIncluded(rootIdOf(n, tasksById)));
  leaves = sortRows(
    leaves, tasksById, state.leafFilters.sortBy, state.leafFilters.dateSecondarySort, state.currentUser?.id
  );

  const childrenByParent = childrenIndex(state.tasks);
  const showOwnerColumn = state.viewAllUsers && !!state.currentUser?.is_superuser;

  const table = document.createElement("table");
  table.className = "leaves-table";
  renderColgroup(table, showOwnerColumn);

  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  const onSort = (key) => {
    state.leafFilters.sortBy = key;
    rerender();
  };
  headRow.appendChild(sortableHeader(SORT_LABELS.padre, "padre", state.leafFilters.sortBy, onSort));
  headRow.appendChild(document.createElement("th")).textContent = "Titolo";
  headRow.appendChild(sortableHeader(SORT_LABELS.status, "status", state.leafFilters.sortBy, onSort));
  headRow.appendChild(sortableHeader(SORT_LABELS.assegnato, "assegnato", state.leafFilters.sortBy, onSort));
  headRow.appendChild(document.createElement("th")).textContent = "Descrizione";
  headRow.appendChild(
    sortableHeader(SORT_LABELS.execution_date, "execution_date", state.leafFilters.sortBy, onSort)
  );
  headRow.appendChild(sortableHeader(SORT_LABELS.deadline, "deadline", state.leafFilters.sortBy, onSort));
  if (showOwnerColumn) headRow.appendChild(document.createElement("th")).textContent = "Owner";
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  leaves.forEach((node) => {
    const isOwner = node.owner_id === state.currentUser?.id;
    const tr = document.createElement("tr");
    tr.dataset.taskId = node.id;
    tr.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      const items = [];
      if (isOwner) {
        items.push({
          label: node.focus ? "Disattiva focus" : "Attiva focus",
          onClick: async () => {
            try {
              await setFocus(node.id, !node.focus);
              await reload();
            } catch (err) {
              alert(err.message);
            }
          },
        });
      }
      items.push({
        label: "Configurazione",
        onClick: () => openEditModal(node),
      });
      showContextMenu(e.clientX, e.clientY, items);
    });

    const tdParent = document.createElement("td");
    tdParent.textContent = rootTitle(node, tasksById);
    tr.appendChild(tdParent);

    const tdTitle = document.createElement("td");
    tdTitle.className = "leaf-title-cell";
    tdTitle.classList.toggle("row-expired", !!node.expired);

    // wrapper interno (non la cella stessa: display:flex su un <td> ne altera il
    // comportamento come table-cell e disallinea il bordo inferiore di riga rispetto alle
    // altre colonne) che allinea testo, badge scadenza e tag dipendenze sulla stessa riga
    const titleRow = document.createElement("div");
    titleRow.className = "leaf-title-row";
    tdTitle.appendChild(titleRow);

    const titleText = document.createElement("span");
    titleText.className = "leaf-title-text";
    // stesso principio della vista Albero: il colore è un avviso per il committente, non per
    // l'esecutore che ha appena causato il cambiamento
    if (node.delegation_notice && node.committente_user_id === state.currentUser?.id) {
      titleText.classList.add(`delegation-notice-${node.delegation_notice}`);
    }
    titleText.textContent = node.title;
    titleText.title = "Vai nell'albero";
    titleText.onclick = () => jumpToTree(node.id);
    titleRow.appendChild(titleText);

    // pallino rosso permanente: foglia aperta, non delegata, di un progetto con codice,
    // priva di tempo stimato — stesso incentivo del rollup "tutto o niente", qui visibile
    // subito sulla foglia stessa (vedi missingEstimateOnCodedProject in render_tree.js)
    if (
      node.label === "APERTO" && node.status !== STATUS_IN_LISTA
      && !node.assegnato && node.executor_user_id == null
      && node.estimated_days == null && rootProjectCode(node, tasksById) != null
    ) {
      const dot = document.createElement("span");
      dot.className = "missing-estimate-dot";
      dot.title = "Foglia aperta di un progetto con codice, senza tempo stimato";
      titleRow.appendChild(dot);
    }

    // il rosso (scaduto) prevale sul giallo (preavviso 7gg) se coincidono, come nell'albero
    if (node.expired) titleRow.appendChild(makeBadge("⏰", "Deadline superata"));
    else if (node.deadline_approaching) {
      titleRow.appendChild(makeBadge("⚠️", "Deadline entro 7 giorni", "#f9a825", "deadline-warning-badge"));
    }

    // 🤝 è mirato alle due fasi di attesa-decisione (accettazione della delega, conferma del
    // completamento), non un indicatore permanente "questo task è delegato" — vedi la stessa
    // condizione in render_tree.js
    if (node.executor_user_id != null && (node.delegation_status === "in_attesa" || node.completion_pending)) {
      const tooltip = node.completion_pending
        ? (isOwner ? "Completamento in attesa di conferma del committente" : "Completamento da confermare")
        : (isOwner ? `Delegato da: ${node.committente_username} (in attesa)` : `Delegato a: ${node.executor_username} (in attesa)`);
      titleRow.appendChild(makeBadge("🤝", tooltip, null, "delegation-badge"));
    }

    // due tag distinti, uno per tipo di dipendenza, entrambi accanto al titolo: quello
    // verso foglie (rosa) accende/spegne l'evidenziazione delle righe dipendenti in questa
    // stessa vista; quello verso rami (viola), subito alla sua destra, porta all'albero
    // (unico posto dove un ramo è visibile). Entrambi compaiono solo se la dipendenza è
    // ancora "aperta" (per un ramo: se contiene almeno una foglia aperta, ricorsivamente —
    // un ramo non ha uno status proprio) — una dipendenza interamente chiusa non blocca più
    // nulla, quindi non ha senso segnalarla
    const leafDeps = (node.dependency_ids || [])
      .map((id) => tasksById[id])
      .filter((dep) => dep && isLeaf(dep));
    const branchDeps = (node.dependency_ids || [])
      .map((id) => tasksById[id])
      .filter((dep) => dep && !isLeaf(dep));

    const openLeafDeps = leafDeps.filter(isOpenLeaf);
    const openBranchDeps = branchDeps
      .map((branch) => ({ branch, openLeaves: openLeafDescendants(branch, childrenByParent) }))
      .filter((entry) => entry.openLeaves.length > 0);

    if (openLeafDeps.length > 0 || openBranchDeps.length > 0) {
      // insieme evidenziato dal tag "foglie": le dipendenze-foglia dirette aperte, più —
      // per ogni dipendenza-ramo ancora aperta — tutte le sue foglie aperte, scese
      // ricorsivamente dentro eventuali sotto-rami
      const highlightIds = new Set([
        ...openLeafDeps.map((d) => d.id),
        ...openBranchDeps.flatMap((entry) => entry.openLeaves.map((l) => l.id)),
      ]);
      const leafTag = document.createElement("button");
      leafTag.className = "deps-branch-badge";
      leafTag.textContent = "🔗";
      leafTag.classList.toggle("active", state.highlightedDepsSourceId === node.id);
      const titleLines = [
        ...openLeafDeps.map((d) => d.title),
        ...openBranchDeps.flatMap((entry) => entry.openLeaves.map((l) => l.title)),
      ];
      leafTag.title = `Dipendenze foglie aperte:\n${titleLines.join("\n")}`;
      leafTag.onclick = () => toggleDependencyHighlight(node, highlightIds);
      titleRow.appendChild(leafTag);
    }

    if (openBranchDeps.length > 0) {
      const branchTag = document.createElement("button");
      branchTag.className = "deps-branch-badge deps-branch-badge-violet";
      branchTag.textContent = "🔗";
      branchTag.title = `Dipendenze rami (con foglie ancora aperte):\n${openBranchDeps.map((entry) => entry.branch.title).join("\n")}`;
      // solo il salto all'albero, senza accendere l'evidenziazione gialla (che essendo
      // stato globale resterebbe accesa anche tornando su questa vista) — l'evidenziazione
      // "sei arrivato qui" nell'albero la dà comunque jumpToTree per conto suo
      branchTag.onclick = () => jumpToTree(openBranchDeps[0].branch.id);
      titleRow.appendChild(branchTag);
    }

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

    const tdAssegnato = document.createElement("td");
    tdAssegnato.textContent = delegationCellText(node, state.currentUser?.id) || "—";
    tr.appendChild(tdAssegnato);

    const tdDesc = document.createElement("td");
    tdDesc.textContent = truncate(node.description, 60);
    tr.appendChild(tdDesc);

    const tdExecutionDate = document.createElement("td");
    tdExecutionDate.append(node.execution_date || "—");
    if (node.execution_passed) {
      tdExecutionDate.appendChild(makeBadge("..........", "Data di esecuzione superata"));
    }
    tr.appendChild(tdExecutionDate);

    const tdDeadline = document.createElement("td");
    tdDeadline.append(node.deadline || "—");
    tr.appendChild(tdDeadline);

    if (showOwnerColumn) {
      const tdOwner = document.createElement("td");
      tdOwner.textContent = node.owner_username || "—";
      tr.appendChild(tdOwner);
    }

    if (state.highlightedDepsIds.has(node.id)) tr.classList.add("row-dep-highlight");

    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  mainPanel.appendChild(table);
  return leaves;
}

function renderChecklist(sidePanel) {
  const box = document.createElement("div");
  box.className = "root-checklist";

  const heading = document.createElement("h3");
  heading.textContent = "Progetti";
  box.appendChild(heading);

  const actions = document.createElement("div");
  actions.className = "root-checklist-actions";
  const selectAllBtn = document.createElement("button");
  selectAllBtn.textContent = "Seleziona tutti";
  selectAllBtn.onclick = () => {
    // null = nessun filtro, coerente col comportamento di default (include anche i
    // progetti creati in seguito, a differenza di un Set con gli id attuali)
    state.leafFilters.rootIds = null;
    rerender();
  };
  const deselectAllBtn = document.createElement("button");
  deselectAllBtn.textContent = "Deseleziona tutti";
  deselectAllBtn.onclick = () => {
    state.leafFilters.rootIds = new Set();
    rerender();
  };
  actions.appendChild(selectAllBtn);
  actions.appendChild(deselectAllBtn);
  box.appendChild(actions);

  // filtro rapido per presenza del codice progetto: riusa lo stesso state.leafFilters.rootIds
  // già usato dai checkbox sotto (imposta direttamente l'insieme dei progetti radice che
  // rispettano il criterio), nessun nuovo stato da introdurre
  const codeActions = document.createElement("div");
  codeActions.className = "root-checklist-actions";
  const withCodeBtn = document.createElement("button");
  withCodeBtn.textContent = "Con codice";
  withCodeBtn.onclick = () => {
    state.leafFilters.rootIds = new Set(
      getRootNodes(state.tasks).filter((r) => r.project_code != null).map((r) => r.id)
    );
    rerender();
  };
  const withoutCodeBtn = document.createElement("button");
  withoutCodeBtn.textContent = "Senza codice";
  withoutCodeBtn.onclick = () => {
    state.leafFilters.rootIds = new Set(
      getRootNodes(state.tasks).filter((r) => r.project_code == null).map((r) => r.id)
    );
    rerender();
  };
  codeActions.appendChild(withCodeBtn);
  codeActions.appendChild(withoutCodeBtn);
  box.appendChild(codeActions);

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
  // il pannello "Progetti" va popolato PRIMA della tabella: parte vuoto (display:none via
  // CSS) e la sua larghezza reale (280px) si aggiunge solo una volta riempito, restringendo
  // #main-panel — misurare le colonne della tabella (per il calendario) prima di questo
  // punto le misurerebbe temporaneamente troppo larghe
  renderChecklist(sidePanel);
  const leaves = renderTable(mainPanel, tasksById);
  if (state.calendarOpen) renderCalendarOverlay(mainPanel, leaves);
}
