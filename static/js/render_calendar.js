import { state, rerender } from "./state.js";
import { STATUS_META } from "./utils.js";
import {
  DRAGGABLE_GRANULARITIES,
  GRANULARITIES,
  buildBuckets,
  buildSuperHeaderGroups,
  bucketOffset,
  todayLineOffset,
  barRangeForNode,
  attachBarHandleDrag,
  attachBarMoveDrag,
  cancelActiveDrag,
  beginExclusiveDrag,
  endExclusiveDrag,
} from "./timeline.js";

const TOOLBAR_HEIGHT = 30; // deve combaciare con l'altezza fissata in .calendar-toolbar (style.css)
const PROXY_HEIGHT = 14; // deve combaciare con .calendar-scrollbar-proxy (style.css)
const SUPER_HEADER_HEIGHT = 20; // fascia settimane/mesi/anni sopra l'intestazione normale, 0 se nascosta (vista "Globale")

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

  // fascia superiore (settimane/mesi/anni raggruppati): per "anno" (vista "Globale") non
  // c'è raggruppamento, ma la fascia resta comunque presente (vuota, grigia) invece di
  // sparire — così l'altezza del calendario non cambia cambiando granularità. Aggiunge
  // righe SOPRA a quella che finora era la cima di .calendar-inner (allineata alla cima
  // della <table> reale, vedi overlay.style.top più sotto), quindi ogni elemento
  // posizionato con top:0 relativo a .calendar-inner (bande weekend, linee griglia, linea
  // "oggi", barre) deve scendere di superHeaderHeight per restare allineato com'era prima
  // di questa fascia
  const superGroups = buildSuperHeaderGroups(buckets, granularity);
  const superHeaderHeight = SUPER_HEADER_HEIGHT;

  const tableRect = table.getBoundingClientRect();
  const theadHeight = table.tHead.getBoundingClientRect().height;
  const mainPanelRect = mainPanel.getBoundingClientRect();
  const mainPanelLeft = mainPanelRect.left;
  // il bordo sinistro del calendario è trascinabile fra la fine della colonna Titolo e la
  // fine della colonna Descrizione: Data di esecuzione e Deadline restano sempre coperte
  // dal calendario, mai scopribili trascinando verso destra
  const minLeft = table.tHead.rows[0].children[1].getBoundingClientRect().right - mainPanelLeft;
  const maxLeft = table.tHead.rows[0].children[4].getBoundingClientRect().right - mainPanelLeft;
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
  overlay.style.top = `${tableRect.top - mainPanelRect.top - TOOLBAR_HEIGHT - superHeaderHeight}px`;
  overlay.style.height = `${tableHeight + TOOLBAR_HEIGHT + PROXY_HEIGHT + superHeaderHeight}px`;

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

  // sorting secondario a scelta manuale (in aggiunta al criterio di ordinamento primario
  // della tabella FOGLIE), per data di esecuzione o per deadline, su tutti gli status
  const dateSortGroup = document.createElement("div");
  dateSortGroup.className = "calendar-date-sort-group";
  [
    { key: "execution_date", label: "EX" },
    { key: "deadline", label: "DL" },
  ].forEach(({ key, label }) => {
    const btn = document.createElement("button");
    btn.className = "filter-group-btn";
    btn.classList.toggle("active", state.leafFilters.dateSecondarySort === key);
    btn.textContent = label;
    btn.title = `Ordina in aggiunta per ${label === "EX" ? "data di esecuzione" : "deadline"}`;
    btn.onclick = () => {
      state.leafFilters.dateSecondarySort = state.leafFilters.dateSecondarySort === key ? null : key;
      rerender();
    };
    dateSortGroup.appendChild(btn);
  });
  toolbar.appendChild(dateSortGroup);

  overlay.appendChild(toolbar);

  const scroll = document.createElement("div");
  scroll.className = "calendar-scroll";

  const inner = document.createElement("div");
  inner.className = "calendar-inner";
  inner.style.width = `${totalWidth}px`;

  const superHeaderRow = document.createElement("div");
  superHeaderRow.className = "calendar-header-row";
  superHeaderRow.style.height = `${superHeaderHeight}px`;
  if (superGroups.length > 0) {
    superGroups.forEach((g) => {
      const cell = document.createElement("div");
      cell.className = "super-header-cell";
      cell.style.width = `${g.width}px`;
      cell.textContent = g.label;
      superHeaderRow.appendChild(cell);
    });
  } else {
    // "anno" (vista "Globale"): nessun raggruppamento sopra gli anni stessi, ma la fascia
    // resta come banda grigia vuota invece di sparire, a parità di altezza con le altre viste
    const filler = document.createElement("div");
    filler.className = "super-header-cell";
    filler.style.width = `${totalWidth}px`;
    superHeaderRow.appendChild(filler);
  }
  inner.appendChild(superHeaderRow);

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
    band.style.top = `${superHeaderHeight}px`;
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
    line.style.top = `${superHeaderHeight}px`;
    line.style.height = `${tableHeight}px`;
    inner.appendChild(line);
  });

  // linee orizzontali di separazione fra le righe, stesso bordo della tabella FOGLIE
  // (th, td { border-bottom: 1px solid #eee }): aiutano a capire a quale riga/task
  // corrisponde ogni barra, specialmente scorrendo in orizzontale dove l'intestazione
  // Titolo non è più visibile. Una per ogni riga reale (non solo quelle con una barra),
  // stessa misurazione dal DOM usata sotto per le barre
  bodyRows.forEach((tr) => {
    const rowRect = tr.getBoundingClientRect();
    const rowLine = document.createElement("div");
    rowLine.className = "calendar-row-line";
    rowLine.style.top = `${rowRect.bottom - tableRect.top + superHeaderHeight}px`;
    rowLine.style.width = `${totalWidth}px`;
    inner.appendChild(rowLine);
  });

  const todayOffset = todayLineOffset(buckets);
  if (todayOffset !== null) {
    const todayLine = document.createElement("div");
    todayLine.className = "calendar-today-line";
    todayLine.style.left = `${todayOffset}px`;
    todayLine.style.top = `${superHeaderHeight}px`;
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
    bar.style.top = `${top + height * 0.3 + superHeaderHeight}px`;
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
