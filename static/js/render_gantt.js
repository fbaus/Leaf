// Vista Gantt per-nodo: apribile dal menu tasto destro sull'albero, mostra i figli di un
// nodo come barre su una timeline condivisa (execution_date=inizio, deadline=fine), con
// righe espandibili per i figli che a loro volta hanno figli, e frecce per le dipendenze
// fra barre entrambe visibili. Riusa il drag delle barre già scritto per il calendario
// (vedi timeline.js) e il rollup automatico delle date sui rami (vedi app.py) per le
// "summary bar" dei nodi con figli, senza bisogno di logica propria.

import { state, reload } from "./state.js";
import { STATUS_META, isLeaf, dateSortKey } from "./utils.js";
import { openEditModal } from "./modal.js";
import { recomputeRollup } from "./api.js";
import { setDependencyHighlight } from "./deps_highlight.js";
import { jumpToTree } from "./navigate.js";
import {
  GRANULARITIES,
  DRAGGABLE_GRANULARITIES,
  buildBuckets,
  buildSuperHeaderGroups,
  bucketOffset,
  barRangeForNode,
  attachBarHandleDrag,
  attachBarMoveDrag,
  createDragTooltip,
  updateDragTooltip,
  parseISO,
} from "./timeline.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const ROW_HEIGHT = 28; // deve combaciare con .gantt-outline-row (style.css)
const HEADER_HEIGHT = 40; // deve combaciare con #gantt-outline-header/#gantt-timeline-header-scroll
const SUPER_HEADER_HEIGHT = 20; // fascia settimane/mesi/anni sopra l'intestazione normale, 0 se nascosta (vista "Globale")
const DEP_ARROW_COLOR = "#ef6c00";
const GANTT_BRANCH_COLOR = "#4fc3f7";
// tratto diritto, della stessa lunghezza, sia subito dopo l'uscita dalla barra sorgente
// sia subito prima della punta (che si ferma un po' prima della barra dipendente, senza entrarci)
const DEP_ARROW_STUB = 14;
const DEP_ARROW_TIP_GAP = 4;
// il nome del nodo parte oltre il tratto d'uscita di un'eventuale freccia di dipendenza,
// così il testo non ci si sovrappone (lo sfondo chiaro del nome copre comunque il tratto
// residuo di una freccia più lunga, quando non deve tornare indietro)
const LABEL_OFFSET = DEP_ARROW_STUB + 16;

const overlay = document.getElementById("gantt-overlay");
const titleEl = document.getElementById("gantt-title");
const toolbarEl = document.getElementById("gantt-toolbar");
const closeBtn = document.getElementById("gantt-close");
const outlineScroll = document.getElementById("gantt-outline-scroll");
const outlineBody = document.getElementById("gantt-outline-body");
const outlineSuperHeader = document.getElementById("gantt-outline-super-header");
const timelineSuperHeaderScroll = document.getElementById("gantt-timeline-super-header-scroll");
const timelineSuperHeader = document.getElementById("gantt-timeline-super-header");
const timelineHeaderScroll = document.getElementById("gantt-timeline-header-scroll");
const timelineHeader = document.getElementById("gantt-timeline-header");
const timelineScroll = document.getElementById("gantt-timeline-scroll");
const timelineInner = document.getElementById("gantt-timeline-inner");

let rootId = null;
let granularity = "giorno";
let expandedIds = new Set();
let hasScrolledToToday = false;

// ---------------------------------------------------------------------------
// Apertura / chiusura
// ---------------------------------------------------------------------------

// prima di mostrare la timeline, ricalcola dal basso il rollup di tutto il sottoalbero:
// "auto-guarigione" contro eventuali derive (es. dati storici precedenti al rollup),
// non solo l'aggiornamento incrementale già garantito a ogni singola modifica
export async function openGanttView(node) {
  granularity = "giorno";
  expandedIds = new Set();
  hasScrolledToToday = false;
  try {
    await recomputeRollup(node.id);
    await reload();
  } catch (err) {
    alert(err.message);
  }
  rootId = node.id;
  overlay.classList.remove("hidden");
  draw();
}

function closeGantt() {
  overlay.classList.add("hidden");
  rootId = null;
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
  if (rootId !== null) draw();
}

// ---------------------------------------------------------------------------
// Sincronizzazione scroll fra il pannello outline e quello della timeline
// ---------------------------------------------------------------------------

let syncingVerticalScroll = false;
timelineScroll.addEventListener("scroll", () => {
  timelineHeaderScroll.scrollLeft = timelineScroll.scrollLeft;
  timelineSuperHeaderScroll.scrollLeft = timelineScroll.scrollLeft;
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
  walk(rootId, 0);
  return rows;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function draw() {
  const rootNode = state.tasks.find((t) => t.id === rootId);
  if (!rootNode) {
    closeGantt();
    return;
  }
  titleEl.textContent = `Gantt — ${rootNode.title}`;

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
    title.title = "Apri configurazione";
    title.onclick = () => openEditModal(node);
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
      tooltip.remove();
      tooltip = null;
    }
  });
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

  if (todayIndex >= 0) {
    const todayLine = document.createElement("div");
    todayLine.className = "calendar-today-line";
    todayLine.style.left = `${bucketOffset(buckets, todayIndex)}px`;
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

  // ricalcola tutte le frecce leggendo la posizione CORRENTE delle barre (che durante un
  // trascinamento riflette già il nuovo left/width, anche prima che il salvataggio committi)
  function redrawArrows() {
    [...svg.querySelectorAll("path.gantt-dep-arrow")].forEach((p) => p.remove());
    rows.forEach((row, i) => {
      (row.node.dependency_ids || []).forEach((depId) => {
        if (!visibleIds.has(depId)) return;
        const sourceIdx = rowIndexById.get(depId);
        const sourceBar = barElements.get(depId);
        const targetBar = barElements.get(row.node.id);
        if (sourceIdx === undefined || !sourceBar || !targetBar) return;

        const targetIdx = i;
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
          const elbowX = tipX - DEP_ARROW_STUB;
          d = `M${sourceRightX},${sourceCenterY} L${elbowX},${sourceCenterY} L${elbowX},${targetCenterY} L${tipX},${targetCenterY}`;
        } else {
          // spazio bianco subito sotto la barra sorgente (sopra, se il dipendente sta più
          // in alto nell'elenco), dove corre il tratto orizzontale centrale
          const goingDown = targetIdx > sourceIdx;
          const gapY = goingDown ? (sourceIdx + 1) * ROW_HEIGHT : sourceIdx * ROW_HEIGHT;
          // due tratti diritti della stessa lunghezza: uno appena usciti dalla barra
          // sorgente (prima di scendere/salire nello spazio bianco), uno appena prima
          // della punta
          const stubOutX = sourceRightX + DEP_ARROW_STUB;
          const elbowX = tipX - DEP_ARROW_STUB;
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
      });
    });
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
    // colpo d'occhio da tutti gli status reali delle foglie
    bar.style.background = meta ? meta.color : GANTT_BRANCH_COLOR;
    bar.style.left = `${range.left + 1}px`;
    bar.style.width = `${Math.max(range.width - 2, 4)}px`;
    bar.style.top = `${i * ROW_HEIGHT + ROW_HEIGHT * 0.2}px`;
    bar.style.height = `${ROW_HEIGHT * 0.6}px`;
    bar.title = node.title;

    // nome del nodo, in nero, a una certa distanza a destra della barra
    const label = document.createElement("div");
    label.className = "gantt-bar-label";
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
      const draggable = DRAGGABLE_GRANULARITIES.has(granularity);

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
        attachBarHandleDrag(leftHandle, "left", node, buckets, totalWidth, timelineInner, bar, { onDrag });
        attachBarHandleDrag(rightHandle, "right", node, buckets, totalWidth, timelineInner, bar, { onDrag });

        const centerHandle = document.createElement("div");
        centerHandle.className = "calendar-bar-handle center";
        centerHandle.title = "Trascina per spostare l'intera barra";
        bar.appendChild(centerHandle);
        attachBarMoveDrag(centerHandle, node, buckets, totalWidth, timelineInner, bar, { onDrag });
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
}
