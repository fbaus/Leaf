import { state, rerender } from "./state.js";
import { STATUS_META } from "./utils.js";

const BUCKET_WIDTH = { giorno: 70, settimana: 100, mese: 120, anno: 140 };
const PADDING = { giorno: 7, settimana: 2, mese: 2, anno: 1 };
const TOOLBAR_HEIGHT = 30; // deve combaciare con l'altezza fissata in .calendar-toolbar (style.css)
const PROXY_HEIGHT = 14; // deve combaciare con .calendar-scrollbar-proxy (style.css)

const GRANULARITIES = [
  { key: "giorno", label: "Giorno" },
  { key: "settimana", label: "Settimana" },
  { key: "mese", label: "Mese" },
  { key: "anno", label: "Anno" },
];

// se un ridimensionamento viene interrotto in modo anomalo (rerender a metà trascinamento)
// questo permette di ripulire i listener del trascinamento precedente prima di iniziarne uno nuovo
let activeResizeCleanup = null;

const WEEKDAY_FMT = new Intl.DateTimeFormat("it-IT", { weekday: "long" });
const DAY_MONTH_FMT = new Intl.DateTimeFormat("it-IT", { day: "numeric", month: "long" });
const MONTH_SHORT_FMT = new Intl.DateTimeFormat("it-IT", { month: "short" });
const MONTH_YEAR_FMT = new Intl.DateTimeFormat("it-IT", { month: "long", year: "numeric" });

// ---------------------------------------------------------------------------
// Helper sulle date (sempre a mezzanotte locale, per evitare sfasamenti di fuso)
// ---------------------------------------------------------------------------

function parseISO(str) {
  const [y, m, d] = str.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

function addMonths(date, n) {
  const d = new Date(date);
  d.setMonth(d.getMonth() + n);
  return d;
}

function addYears(date, n) {
  const d = new Date(date);
  d.setFullYear(d.getFullYear() + n);
  return d;
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function startOfWeek(date) {
  const dow = date.getDay(); // 0 = domenica
  const diff = dow === 0 ? -6 : 1 - dow;
  return addDays(startOfDay(date), diff);
}

function startOfMonth(date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function startOfYear(date) {
  return new Date(date.getFullYear(), 0, 1);
}

function stepBucket(date, granularity) {
  if (granularity === "giorno") return addDays(date, 1);
  if (granularity === "settimana") return addDays(date, 7);
  if (granularity === "mese") return addMonths(date, 1);
  return addYears(date, 1);
}

function labelForBucket(date, granularity) {
  if (granularity === "giorno") return [WEEKDAY_FMT.format(date), DAY_MONTH_FMT.format(date)];
  if (granularity === "settimana") {
    const end = addDays(date, 6);
    return [`${date.getDate()} – ${end.getDate()} ${MONTH_SHORT_FMT.format(end)}`];
  }
  if (granularity === "mese") return [MONTH_YEAR_FMT.format(date)];
  return [String(date.getFullYear())];
}

// ---------------------------------------------------------------------------
// Costruzione dei bucket temporali (un bucket = una colonna del calendario)
// ---------------------------------------------------------------------------

function buildBuckets(leaves, granularity) {
  const today = startOfDay(new Date());
  const allDates = [today];
  leaves.forEach((n) => {
    if (n.execution_date) allDates.push(parseISO(n.execution_date));
    if (n.deadline) allDates.push(parseISO(n.deadline));
  });

  let minDate = new Date(Math.min(...allDates));
  let maxDate = new Date(Math.max(...allDates));
  const pad = PADDING[granularity];

  if (granularity === "giorno") {
    minDate = addDays(minDate, -pad);
    maxDate = addDays(maxDate, pad);
  } else if (granularity === "settimana") {
    minDate = addDays(startOfWeek(minDate), -pad * 7);
    maxDate = addDays(startOfWeek(maxDate), pad * 7);
  } else if (granularity === "mese") {
    minDate = addMonths(startOfMonth(minDate), -pad);
    maxDate = addMonths(startOfMonth(maxDate), pad);
  } else {
    minDate = addYears(startOfYear(minDate), -pad);
    maxDate = addYears(startOfYear(maxDate), pad);
  }

  const buckets = [];
  let cursor = minDate;
  while (cursor <= maxDate) {
    const next = stepBucket(cursor, granularity);
    const dow = cursor.getDay(); // 0 = domenica, 6 = sabato
    buckets.push({
      start: cursor,
      end: next,
      label: labelForBucket(cursor, granularity),
      isToday: today >= cursor && today < next,
      isWeekend: granularity === "giorno" && (dow === 0 || dow === 6),
      width: BUCKET_WIDTH[granularity],
    });
    cursor = next;
  }
  return buckets;
}

function findBucketIndex(buckets, date) {
  if (date < buckets[0].start) return 0;
  const last = buckets[buckets.length - 1];
  if (date >= last.end) return buckets.length - 1;
  for (let i = 0; i < buckets.length; i++) {
    if (date >= buckets[i].start && date < buckets[i].end) return i;
  }
  return buckets.length - 1;
}

function bucketOffset(buckets, index) {
  let left = 0;
  for (let i = 0; i < index; i++) left += buckets[i].width;
  return left;
}

function barRangeForNode(node, buckets) {
  if (!node.execution_date && !node.deadline) return null;
  const startDate = parseISO(node.execution_date || node.deadline);
  const endDate = parseISO(node.deadline || node.execution_date);
  const startIdx = findBucketIndex(buckets, startDate);
  const endIdx = findBucketIndex(buckets, endDate);
  const left = bucketOffset(buckets, startIdx);
  let width = 0;
  for (let i = startIdx; i <= endIdx; i++) width += buckets[i].width;
  return { left, width };
}

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
  const mainPanelLeft = mainPanel.getBoundingClientRect().left;
  // il bordo sinistro del calendario è trascinabile fra la fine della colonna Titolo
  // e l'inizio della colonna Data di esecuzione
  const minLeft = table.tHead.rows[0].children[1].getBoundingClientRect().right - mainPanelLeft;
  const maxLeft = table.tHead.rows[0].children[7].getBoundingClientRect().left - mainPanelLeft;
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
  overlay.style.height = `${tableHeight + TOOLBAR_HEIGHT + PROXY_HEIGHT}px`;

  const resizeHandle = document.createElement("div");
  resizeHandle.className = "calendar-resize-handle";
  resizeHandle.addEventListener("mousedown", (e) => {
    e.preventDefault();
    if (activeResizeCleanup) activeResizeCleanup();
    const onMouseMove = (moveEvent) => {
      const newLeft = Math.min(Math.max(moveEvent.clientX - mainPanelLeft, minLeft), maxLeft);
      overlay.style.left = `${newLeft}px`;
      state.calendarLeftOffset = newLeft;
    };
    const onMouseUp = () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      activeResizeCleanup = null;
    };
    activeResizeCleanup = onMouseUp;
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
    bar.style.top = `${top + height * 0.2}px`;
    bar.style.height = `${height * 0.6}px`;
    bar.title = node.title;
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
