import { state, rerender } from "./state.js";
import { STATUS_META } from "./utils.js";
import {
  DRAGGABLE_GRANULARITIES,
  GRANULARITIES,
  buildBuckets,
  bucketOffset,
  barRangeForNode,
  attachBarHandleDrag,
  attachBarMoveDrag,
  cancelActiveDrag,
  beginExclusiveDrag,
  endExclusiveDrag,
} from "./timeline.js";

const TOOLBAR_HEIGHT = 30; // deve combaciare con l'altezza fissata in .calendar-toolbar (style.css)
const PROXY_HEIGHT = 14; // deve combaciare con .calendar-scrollbar-proxy (style.css)

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export function renderCalendarOverlay(mainPanel, leaves) {
  const table = mainPanel.querySelector("table.leaves-table");
  if (!table || !table.tHead) return;

  const granularity = state.calendarGranularity;
  const buckets = buildBuckets(leaves, granularity);
  const totalWidth = buckets.reduce((sum, b) => sum + b.width, 0);
  const todayIndex = buckets.findIndex((b) => b.isToday);

  const tableRect = table.getBoundingClientRect();
  const theadHeight = table.tHead.getBoundingClientRect().height;
  const mainPanelRect = mainPanel.getBoundingClientRect();
  const mainPanelLeft = mainPanelRect.left;
  // il bordo sinistro del calendario è trascinabile fra la fine della colonna Titolo
  // e l'inizio della colonna Data di esecuzione
  const minLeft = table.tHead.rows[0].children[1].getBoundingClientRect().right - mainPanelLeft;
  const maxLeft = table.tHead.rows[0].children[6].getBoundingClientRect().left - mainPanelLeft;
  const defaultLeft = table.tHead.rows[0].children[2].getBoundingClientRect().right - mainPanelLeft;
  const colOffset =
    state.calendarLeftOffset === null
      ? defaultLeft
      : Math.min(Math.max(state.calendarLeftOffset, minLeft), maxLeft);
  const tableHeight = tableRect.height;
  const bodyRows = table.tBodies[0] ? [...table.tBodies[0].rows] : [];

  const overlay = document.createElement("div");
  overlay.className = "calendar-overlay";
  overlay.style.left = `${colOffset}px`;
  // l'overlay non parte dalla cima di #main-panel ma esattamente dalla cima della <table>
  // (sopra c'è la barra filtri): senza questo, la toolbar del calendario (altezza fissa)
  // non combacia con l'altezza reale della barra filtri e .calendar-inner finisce
  // disallineato rispetto alle righe della tabella di qualche pixel
  overlay.style.top = `${tableRect.top - mainPanelRect.top - TOOLBAR_HEIGHT}px`;
  overlay.style.height = `${tableHeight + TOOLBAR_HEIGHT + PROXY_HEIGHT}px`;

  const resizeHandle = document.createElement("div");
  resizeHandle.className = "calendar-resize-handle";
  resizeHandle.addEventListener("mousedown", (e) => {
    e.preventDefault();
    cancelActiveDrag();
    const onMouseMove = (moveEvent) => {
      const newLeft = Math.min(Math.max(moveEvent.clientX - mainPanelLeft, minLeft), maxLeft);
      overlay.style.left = `${newLeft}px`;
      state.calendarLeftOffset = newLeft;
    };
    const onMouseUp = () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      endExclusiveDrag();
    };
    beginExclusiveDrag(onMouseUp);
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  });
  overlay.appendChild(resizeHandle);

  const toolbar = document.createElement("div");
  toolbar.className = "calendar-toolbar";
  GRANULARITIES.forEach(({ key, label }) => {
    const btn = document.createElement("button");
    btn.className = "filter-group-btn";
    btn.classList.toggle("active", granularity === key);
    btn.textContent = label;
    btn.onclick = () => {
      state.calendarGranularity = key;
      rerender();
    };
    toolbar.appendChild(btn);
  });
  overlay.appendChild(toolbar);

  const scroll = document.createElement("div");
  scroll.className = "calendar-scroll";

  const inner = document.createElement("div");
  inner.className = "calendar-inner";
  inner.style.width = `${totalWidth}px`;

  const headerRow = document.createElement("div");
  headerRow.className = "calendar-header-row";
  headerRow.style.height = `${theadHeight}px`;
  buckets.forEach((b) => {
    const cell = document.createElement("div");
    cell.className = "calendar-bucket-header";
    cell.classList.toggle("weekend", !!b.isWeekend);
    cell.style.width = `${b.width}px`;
    cell.style.height = `${theadHeight}px`;
    b.label.forEach((line) => {
      const lineEl = document.createElement("div");
      lineEl.textContent = line;
      cell.appendChild(lineEl);
    });
    headerRow.appendChild(cell);
  });
  inner.appendChild(headerRow);

  // sfondo grigio per le colonne di sabato/domenica (vista Giorno), disegnato per primo
  // così resta sotto le linee della griglia, la linea di "oggi" e le barre
  buckets.forEach((b, i) => {
    if (!b.isWeekend) return;
    const band = document.createElement("div");
    band.className = "calendar-weekend-band";
    band.style.left = `${bucketOffset(buckets, i)}px`;
    band.style.width = `${b.width}px`;
    band.style.height = `${tableHeight}px`;
    inner.appendChild(band);
  });

  // linee verticali grigie di separazione fra i bucket, per tutta l'altezza della tabella
  // (non solo nell'intestazione), disegnate prima delle barre così restano sullo sfondo
  buckets.forEach((b, i) => {
    const line = document.createElement("div");
    line.className = "calendar-grid-line";
    line.style.left = `${bucketOffset(buckets, i) + b.width}px`;
    line.style.height = `${tableHeight}px`;
    inner.appendChild(line);
  });

  if (todayIndex >= 0) {
    const todayLine = document.createElement("div");
    todayLine.className = "calendar-today-line";
    todayLine.style.left = `${bucketOffset(buckets, todayIndex)}px`;
    todayLine.style.height = `${tableHeight}px`;
    inner.appendChild(todayLine);
  }

  // le barre si posizionano misurando la riga <tr> corrispondente nel DOM (non calcolando
  // un'altezza-riga fissa moltiplicata per l'indice): eventuali arrotondamenti in pixel fra
  // una riga e l'altra altrimenti si accumulano e, dopo molte righe, la barra non è più
  // allineata con la riga della tabella
  leaves.forEach((node, i) => {
    const range = barRangeForNode(node, buckets);
    const tr = bodyRows[i];
    if (!range || !tr) return;
    const rowRect = tr.getBoundingClientRect();
    const top = rowRect.top - tableRect.top;
    const height = rowRect.height;

    const bar = document.createElement("div");
    bar.className = "calendar-bar";
    const meta = STATUS_META[node.status];
    bar.style.background = meta ? meta.color : "#999";
    bar.style.left = `${range.left + 1}px`;
    bar.style.width = `${Math.max(range.width - 2, 4)}px`;
    bar.style.top = `${top + height * 0.3}px`;
    bar.style.height = `${height * 0.4}px`;
    bar.title = node.title;

    if (DRAGGABLE_GRANULARITIES.has(granularity)) {
      const leftHandle = document.createElement("div");
      leftHandle.className = "calendar-bar-handle left";
      bar.appendChild(leftHandle);
      attachBarHandleDrag(leftHandle, "left", node, buckets, totalWidth, inner, bar);

      const rightHandle = document.createElement("div");
      rightHandle.className = "calendar-bar-handle right";
      bar.appendChild(rightHandle);
      attachBarHandleDrag(rightHandle, "right", node, buckets, totalWidth, inner, bar);

      const centerHandle = document.createElement("div");
      centerHandle.className = "calendar-bar-handle center";
      centerHandle.title = "Trascina per spostare l'intera barra";
      bar.appendChild(centerHandle);
      attachBarMoveDrag(centerHandle, node, buckets, totalWidth, inner, bar);
    }

    inner.appendChild(bar);
  });

  scroll.appendChild(inner);
  overlay.appendChild(scroll);

  // scrollbar "proxy" sempre visibile (sticky in fondo al viewport): la tabella può essere
  // molto più alta dello schermo, e la scrollbar nativa di .calendar-scroll finirebbe in
  // fondo a tutta la tabella, raggiungibile solo scrollando fino in basso
  const proxy = document.createElement("div");
  proxy.className = "calendar-scrollbar-proxy";
  const proxySpacer = document.createElement("div");
  proxySpacer.className = "calendar-scrollbar-spacer";
  proxySpacer.style.width = `${totalWidth}px`;
  proxy.appendChild(proxySpacer);

  let syncing = false;
  scroll.addEventListener("scroll", () => {
    if (syncing) return;
    syncing = true;
    proxy.scrollLeft = scroll.scrollLeft;
    syncing = false;
  });
  proxy.addEventListener("scroll", () => {
    if (syncing) return;
    syncing = true;
    scroll.scrollLeft = proxy.scrollLeft;
    syncing = false;
  });

  overlay.appendChild(proxy);
  mainPanel.appendChild(overlay);

  if (todayIndex >= 0) {
    scroll.scrollLeft = Math.max(bucketOffset(buckets, todayIndex) - 40, 0);
  }
}
