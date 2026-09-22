// Vista Gantt per-nodo: apribile dal menu tasto destro sull'albero, mostra i figli di un
// nodo come barre su una timeline condivisa (execution_date=inizio, deadline=fine), con
// righe espandibili per i figli che a loro volta hanno figli, e frecce per le dipendenze
// fra barre entrambe visibili. Riusa il drag delle barre già scritto per il calendario
// (vedi timeline.js) e il rollup automatico delle date sui rami (vedi app.py) per le
// "summary bar" dei nodi con figli, senza bisogno di logica propria. Apribile anche sul
// nodo "utente" fittizio in cima all'Albero (vedi render_tree.js): mostra tutti i progetti
// radice insieme, sotto la sentinella ALL_PROJECTS_ROOT (mai un vero id di task).

import { state, reload } from "./state.js";
import { STATUS_META, CLOSED_STATUSES, isLeaf, dateSortKey } from "./utils.js";
import { openEditModal, openCreateModal } from "./modal.js";
import { recomputeRollup, fetchCaricoLeaves } from "./api.js";
import { setDependencyHighlight } from "./deps_highlight.js";
import { jumpToTree } from "./navigate.js";
import { showContextMenu } from "./context_menu.js";
import { buildLeafSeries, computeMaxY, buildChartSvg, buildAxisLabels } from "./render_workload_chart.js";
import {
  GRANULARITIES,
  DRAGGABLE_GRANULARITIES,
  buildBuckets,
  buildSuperHeaderGroups,
  bucketOffset,
  todayLineOffset,
  barRangeForNode,
  attachBarHandleDrag,
  attachBarMoveDrag,
  attachLockedBarNotice,
  createDragTooltip,
  removeDragTooltip,
  removeAllDragTooltips,
  isDragJustHappened,
  updateDragTooltip,
  parseISO,
} from "./timeline.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const ROW_HEIGHT = 28; // deve combaciare con .gantt-outline-row (style.css)
const HEADER_HEIGHT = 40; // deve combaciare con #gantt-outline-header/#gantt-timeline-header-scroll
const SUPER_HEADER_HEIGHT = 20; // fascia settimane/mesi/anni sopra l'intestazione normale, 0 se nascosta (vista "Globale")
// colore delle sole frecce COMPLETE mostrate su richiesta (vedi toggleDepsSelection):
// volutamente diverso dall'arancio dei triangolini indicatori (sempre visibili su ogni
// nodo con dipendenze), così la freccia attualmente "aperta" risalta rispetto agli
// indicatori statici. Un rosso acceso, leggibile sia su sfondo chiaro che scuro (stesso
// principio dei colori di stato in STATUS_META, fissi in entrambi i temi — vedi il
// commento in cima a style.css); anche i triangolini indicatori che partecipano alla
// freccia mostrata (i suoi due estremi) diventano dello stesso rosso, vedi
// computeParticipatingIndicators più sotto
const DEP_ARROW_COLOR = "#d32f2f";
const GANTT_BRANCH_COLOR = "#4fc3f7";
// ramo con tutte le foglie discendenti chiuse (vedi isBranchClosed più sotto): grigio,
// per distinguerlo a colpo d'occhio dai rami ancora aperti (azzurri)
const GANTT_BRANCH_CLOSED_COLOR = "#9e9e9e";
// tratto diritto, della stessa lunghezza, sia subito dopo l'uscita dalla barra sorgente
// sia subito prima della punta (che si ferma un po' prima della barra dipendente, senza entrarci)
const DEP_ARROW_STUB = 14;
const DEP_ARROW_TIP_GAP = 4;
// il nome del nodo parte oltre il tratto d'uscita di un'eventuale freccia di dipendenza,
// così il testo non ci si sovrappone (lo sfondo chiaro del nome copre comunque il tratto
// residuo di una freccia più lunga, quando non deve tornare indietro)
const LABEL_OFFSET = DEP_ARROW_STUB + 16;
// distanza minima (px) che un tratto verticale di una freccia deve mantenere dalla linea
// "oggi": altrimenti, sovrapposte, diventano indistinguibili
const DEP_ARROW_TODAY_MARGIN = 6;
// piccola freccia indicatrice (entrante a sinistra/uscente a destra di una barra, vedi
// drawTimeline): niente instradamento, solo un tratto fisso più un pallino cliccabile
// all'estremità che mostra/nasconde le frecce complete di quella direzione
const DEP_INDICATOR_STUB = 18;
const DEP_INDICATOR_TRI_W = 11; // lunghezza del triangolino lungo l'asse x
const DEP_INDICATOR_TRI_H = 10; // altezza della sua base
const DEP_INDICATOR_HIT_R = 9; // raggio dell'area cliccabile invisibile centrata sul triangolino

// sentinella per "Gantt di tutti i progetti insieme" (voce del menu sul nodo utente
// fittizio in Albero): mai un vero id di task, sempre distinta da `null` (che significa
// "Gantt chiuso", vedi closeGantt/refreshGanttIfOpen)
const ALL_PROJECTS_ROOT = "__all__";

const overlay = document.getElementById("gantt-overlay");
const titleEl = document.getElementById("gantt-title");
const toolbarEl = document.getElementById("gantt-toolbar");
const closeBtn = document.getElementById("gantt-close");
const outlineScroll = document.getElementById("gantt-outline-scroll");
const outlineBody = document.getElementById("gantt-outline-body");
const outlineSuperHeader = document.getElementById("gantt-outline-super-header");
const outlineChartSpacer = document.getElementById("gantt-outline-chart-spacer");
const timelineSuperHeaderScroll = document.getElementById("gantt-timeline-super-header-scroll");
const timelineSuperHeader = document.getElementById("gantt-timeline-super-header");
const timelineHeaderScroll = document.getElementById("gantt-timeline-header-scroll");
const timelineHeader = document.getElementById("gantt-timeline-header");
const timelineChartScroll = document.getElementById("gantt-timeline-chart-scroll");
const timelineChartInner = document.getElementById("gantt-timeline-chart-inner");
const timelineScroll = document.getElementById("gantt-timeline-scroll");
const timelineInner = document.getElementById("gantt-timeline-inner");

let rootId = null;
let granularity = "giorno";
let expandedIds = new Set();
let hasScrolledToToday = false;
// quali frecce di dipendenza COMPLETE mostrare in questo momento (vedi i piccoli
// indicatori con pallino arancio in drawTimeline): null = nessuna, altrimenti il nodo e la
// direzione ("in" = tutte le sue dipendenze, "out" = tutti i nodi che dipendono da lui)
// selezionati cliccando un pallino. Persiste fra un draw() e l'altro (cambio granularità,
// espandi/collassa) per non dover ricliccare ogni volta; resettato solo aprendo il Gantt
let activeDepsSelection = null;
// foglie attive raccolte lato server (vedi collect_active_leaves in app.py) per il
// grafico "carico complessivo" in cima: caricate on-demand all'apertura/dopo ogni
// modifica, mai calcolate qui per non duplicare la formula del carico in JS
let summaryLeaves = [];

// ---------------------------------------------------------------------------
// Apertura / chiusura
// ---------------------------------------------------------------------------

// prima di mostrare la timeline, ricalcola dal basso il rollup di tutto il sottoalbero:
// "auto-guarigione" contro eventuali derive (es. dati storici precedenti al rollup),
// non solo l'aggiornamento incrementale già garantito a ogni singola modifica
export async function openGanttView(node) {
  // "settimana" è la key interna del bottone mostrato come "Mese" (le etichette sono
  // scalate di un gradino rispetto alle key storiche, vedi GRANULARITIES in timeline.js)
  granularity = "settimana";
  hasScrolledToToday = false;
  activeDepsSelection = null;
  try {
    await recomputeRollup(node.id);
    await reload();
  } catch (err) {
    alert(err.message);
  }
  rootId = node.id;
  // aperto già tutto espanso, non serve più un clic su "Espandi tutto" ogni volta
  expandedIds = new Set(collectExpandableIds(node.id));
  overlay.classList.remove("hidden");
  draw();
  refreshSummaryChart();
}

// Gantt di tutti i progetti radice insieme (voce di menu sul nodo utente fittizio in
// Albero, vedi render_tree.js): stessa apertura, ma la "radice" è la sentinella
// ALL_PROJECTS_ROOT invece di un vero nodo — buildVisibleRows/collectExpandableIds la
// traducono in `null`, che su state.tasks seleziona naturalmente tutti i progetti radice
export async function openGanttViewForAllProjects() {
  granularity = "settimana";
  hasScrolledToToday = false;
  activeDepsSelection = null;
  const ownRootIds = state.tasks
    .filter((t) => t.parent_id === null && t.owner_id === state.currentUser?.id)
    .map((t) => t.id);
  try {
    await Promise.all(ownRootIds.map((id) => recomputeRollup(id)));
    await reload();
  } catch (err) {
    alert(err.message);
  }
  rootId = ALL_PROJECTS_ROOT;
  expandedIds = new Set(collectExpandableIds(null));
  overlay.classList.remove("hidden");
  draw();
  refreshSummaryChart();
}

function closeGantt() {
  overlay.classList.add("hidden");
  rootId = null;
  // un tooltip di data (vedi attachHandleDateTooltip) può restare orfano se la sua maniglia
  // viene distrutta da un redraw mentre il mouse è ancora sopra di essa (niente mouseleave
  // in quel caso): chiudendo il Gantt è comunque il momento giusto per ripulirlo, non deve
  // sopravvivere alla chiusura fino a un refresh manuale della pagina
  removeAllDragTooltips();
}

closeBtn.addEventListener("click", closeGantt);

// chiude solo se sia il mousedown che il click sono partiti sullo sfondo (stesso
// accorgimento del modale: selezionare del testo trascinando fuori non deve chiudere)
let mouseDownOnBackdrop = false;
overlay.addEventListener("mousedown", (e) => {
  mouseDownOnBackdrop = e.target === overlay;
});
overlay.addEventListener("click", (e) => {
  if (e.target === overlay && mouseDownOnBackdrop) closeGantt();
});

// richiamata da main.js dopo ogni rerender() globale (salvataggi dal modale, drag,
// checklist, focus, ...): se il Gantt è aperto si ridisegna con i dati aggiornati
export function refreshGanttIfOpen() {
  if (rootId === null) return;
  draw();
  refreshSummaryChart();
}

// ---------------------------------------------------------------------------
// Carico complessivo (grafico in cima, vedi drawSummaryChart): riusa collect_active_leaves
// già scritta in app.py per la Vista Carico di lavoro invece di ricalcolare la formula qui
// ---------------------------------------------------------------------------

async function refreshSummaryChart() {
  const idsToFetch =
    rootId === ALL_PROJECTS_ROOT
      ? state.tasks.filter((t) => t.parent_id === null && t.owner_id === state.currentUser?.id).map((t) => t.id)
      : [rootId];
  try {
    const lists = await Promise.all(idsToFetch.map((id) => fetchCaricoLeaves(id)));
    summaryLeaves = lists.flat();
  } catch (err) {
    summaryLeaves = [];
  }
  if (rootId !== null) draw();
}

// ---------------------------------------------------------------------------
// Sincronizzazione scroll fra il pannello outline e quello della timeline
// ---------------------------------------------------------------------------

let syncingVerticalScroll = false;
timelineScroll.addEventListener("scroll", () => {
  timelineHeaderScroll.scrollLeft = timelineScroll.scrollLeft;
  timelineSuperHeaderScroll.scrollLeft = timelineScroll.scrollLeft;
  timelineChartScroll.scrollLeft = timelineScroll.scrollLeft;
  if (syncingVerticalScroll) return;
  syncingVerticalScroll = true;
  outlineScroll.scrollTop = timelineScroll.scrollTop;
  syncingVerticalScroll = false;
});
outlineScroll.addEventListener("scroll", () => {
  if (syncingVerticalScroll) return;
  syncingVerticalScroll = true;
  timelineScroll.scrollTop = outlineScroll.scrollTop;
  syncingVerticalScroll = false;
});

// ---------------------------------------------------------------------------
// Righe visibili: i figli diretti del nodo radice, più i discendenti dei rami espansi
// ---------------------------------------------------------------------------

function byDeadlineAsc(a, b) {
  return dateSortKey(a.deadline).localeCompare(dateSortKey(b.deadline));
}

// traduce la radice corrente in un valore di parent_id valido su state.tasks: un vero id,
// oppure `null` (tutti i progetti radice) per la sentinella ALL_PROJECTS_ROOT
function realParentIdOf(idOrSentinel) {
  return idOrSentinel === ALL_PROJECTS_ROOT ? null : idOrSentinel;
}

// nodo stesso + tutti i discendenti che a loro volta hanno figli (stessa logica di
// collectExpandableIds nell'albero, riscritta sulla lista piatta state.tasks invece che su
// un albero già costruito con .children). `nodeId === null` = tutti i progetti radice: non
// esiste una riga reale per "null" stesso, quindi non va aggiunto all'insieme
function collectExpandableIds(nodeId) {
  const ids = nodeId === null ? [] : [nodeId];
  state.tasks
    .filter((t) => t.parent_id === nodeId && t.children_count > 0)
    .forEach((child) => ids.push(...collectExpandableIds(child.id)));
  return ids;
}

// vero se OGNI foglia discendente di questo ramo ha uno status chiuso (CLOSED_STATUSES in
// utils.js: COMPLETATO, INTERROTTO, QUARANTENA) — usato per colorare di grigio la barra del
// ramo nel Gantt (vedi GANTT_BRANCH_CLOSED_COLOR). Stessa logica ricorsiva di
// collectExpandableIds, sulla lista piatta state.tasks
function isBranchClosed(nodeId) {
  const children = state.tasks.filter((t) => t.parent_id === nodeId);
  if (children.length === 0) return false;
  return children.every((child) =>
    child.children_count > 0 ? isBranchClosed(child.id) : CLOSED_STATUSES.has(child.status)
  );
}

function branchToggleAllButton(node) {
  const branchIds = collectExpandableIds(node.id);
  const allExpanded = branchIds.every((id) => expandedIds.has(id));

  const btn = document.createElement("button");
  btn.className = "branch-toggle-btn";
  btn.textContent = allExpanded ? "⊖" : "⊕";
  btn.title = allExpanded ? "Collassa tutti i discendenti" : "Espandi tutti i discendenti";
  btn.onclick = () => {
    if (allExpanded) branchIds.forEach((id) => expandedIds.delete(id));
    else branchIds.forEach((id) => expandedIds.add(id));
    draw();
  };
  return btn;
}

function buildVisibleRows() {
  const rows = [];
  function walk(parentId, depth) {
    state.tasks
      .filter((t) => t.parent_id === parentId)
      .sort(byDeadlineAsc)
      .forEach((node) => {
        rows.push({ node, depth });
        if (node.children_count > 0 && expandedIds.has(node.id)) {
          walk(node.id, depth + 1);
        }
      });
  }
  walk(realParentIdOf(rootId), 0);
  return rows;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function draw() {
  // pulizia difensiva: un tooltip di data agganciato a una maniglia che questo stesso
  // redraw sta per distruggere non riceverebbe mai il suo mouseleave (vedi
  // attachHandleDateTooltip più sotto e il commento su removeAllDragTooltips in timeline.js)
  removeAllDragTooltips();

  const isGlobal = rootId === ALL_PROJECTS_ROOT;
  const rootNode = isGlobal ? null : state.tasks.find((t) => t.id === rootId);
  if (!isGlobal && !rootNode) {
    closeGantt();
    return;
  }
  titleEl.textContent = isGlobal
    ? `Gantt — Tutti i progetti (${state.currentUser?.username ?? ""})`
    : `Gantt — ${rootNode.title}`;

  const rows = buildVisibleRows();
  const visibleIds = new Set(rows.map((r) => r.node.id));

  drawToolbar();
  drawOutline(rows, visibleIds);
  drawTimeline(rows, visibleIds);
}

function drawToolbar() {
  toolbarEl.innerHTML = "";
  GRANULARITIES.forEach(({ key, label }) => {
    const btn = document.createElement("button");
    btn.className = "filter-group-btn";
    btn.classList.toggle("active", granularity === key);
    btn.textContent = label;
    btn.onclick = () => {
      granularity = key;
      hasScrolledToToday = false; // cambiando scala ha senso ri-centrare su oggi
      draw();
    };
    toolbarEl.appendChild(btn);
  });

  // espandi/collassa tutto il sottoalbero del nodo radice di questo Gantt (non solo i
  // singoli rami, come il bottone ⊕/⊖ per riga): stessa coppia di azioni già presente
  // sopra l'albero in vista Albero
  const expandAllBtn = document.createElement("button");
  expandAllBtn.className = "filter-group-btn";
  expandAllBtn.textContent = "Espandi tutto";
  expandAllBtn.onclick = () => {
    expandedIds = new Set(collectExpandableIds(realParentIdOf(rootId)));
    draw();
  };
  toolbarEl.appendChild(expandAllBtn);

  const collapseAllBtn = document.createElement("button");
  collapseAllBtn.className = "filter-group-btn";
  collapseAllBtn.textContent = "Collassa tutto";
  collapseAllBtn.onclick = () => {
    expandedIds.clear();
    draw();
  };
  toolbarEl.appendChild(collapseAllBtn);
}

// menu tasto destro sulla riga dell'outline: solo Configurazione e Aggiungi foglia (niente
// più apertura diretta cliccando sul nome, vedi drawOutline) — "Aggiungi foglia" richiede
// di essere owner di QUESTO nodo (un ramo delegato visto in sola lettura dal committente
// resta configurabile in lettura, ma non può accettare nuovi figli)
function rowContextMenuItems(node, hasChildren, isOwner) {
  const items = [
    { label: "Configurazione", onClick: () => openEditModal(node) },
  ];
  if (isOwner) {
    const canAddChild = hasChildren || node.label !== "CHIUSO";
    items.push({
      label: "Aggiungi foglia",
      disabled: !canAddChild,
      onClick: () => openCreateModal(node.id),
    });
  }
  return items;
}

function drawOutline(rows, visibleIds) {
  outlineBody.innerHTML = "";

  if (rows.length === 0) {
    const empty = document.createElement("div");
    empty.className = "gantt-outline-row";
    empty.textContent = "Nessun figlio";
    outlineBody.appendChild(empty);
    return;
  }

  rows.forEach(({ node, depth }) => {
    const isOwner = node.owner_id === state.currentUser?.id;
    const rowEl = document.createElement("div");
    rowEl.className = "gantt-outline-row";
    rowEl.style.paddingLeft = `${8 + depth * 16}px`;

    const hasChildren = node.children_count > 0;
    if (hasChildren) {
      const toggle = document.createElement("button");
      toggle.className = "gantt-row-toggle";
      toggle.textContent = expandedIds.has(node.id) ? "▼" : "▶";
      toggle.onclick = () => {
        if (expandedIds.has(node.id)) expandedIds.delete(node.id);
        else expandedIds.add(node.id);
        draw();
      };
      rowEl.appendChild(toggle);
      rowEl.appendChild(branchToggleAllButton(node));
    } else {
      const spacer = document.createElement("span");
      spacer.className = "gantt-row-spacer";
      rowEl.appendChild(spacer);

      const meta = STATUS_META[node.status];
      if (meta) {
        const statusEl = document.createElement("span");
        statusEl.className = "gantt-row-status";
        statusEl.textContent = meta.symbol;
        statusEl.title = meta.label;
        statusEl.style.color = meta.color;
        rowEl.appendChild(statusEl);
      }
    }

    const title = document.createElement("span");
    title.className = "gantt-row-title";
    title.textContent = node.title;
    rowEl.appendChild(title);

    const externalDeps = (node.dependency_ids || []).filter((id) => !visibleIds.has(id));
    if (externalDeps.length > 0) {
      const names = externalDeps
        .map((id) => state.tasks.find((t) => t.id === id))
        .filter(Boolean)
        .map((t) => t.title);
      const badge = document.createElement("button");
      badge.className = "gantt-row-dep-badge";
      badge.textContent = "🔗";
      badge.title = `Dipende anche da un altro progetto: ${names.join(", ")}`;
      badge.onclick = () => {
        setDependencyHighlight(node);
        closeGantt();
        jumpToTree(externalDeps[0]);
      };
      rowEl.appendChild(badge);
    }

    rowEl.title = "Clic destro: Configurazione / Aggiungi foglia. Clic nella riga a destra: apri configurazione.";
    rowEl.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      showContextMenu(e.clientX, e.clientY, rowContextMenuItems(node, hasChildren, isOwner));
    });

    outlineBody.appendChild(rowEl);
  });

  // linee verticali di guida, sotto ogni ramo espanso, per evidenziarne i discendenti:
  // allineate orizzontalmente al centro del triangolo ▼ che le origina, dalla base della
  // sua riga fino alla base dell'ultimo discendente contiguo (profondità maggiore della sua)
  rows.forEach(({ node, depth }, i) => {
    if (node.children_count === 0 || !expandedIds.has(node.id)) return;
    let lastDescendant = i;
    while (lastDescendant + 1 < rows.length && rows[lastDescendant + 1].depth > depth) {
      lastDescendant++;
    }
    if (lastDescendant === i) return;

    const line = document.createElement("div");
    line.className = "gantt-outline-guide-line";
    line.style.left = `${16 * (depth + 1)}px`;
    line.style.top = `${(i + 1) * ROW_HEIGHT}px`;
    line.style.height = `${(lastDescendant - i) * ROW_HEIGHT}px`;
    outlineBody.appendChild(line);
  });
}

// mostra la data impostata (non un'anteprima di trascinamento) al passaggio del mouse su
// un pallino estremo — solo per le granularità più larghe di "giorno", dove la posizione
// da sola non basta a leggere la data con precisione
function attachHandleDateTooltip(handle, getDateISO) {
  let tooltip = null;
  handle.addEventListener("mouseenter", () => {
    if (granularity === "giorno") return;
    const iso = getDateISO();
    if (!iso) return;
    const rect = handle.getBoundingClientRect();
    tooltip = createDragTooltip();
    updateDragTooltip(tooltip, parseISO(iso), rect.left + rect.width / 2, rect.top + rect.height / 2);
  });
  handle.addEventListener("mouseleave", () => {
    if (tooltip) {
      removeDragTooltip(tooltip);
      tooltip = null;
    }
  });
}

// apre la configurazione al click su barra/etichetta/riga (vedi drawTimeline), tranne se il
// click è in realtà la coda di un trascinamento appena concluso su una maniglia (vedi
// isDragJustHappened in timeline.js)
function openEditModalUnlessDragged(node) {
  if (isDragJustHappened()) return;
  openEditModal(node);
}

// se un tratto verticale calcolato cade troppo vicino alla linea "oggi" (stessa X, la linea
// occupa tutta l'altezza del Gantt: una qualunque coincidenza in X è una sovrapposizione
// visiva completa, indipendentemente dal tratto Y del segmento), lo scosta del margine
// minimo dal lato in cui già si trova
function keepAwayFromTodayLine(x, todayOffset) {
  if (todayOffset === null || Math.abs(x - todayOffset) >= DEP_ARROW_TODAY_MARGIN) return x;
  return x <= todayOffset ? todayOffset - DEP_ARROW_TODAY_MARGIN : todayOffset + DEP_ARROW_TODAY_MARGIN;
}

function drawSummaryChart(buckets, totalWidth) {
  timelineChartInner.innerHTML = "";
  outlineChartSpacer.innerHTML = "";
  timelineChartInner.style.width = `${totalWidth}px`;

  const series = buildLeafSeries(summaryLeaves, buckets);
  const maxY = computeMaxY([{ values: series }]);

  // buildAxisLabels presuppone di stare in un contenitore flex che gli dia altezza (come
  // .workload-chart-axis nella vista Carico di lavoro): qui #gantt-outline-chart-spacer non
  // è un flex-parent, quindi senza un'altezza esplicita le etichette (posizionate in
  // percentuale) collassavano tutte a top:0, illeggibili una sopra l'altra
  const axisLabels = buildAxisLabels(maxY);
  axisLabels.style.height = "100%";
  outlineChartSpacer.appendChild(axisLabels);
  timelineChartInner.appendChild(
    buildChartSvg(buckets, totalWidth, [{ values: series, className: "workload-chart-global-line" }], maxY)
  );
}

function drawTimeline(rows, visibleIds) {
  timelineHeader.innerHTML = "";
  timelineSuperHeader.innerHTML = "";
  timelineInner.innerHTML = "";

  const buckets = buildBuckets(rows.map((r) => r.node), granularity);
  const totalWidth = buckets.reduce((sum, b) => sum + b.width, 0);
  const todayIndex = buckets.findIndex((b) => b.isToday);
  const totalHeight = Math.max(rows.length * ROW_HEIGHT, 1);

  timelineHeader.style.width = `${totalWidth}px`;
  timelineInner.style.width = `${totalWidth}px`;
  timelineInner.style.height = `${totalHeight}px`;

  drawSummaryChart(buckets, totalWidth);

  // fascia superiore (settimane/mesi/anni raggruppati): per "anno" (vista "Globale") non
  // c'è raggruppamento, ma la fascia resta comunque presente (vuota, grigia) invece di
  // collassare a 0 — così l'altezza non cambia cambiando granularità
  const superGroups = buildSuperHeaderGroups(buckets, granularity);
  outlineSuperHeader.style.height = `${SUPER_HEADER_HEIGHT}px`;
  timelineSuperHeaderScroll.style.height = `${SUPER_HEADER_HEIGHT}px`;
  timelineSuperHeader.style.width = `${totalWidth}px`;
  if (superGroups.length > 0) {
    superGroups.forEach((g) => {
      const cell = document.createElement("div");
      cell.className = "super-header-cell";
      cell.style.width = `${g.width}px`;
      cell.textContent = g.label;
      timelineSuperHeader.appendChild(cell);
    });
  } else {
    const filler = document.createElement("div");
    filler.className = "super-header-cell";
    filler.style.width = `${totalWidth}px`;
    timelineSuperHeader.appendChild(filler);
  }

  buckets.forEach((b) => {
    const cell = document.createElement("div");
    cell.className = "calendar-bucket-header";
    cell.classList.toggle("weekend", !!b.isWeekend);
    cell.style.width = `${b.width}px`;
    cell.style.height = `${HEADER_HEIGHT}px`;
    b.label.forEach((line) => {
      const lineEl = document.createElement("div");
      lineEl.textContent = line;
      cell.appendChild(lineEl);
    });
    timelineHeader.appendChild(cell);
  });

  // sfondo grigio per le colonne di sabato/domenica (vista Giorno)
  buckets.forEach((b, i) => {
    if (!b.isWeekend) return;
    const band = document.createElement("div");
    band.className = "calendar-weekend-band";
    band.style.left = `${bucketOffset(buckets, i)}px`;
    band.style.width = `${b.width}px`;
    band.style.height = `${totalHeight}px`;
    timelineInner.appendChild(band);
  });

  // linee verticali di separazione fra i bucket
  buckets.forEach((b, i) => {
    const line = document.createElement("div");
    line.className = "calendar-grid-line";
    line.style.left = `${bucketOffset(buckets, i) + b.width}px`;
    line.style.height = `${totalHeight}px`;
    timelineInner.appendChild(line);
  });

  // linee orizzontali di separazione fra le righe, stesso bordo di .gantt-outline-row:
  // aiutano a capire a quale riga/task corrisponde ogni barra
  rows.forEach((row, i) => {
    const rowLine = document.createElement("div");
    rowLine.className = "calendar-row-line";
    rowLine.style.top = `${(i + 1) * ROW_HEIGHT}px`;
    rowLine.style.width = `${totalWidth}px`;
    timelineInner.appendChild(rowLine);
  });

  // rettangolo-bracket per ogni ramo espanso: solo bordo, esattamente dello stesso colore
  // della sua barra (azzurro/grigio, vedi sopra), a racchiudere la barra del ramo stesso più
  // quelle di TUTTI i suoi discendenti visibili (non solo i figli diretti) — aiuta a capire
  // a colpo d'occhio quali barre appartengono allo stesso ramo in alberi con molti livelli.
  // Stessa individuazione dei discendenti contigui delle guide line verticali dell'outline
  // (vedi drawOutline)
  rows.forEach((row, i) => {
    const { node, depth } = row;
    if (node.children_count === 0 || !expandedIds.has(node.id)) return;
    let lastDescendant = i;
    while (lastDescendant + 1 < rows.length && rows[lastDescendant + 1].depth > depth) {
      lastDescendant++;
    }
    if (lastDescendant === i) return;

    let left = Infinity;
    let right = -Infinity;
    for (let j = i + 1; j <= lastDescendant; j++) {
      const range = barRangeForNode(rows[j].node, buckets);
      if (!range) continue;
      left = Math.min(left, range.left);
      right = Math.max(right, range.left + range.width);
    }
    // include anche la barra del ramo stesso (il rettangolo la racchiude, vedi sotto): di
    // norma coincide già con l'inviluppo dei figli grazie al rollup automatico delle date
    // (vedi app.py), ma non è garantito che sia sempre identico
    const ownRange = barRangeForNode(node, buckets);
    if (ownRange) {
      left = Math.min(left, ownRange.left);
      right = Math.max(right, ownRange.left + ownRange.width);
    }
    if (left === Infinity) return; // nessun discendente con date impostate

    // il lato superiore passa appena sopra la barra del ramo (la racchiude, invece di
    // partire da sotto di essa): stessa geometria riga/barra della resa barre più sotto
    // (top=i*ROW_HEIGHT+ROW_HEIGHT*0.2)
    const parentBarTop = i * ROW_HEIGHT + ROW_HEIGHT * 0.2;
    const GAP = 3;
    const top = parentBarTop - GAP;
    const bottom = (lastDescendant + 1) * ROW_HEIGHT - 2;

    const bracket = document.createElement("div");
    bracket.className = "gantt-branch-bracket";
    bracket.style.left = `${left - 4}px`;
    bracket.style.width = `${right - left + 8}px`;
    bracket.style.top = `${top}px`;
    bracket.style.height = `${bottom - top}px`;
    bracket.style.borderColor = isBranchClosed(node.id) ? GANTT_BRANCH_CLOSED_COLOR : GANTT_BRANCH_COLOR;
    timelineInner.appendChild(bracket);
  });

  // area cliccabile a piena larghezza per ogni riga (dietro a barra/maniglie, vedi sotto):
  // apre la configurazione cliccando in un punto qualunque della riga, anche dove non c'è
  // una barra (task senza date) o a fianco di essa
  rows.forEach((row, i) => {
    const hitbox = document.createElement("div");
    hitbox.className = "gantt-row-hitbox";
    hitbox.style.top = `${i * ROW_HEIGHT}px`;
    hitbox.style.width = `${totalWidth}px`;
    hitbox.style.height = `${ROW_HEIGHT}px`;
    hitbox.onclick = () => openEditModalUnlessDragged(row.node);
    timelineInner.appendChild(hitbox);
  });

  const todayOffset = todayLineOffset(buckets);
  if (todayOffset !== null) {
    const todayLine = document.createElement("div");
    todayLine.className = "calendar-today-line";
    todayLine.style.left = `${todayOffset}px`;
    todayLine.style.height = `${totalHeight}px`;
    timelineInner.appendChild(todayLine);
  }

  // layer SVG per le frecce di dipendenza, sopra la griglia ma sotto le barre
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "gantt-deps-svg");
  svg.setAttribute("width", totalWidth);
  svg.setAttribute("height", totalHeight);
  svg.style.position = "absolute";
  svg.style.top = "0";
  svg.style.left = "0";
  svg.style.pointerEvents = "none";

  const defs = document.createElementNS(SVG_NS, "defs");
  const marker = document.createElementNS(SVG_NS, "marker");
  marker.setAttribute("id", "gantt-arrowhead");
  marker.setAttribute("viewBox", "0 0 10 10");
  marker.setAttribute("refX", "9");
  marker.setAttribute("refY", "5");
  marker.setAttribute("markerWidth", "7");
  marker.setAttribute("markerHeight", "7");
  marker.setAttribute("orient", "auto-start-reverse");
  const arrowHeadPath = document.createElementNS(SVG_NS, "path");
  arrowHeadPath.setAttribute("d", "M0,0 L10,5 L0,10 z");
  arrowHeadPath.setAttribute("fill", DEP_ARROW_COLOR);
  marker.appendChild(arrowHeadPath);
  defs.appendChild(marker);
  svg.appendChild(defs);
  timelineInner.appendChild(svg);

  const barElements = new Map(); // node.id -> elemento .calendar-bar (posizione letta dal suo style live)
  const rowIndexById = new Map();
  rows.forEach((row, i) => rowIndexById.set(row.node.id, i));

  // nodeId -> elenco dei nodi (fra quelli visibili) che dipendono da lui: serve sia per
  // decidere se disegnare l'indicatore "uscente" a destra della sua barra, sia — quando
  // quell'indicatore viene attivato — per sapere verso quali barre tracciare le frecce
  const dependentsOf = new Map();
  rows.forEach(({ node }) => {
    (node.dependency_ids || []).forEach((depId) => {
      if (!visibleIds.has(depId)) return;
      if (!dependentsOf.has(depId)) dependentsOf.set(depId, []);
      dependentsOf.get(depId).push(node);
    });
  });

  // disegna la freccia completa (instradamento a gomito) da un nodo sorgente a uno di
  // destinazione, leggendo la posizione CORRENTE delle barre (che durante un trascinamento
  // riflette già il nuovo left/width, anche prima che il salvataggio committi)
  function drawArrow(sourceId, targetId, todayOffset) {
    const sourceIdx = rowIndexById.get(sourceId);
    const targetIdx = rowIndexById.get(targetId);
    const sourceBar = barElements.get(sourceId);
    const targetBar = barElements.get(targetId);
    if (sourceIdx === undefined || targetIdx === undefined || !sourceBar || !targetBar) return;

    const sourceCenterY = sourceIdx * ROW_HEIGHT + ROW_HEIGHT / 2;
    const targetCenterY = targetIdx * ROW_HEIGHT + ROW_HEIGHT / 2;
    const sourceRightX = parseFloat(sourceBar.style.left) + parseFloat(sourceBar.style.width);
    const targetLeftX = parseFloat(targetBar.style.left);
    const tipX = targetLeftX - DEP_ARROW_TIP_GAP; // la punta si ferma prima della barra, senza entrarci

    let d;
    if (tipX - DEP_ARROW_STUB >= sourceRightX) {
      // c'è abbastanza spazio in avanti da percorrere anche l'intero tratto
      // orizzontale di entrata (DL della dipendenza < EX del dipendente meno la
      // lunghezza di quel tratto): non c'è bisogno di tornare indietro, si va dritti
      // in avanti e si scende/sale, senza passare dallo spazio bianco fra la barra
      // sorgente e quella adiacente — l'ultimo tratto, quello che entra nella punta,
      // resta comunque orizzontale e della stessa lunghezza dell'altro caso
      const elbowX = keepAwayFromTodayLine(tipX - DEP_ARROW_STUB, todayOffset);
      d = `M${sourceRightX},${sourceCenterY} L${elbowX},${sourceCenterY} L${elbowX},${targetCenterY} L${tipX},${targetCenterY}`;
    } else {
      // spazio bianco subito sotto la barra sorgente (sopra, se il dipendente sta più
      // in alto nell'elenco), dove corre il tratto orizzontale centrale
      const goingDown = targetIdx > sourceIdx;
      const gapY = goingDown ? (sourceIdx + 1) * ROW_HEIGHT : sourceIdx * ROW_HEIGHT;
      // due tratti diritti della stessa lunghezza: uno appena usciti dalla barra
      // sorgente (prima di scendere/salire nello spazio bianco), uno appena prima
      // della punta — entrambi scostati dalla linea "oggi" se ci cadono sopra
      const stubOutX = keepAwayFromTodayLine(sourceRightX + DEP_ARROW_STUB, todayOffset);
      const elbowX = keepAwayFromTodayLine(tipX - DEP_ARROW_STUB, todayOffset);
      d =
        `M${sourceRightX},${sourceCenterY} ` +
        `L${stubOutX},${sourceCenterY} ` +
        `L${stubOutX},${gapY} ` +
        `L${elbowX},${gapY} ` +
        `L${elbowX},${targetCenterY} ` +
        `L${tipX},${targetCenterY}`;
    }

    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    path.setAttribute("class", "gantt-dep-arrow");
    path.setAttribute("marker-end", "url(#gantt-arrowhead)");
    svg.appendChild(path);
  }

  // indicatori (nodeId+direzione) che "partecipano" alla selezione corrente: quello
  // cliccato più, per ciascuna freccia completa che ne deriva, l'indicatore all'altro suo
  // estremo (l'uscente della sorgente per una selezione entrante, l'entrante di ogni
  // dipendente per una selezione uscente) — così l'intero percorso evidenziato in rosso
  // si riconosce a colpo d'occhio anche sui piccoli indicatori, non solo sulla freccia
  function computeParticipatingIndicators() {
    const participating = new Set();
    if (!activeDepsSelection) return participating;
    const { nodeId, direction } = activeDepsSelection;
    participating.add(`${nodeId}:${direction}`);
    if (direction === "in") {
      const node = rows[rowIndexById.get(nodeId)]?.node;
      (node?.dependency_ids || []).forEach((depId) => {
        if (visibleIds.has(depId)) participating.add(`${depId}:out`);
      });
    } else {
      (dependentsOf.get(nodeId) || []).forEach((depNode) => participating.add(`${depNode.id}:in`));
    }
    return participating;
  }

  // gli indicatori (piccola freccia, vedi createDepIndicator) restano sempre visibili; solo
  // le frecce COMPLETE sono mostrate su richiesta, una direzione alla volta, per evitare il
  // "groviglio di spaghetti" di mostrarle tutte insieme
  function updateDepIndicatorsActiveState() {
    const participating = computeParticipatingIndicators();
    svg.querySelectorAll(".gantt-dep-indicator").forEach((g) => {
      g.classList.toggle("active", participating.has(`${g.dataset.nodeId}:${g.dataset.direction}`));
    });
  }

  function toggleDepsSelection(nodeId, direction) {
    activeDepsSelection =
      activeDepsSelection && activeDepsSelection.nodeId === nodeId && activeDepsSelection.direction === direction
        ? null
        : { nodeId, direction };
    redrawArrows();
  }

  function redrawArrows() {
    [...svg.querySelectorAll("path.gantt-dep-arrow")].forEach((p) => p.remove());
    updateDepIndicatorsActiveState();
    if (!activeDepsSelection) return;
    const todayOffset = todayLineOffset(buckets);
    const { nodeId, direction } = activeDepsSelection;
    if (direction === "in") {
      const node = rows[rowIndexById.get(nodeId)]?.node;
      (node?.dependency_ids || []).forEach((depId) => {
        if (visibleIds.has(depId)) drawArrow(depId, nodeId, todayOffset);
      });
    } else {
      (dependentsOf.get(nodeId) || []).forEach((depNode) => drawArrow(nodeId, depNode.id, todayOffset));
    }
  }

  // piccola freccia indicatrice (senza instradamento, solo un tratto fisso): "in" = questo
  // nodo ha almeno una dipendenza (freccia entrante a sinistra), "out" = qualcun altro
  // dipende da questo nodo (freccia uscente a destra). Il triangolino in punta è cliccabile
  // (area di hit invisibile e più generosa sopra di esso) e mostra/nasconde le frecce
  // complete di quella direzione (vedi toggleDepsSelection) — non disegna mai la freccia da sé
  function createDepIndicator(direction, nodeId, edgeX, centerY) {
    const g = document.createElementNS(SVG_NS, "g");
    g.setAttribute("class", "gantt-dep-indicator");
    g.dataset.nodeId = String(nodeId);
    g.dataset.direction = direction;

    // la punta è sempre rivolta verso destra (stesso verso di percorrenza delle frecce
    // complete): vicina alla barra per una freccia entrante, lontana per una uscente
    const tipX = direction === "in" ? edgeX - 2 : edgeX + DEP_INDICATOR_STUB;
    const stubStartX = direction === "in" ? edgeX - DEP_INDICATOR_STUB : edgeX + 2;
    const baseX = tipX - DEP_INDICATOR_TRI_W;

    const line = document.createElementNS(SVG_NS, "line");
    line.setAttribute("x1", stubStartX);
    line.setAttribute("x2", baseX);
    line.setAttribute("y1", centerY);
    line.setAttribute("y2", centerY);
    line.setAttribute("class", "gantt-dep-indicator-stub");
    g.appendChild(line);

    const triangle = document.createElementNS(SVG_NS, "path");
    triangle.setAttribute(
      "d",
      `M${tipX},${centerY} L${baseX},${centerY - DEP_INDICATOR_TRI_H / 2} L${baseX},${centerY + DEP_INDICATOR_TRI_H / 2} Z`
    );
    triangle.setAttribute("class", "gantt-dep-indicator-triangle");
    g.appendChild(triangle);

    // area cliccabile invisibile, più generosa del triangolino visibile (7-8px, scomodo da
    // centrare col mouse), centrata sul suo punto medio
    const hitArea = document.createElementNS(SVG_NS, "circle");
    hitArea.setAttribute("cx", (tipX + baseX) / 2);
    hitArea.setAttribute("cy", centerY);
    hitArea.setAttribute("r", DEP_INDICATOR_HIT_R);
    hitArea.setAttribute("class", "gantt-dep-indicator-hitarea");
    hitArea.style.pointerEvents = "auto";
    hitArea.title =
      direction === "in" ? "Mostra le dipendenze di questo task" : "Mostra i task che dipendono da questo";
    hitArea.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleDepsSelection(nodeId, direction);
    });
    g.appendChild(hitArea);

    svg.appendChild(g);
  }

  // le barre: una per riga con execution_date/deadline (per un ramo sono quelle del
  // rollup automatico, vedi app.py — nessuna logica di summary-bar da scrivere qui)
  rows.forEach((row, i) => {
    const { node } = row;
    const range = barRangeForNode(node, buckets);
    if (!range) return;

    const bar = document.createElement("div");
    bar.className = "calendar-bar";
    const meta = STATUS_META[node.status];
    // un ramo non ha uno status (è il rollup dei figli): azzurro, per distinguerlo a
    // colpo d'occhio da tutti gli status reali delle foglie — grigio invece se tutte le
    // sue foglie discendenti sono chiuse (vedi isBranchClosed)
    bar.style.background = meta
      ? meta.color
      : isBranchClosed(node.id)
        ? GANTT_BRANCH_CLOSED_COLOR
        : GANTT_BRANCH_COLOR;
    bar.style.left = `${range.left + 1}px`;
    bar.style.width = `${Math.max(range.width - 2, 4)}px`;
    bar.style.top = `${i * ROW_HEIGHT + ROW_HEIGHT * 0.2}px`;
    bar.style.height = `${ROW_HEIGHT * 0.6}px`;
    bar.title = node.title;

    // indicatori di dipendenza (vedi createDepIndicator): a sinistra se questo nodo dipende
    // da almeno un altro, a destra se almeno un altro nodo visibile dipende da questo
    const centerY = i * ROW_HEIGHT + ROW_HEIGHT / 2;
    if ((node.dependency_ids || []).length > 0) {
      createDepIndicator("in", node.id, range.left + 1, centerY);
    }
    if ((dependentsOf.get(node.id) || []).length > 0) {
      createDepIndicator("out", node.id, range.left + 1 + Math.max(range.width - 2, 4), centerY);
    }
    bar.style.cursor = "pointer";
    // clic sulla barra stessa (non su una maniglia): apre la configurazione. Il controllo
    // isDragJustHappened() (vedi openEditModalUnlessDragged) serve perché, se durante il
    // trascinamento di una maniglia la data si aggancia a un giorno diverso da dove il
    // mouse viene rilasciato, il cursore può finire sul corpo della barra invece che sulla
    // maniglia: il click nativo risulterebbe allora su QUESTO listener, non su quello della
    // maniglia (che da solo non basterebbe a distinguere "ho trascinato" da "ho cliccato")
    bar.onclick = () => openEditModalUnlessDragged(node);

    // nome del nodo, in nero, a una certa distanza a destra della barra: sopra all'area
    // cliccabile della riga (hitbox), quindi serve un click proprio per apire comunque la
    // configurazione, altrimenti la intercetterebbe senza fare nulla
    const label = document.createElement("div");
    label.className = "gantt-bar-label";
    label.style.cursor = "pointer";
    label.onclick = () => openEditModalUnlessDragged(node);
    const labelText = document.createElement("span");
    labelText.textContent = node.title;
    label.appendChild(labelText);
    label.style.top = `${i * ROW_HEIGHT}px`;
    const repositionLabel = () => {
      label.style.left = `${parseFloat(bar.style.left) + parseFloat(bar.style.width) + LABEL_OFFSET}px`;
    };
    repositionLabel();

    // le date di un ramo sono il rollup automatico dei figli (non modificabili a mano, il
    // backend le rifiuterebbe): niente agganci di trascinamento sulla sua barra — ma i
    // pallini restano comunque utili come punto su cui passare il mouse per vedere la data
    if (isLeaf(node)) {
      // un task delegato è modificabile solo dall'esecutore (owner): per il committente
      // i puntini restano solo informativi, come per una data calcolata su un ramo
      const isOwner = node.owner_id === state.currentUser?.id;
      const draggable = DRAGGABLE_GRANULARITIES.has(granularity) && isOwner;

      const leftHandle = document.createElement("div");
      leftHandle.className = draggable ? "calendar-bar-handle left" : "calendar-bar-handle left info-only";
      bar.appendChild(leftHandle);
      attachHandleDateTooltip(leftHandle, () => node.execution_date);

      const rightHandle = document.createElement("div");
      rightHandle.className = draggable ? "calendar-bar-handle right" : "calendar-bar-handle right info-only";
      bar.appendChild(rightHandle);
      attachHandleDateTooltip(rightHandle, () => node.deadline);

      if (draggable) {
        const onDrag = () => {
          repositionLabel();
          redrawArrows();
        };
        const onClick = () => openEditModal(node);
        attachBarHandleDrag(leftHandle, "left", node, buckets, totalWidth, timelineInner, bar, { onDrag, onClick });
        attachBarHandleDrag(rightHandle, "right", node, buckets, totalWidth, timelineInner, bar, { onDrag, onClick });

        const centerHandle = document.createElement("div");
        centerHandle.className = "calendar-bar-handle center";
        centerHandle.title = "Trascina per spostare l'intera barra, clic per aprire la configurazione";
        bar.appendChild(centerHandle);
        attachBarMoveDrag(centerHandle, node, buckets, totalWidth, timelineInner, bar, { onDrag, onClick });
      } else if (DRAGGABLE_GRANULARITIES.has(granularity) && !isOwner) {
        // se il nodo è visibile qui ma non è dell'owner corrente, è per forza perché il
        // viewer ne è il committente (GET /tasks non restituirebbe righe altrui altrimenti)
        attachLockedBarNotice(leftHandle);
        attachLockedBarNotice(rightHandle);
      }
    }

    timelineInner.appendChild(bar);
    timelineInner.appendChild(label);
    barElements.set(node.id, bar);
  });

  redrawArrows();

  if (!hasScrolledToToday && todayIndex >= 0) {
    timelineScroll.scrollLeft = Math.max(bucketOffset(buckets, todayIndex) - 40, 0);
    hasScrolledToToday = true;
  }
  timelineHeaderScroll.scrollLeft = timelineScroll.scrollLeft;
  timelineSuperHeaderScroll.scrollLeft = timelineScroll.scrollLeft;
  timelineChartScroll.scrollLeft = timelineScroll.scrollLeft;
}
