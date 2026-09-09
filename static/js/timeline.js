// Infrastruttura condivisa fra la vista calendario (overlay su FOGLIE) e la vista Gantt:
// costruzione dei bucket temporali, conversione data <-> posizione X, e il trascinamento
// delle barre (singole estremità o l'intera barra in blocco). Estratta da render_calendar.js
// perché la vista Gantt riusa esattamente la stessa logica di trascinamento.

import { reload } from "./state.js";
import { updateTask } from "./api.js";

export const BUCKET_WIDTH = { giorno: 70, settimana: 100, mese: 120, anno: 140 };
export const PADDING = { giorno: 7, settimana: 2, mese: 2, anno: 1 };

// le `key` restano quelle originarie (usate ovunque nella logica di calcolo dei bucket:
// buildBuckets, DRAGGABLE_GRANULARITIES, BUCKET_WIDTH, PADDING...); solo le etichette
// mostrate all'utente sono scalate di un gradino, per lasciare libero il nome "Giorno"
// a una futura vista oraria dedicata (non ancora implementata)
export const GRANULARITIES = [
  { key: "giorno", label: "Settimana" },
  { key: "settimana", label: "Mese" },
  { key: "mese", label: "Anno" },
  { key: "anno", label: "Globale" },
];

export const MS_PER_DAY = 24 * 60 * 60 * 1000;

// granularità in cui le estremità delle barre sono trascinabili (in Anno è troppo grossolano)
export const DRAGGABLE_GRANULARITIES = new Set(["giorno", "settimana", "mese"]);

const WEEKDAY_FMT = new Intl.DateTimeFormat("it-IT", { weekday: "long" });
const DAY_MONTH_FMT = new Intl.DateTimeFormat("it-IT", { day: "numeric", month: "long" });
const MONTH_SHORT_FMT = new Intl.DateTimeFormat("it-IT", { month: "short" });
const MONTH_YEAR_FMT = new Intl.DateTimeFormat("it-IT", { month: "long", year: "numeric" });
const WEEKDAY_SHORT = ["Dom", "Lun", "Mar", "Mer", "Gio", "Ven", "Sab"]; // indicizzato da Date.getDay()

// ---------------------------------------------------------------------------
// Trascinamento esclusivo: solo un trascinamento alla volta in tutta l'app (barre di
// calendario/Gantt, o il resize-handle del calendario), a prescindere da quale modulo
// lo avvia. Se un rerender interrompe un trascinamento a metà, il prossimo mousedown
// ripulisce comunque i listener di quello precedente.
// ---------------------------------------------------------------------------

let activeCleanup = null;

export function cancelActiveDrag() {
  if (activeCleanup) activeCleanup();
}

export function beginExclusiveDrag(cleanupFn) {
  cancelActiveDrag();
  activeCleanup = cleanupFn;
}

export function endExclusiveDrag() {
  activeCleanup = null;
}

// ---------------------------------------------------------------------------
// Helper sulle date (sempre a mezzanotte locale, per evitare sfasamenti di fuso)
// ---------------------------------------------------------------------------

export function parseISO(str) {
  const [y, m, d] = str.split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function toISO(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function addDays(date, n) {
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
// Costruzione dei bucket temporali (un bucket = una colonna dell'asse)
// ---------------------------------------------------------------------------

// `nodes`: qualunque lista di oggetti con execution_date/deadline (foglie o rami, il
// rollup automatico garantisce che anche i rami abbiano date coerenti)
export function buildBuckets(nodes, granularity) {
  const today = startOfDay(new Date());
  const allDates = [today];
  nodes.forEach((n) => {
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

// ---------------------------------------------------------------------------
// Intestazione "superiore": raggruppa i bucket già costruiti in fasce più larghe
// (settimane sopra ai giorni, mesi sopra alle settimane, anni sopra ai mesi) — condivisa
// fra calendario FOGLIE e Gantt, che disegnano ciascuno la propria riga ma con gli stessi
// gruppi/etichette.
// ---------------------------------------------------------------------------

// numero di settimana ISO 8601 (lunedì-domenica, la settimana 1 è quella che contiene il
// primo giovedì dell'anno): l'anno ISO può differire da getFullYear() nei giorni di
// passaggio fra dicembre e gennaio, per questo viene ricalcolato dal giovedì della settimana
function isoWeekInfo(date) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const dayNum = (d.getDay() + 6) % 7; // lunedì=0 ... domenica=6
  d.setDate(d.getDate() - dayNum + 3); // giovedì della stessa settimana ISO
  const isoYear = d.getFullYear();
  const jan4 = new Date(isoYear, 0, 4);
  const jan4DayNum = (jan4.getDay() + 6) % 7;
  const week1Monday = new Date(jan4.getFullYear(), jan4.getMonth(), jan4.getDate() - jan4DayNum);
  const week = Math.round((d - week1Monday) / (7 * MS_PER_DAY)) + 1;
  return { week, year: isoYear };
}

// il mese "dominante" di una settimana (lunedì `weekStart`): quello a cui appartiene la
// maggioranza dei suoi 7 giorni. Con 7 giorni (dispari) spalmati su al massimo 2 mesi la
// maggioranza esiste sempre, nessun pareggio possibile
function dominantMonth(weekStart) {
  const counts = new Map();
  let bestKey = null;
  let bestCount = -1;
  for (let i = 0; i < 7; i++) {
    const d = addDays(weekStart, i);
    const key = `${d.getFullYear()}-${d.getMonth()}`;
    const count = (counts.get(key) || 0) + 1;
    counts.set(key, count);
    if (count > bestCount) {
      bestCount = count;
      bestKey = key;
    }
  }
  const [year, month] = bestKey.split("-").map(Number);
  return { year, month };
}

// costruisce i gruppi (etichetta + larghezza totale) per la riga di intestazione
// superiore; [] se per questa granularità non è previsto un raggruppamento (oggi: "anno")
export function buildSuperHeaderGroups(buckets, granularity) {
  let keyOf, labelOf;
  if (granularity === "giorno") {
    keyOf = (b) => {
      const { week, year } = isoWeekInfo(b.start);
      return `${year}-W${week}`;
    };
    labelOf = (b) => {
      const { week, year } = isoWeekInfo(b.start);
      return `Week ${week} - ${year}`;
    };
  } else if (granularity === "settimana") {
    keyOf = (b) => {
      const { year, month } = dominantMonth(b.start);
      return `${year}-${month}`;
    };
    labelOf = (b) => {
      const { year, month } = dominantMonth(b.start);
      return MONTH_YEAR_FMT.format(new Date(year, month, 1));
    };
  } else if (granularity === "mese") {
    keyOf = (b) => b.start.getFullYear();
    labelOf = (b) => String(b.start.getFullYear());
  } else {
    return [];
  }

  const groups = [];
  let i = 0;
  while (i < buckets.length) {
    const key = keyOf(buckets[i]);
    let width = 0;
    let j = i;
    while (j < buckets.length && keyOf(buckets[j]) === key) {
      width += buckets[j].width;
      j++;
    }
    groups.push({ label: labelOf(buckets[i]), width });
    i = j;
  }
  return groups;
}

export function findBucketIndex(buckets, date) {
  if (date < buckets[0].start) return 0;
  const last = buckets[buckets.length - 1];
  if (date >= last.end) return buckets.length - 1;
  for (let i = 0; i < buckets.length; i++) {
    if (date >= buckets[i].start && date < buckets[i].end) return i;
  }
  return buckets.length - 1;
}

export function bucketOffset(buckets, index) {
  let left = 0;
  for (let i = 0; i < index; i++) left += buckets[i].width;
  return left;
}

// posizione X (px, dentro il contenitore interno) del giorno `date`, sempre a precisione
// di giorno anche dentro un bucket più largo (settimana/mese): la larghezza del bucket
// viene divisa per il numero di giorni che contiene davvero (28-31 per un mese)
function dayWidthOf(bucket) {
  const daysInBucket = Math.round((bucket.end - bucket.start) / MS_PER_DAY);
  return bucket.width / daysInBucket;
}

export function dateToX(buckets, date) {
  const idx = findBucketIndex(buckets, date);
  const bucket = buckets[idx];
  const dayOffset = Math.round((date - bucket.start) / MS_PER_DAY);
  return bucketOffset(buckets, idx) + dayOffset * dayWidthOf(bucket);
}

// inverso di dateToX: dalla posizione X al giorno preciso (usato durante il trascinamento)
export function xToDate(buckets, x) {
  let idx = 0;
  let acc = 0;
  while (idx < buckets.length - 1 && x >= acc + buckets[idx].width) {
    acc += buckets[idx].width;
    idx++;
  }
  const bucket = buckets[idx];
  const daysInBucket = Math.round((bucket.end - bucket.start) / MS_PER_DAY);
  const dayOffset = Math.min(Math.max(Math.round((x - acc) / dayWidthOf(bucket)), 0), daysInBucket - 1);
  return addDays(bucket.start, dayOffset);
}

export function barRangeForNode(node, buckets) {
  if (!node.execution_date && !node.deadline) return null;
  const startDate = parseISO(node.execution_date || node.deadline);
  const endDate = parseISO(node.deadline || node.execution_date);
  const left = dateToX(buckets, startDate);
  const right = dateToX(buckets, addDays(endDate, 1)); // include per intero il giorno di deadline
  return { left, width: right - left };
}

// ---------------------------------------------------------------------------
// Trascinamento delle barre (Data di esecuzione / Deadline, singolarmente o in blocco)
// ---------------------------------------------------------------------------

export function createDragTooltip() {
  const tooltip = document.createElement("div");
  tooltip.className = "calendar-drag-tooltip";
  document.body.appendChild(tooltip);
  return tooltip;
}

function formatDragDate(date) {
  const dd = String(date.getDate()).padStart(2, "0");
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}/${date.getFullYear()} ${WEEKDAY_SHORT[date.getDay()]}`;
}

export function updateDragTooltip(tooltip, date, clientX, clientY) {
  tooltip.textContent = formatDragDate(date);
  tooltip.style.left = `${clientX + 14}px`;
  tooltip.style.top = `${clientY - 28}px`;
}

function updateDragTooltipRange(tooltip, execDate, deadlineDate, clientX, clientY) {
  tooltip.textContent = `${formatDragDate(execDate)}  →  ${formatDragDate(deadlineDate)}`;
  tooltip.style.left = `${clientX + 14}px`;
  tooltip.style.top = `${clientY - 28}px`;
}

// `edge` è "left" (Data di esecuzione) o "right" (Deadline); il clamp reciproco impedisce
// di trascinare un'estremità oltre l'altra, così non si arriva mai a uno stato che il
// backend rifiuterebbe (deadline sempre successiva alla data di esecuzione).
// `opts.onDrag` (opzionale) viene richiamato a ogni movimento del mouse, dopo che la barra
// è stata riposizionata (usato dal Gantt per ridisegnare le frecce di dipendenza in tempo
// reale). `opts.afterCommit` (opzionale) sostituisce il default `reload` dopo un salvataggio
// riuscito (usato dal Gantt per ridisegnarsi con i dati aggiornati).
export function attachBarHandleDrag(handle, edge, node, buckets, totalWidth, inner, bar, opts = {}) {
  const { onDrag, afterCommit } = opts;
  handle.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();

    const innerLeft = inner.getBoundingClientRect().left;
    const execDate = parseISO(node.execution_date);
    const deadlineDate = parseISO(node.deadline);
    const originalDate = edge === "left" ? execDate : deadlineDate;
    let currentDate = originalDate;

    const tooltip = createDragTooltip();

    const onMouseMove = (moveEvent) => {
      const x = Math.min(Math.max(moveEvent.clientX - innerLeft, 0), totalWidth - 1);
      let newDate = xToDate(buckets, x);
      if (edge === "left") {
        // la data di esecuzione può arrivare fino a coincidere con la deadline (mai oltre)
        if (newDate > deadlineDate) newDate = deadlineDate;
      } else {
        // la deadline può arrivare fino a coincidere con la data di esecuzione (mai prima)
        if (newDate < execDate) newDate = execDate;
      }
      currentDate = newDate;

      const startDate = edge === "left" ? newDate : execDate;
      const endDate = edge === "left" ? deadlineDate : newDate;
      const left = dateToX(buckets, startDate);
      const right = dateToX(buckets, addDays(endDate, 1));
      bar.style.left = `${left + 1}px`;
      bar.style.width = `${Math.max(right - left - 2, 4)}px`;

      updateDragTooltip(tooltip, newDate, moveEvent.clientX, moveEvent.clientY);
      if (onDrag) onDrag();
    };

    const onMouseUp = () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      endExclusiveDrag();
      tooltip.remove();

      if (currentDate.getTime() !== originalDate.getTime()) {
        const payload = edge === "left" ? { execution_date: toISO(currentDate) } : { deadline: toISO(currentDate) };
        updateTask(node.id, payload)
          .then(() => (afterCommit ? afterCommit() : reload()))
          .catch((err) => alert(err.message));
      }
    };

    beginExclusiveDrag(onMouseUp);
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  });
}

// aggancio centrale: sposta l'intera barra in blocco, mantenendo invariata la durata
// (data di esecuzione e deadline traslano dello stesso numero di giorni)
export function attachBarMoveDrag(handle, node, buckets, totalWidth, inner, bar, opts = {}) {
  const { onDrag, afterCommit } = opts;
  handle.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();

    const innerLeft = inner.getBoundingClientRect().left;
    const execDate = parseISO(node.execution_date);
    const deadlineDate = parseISO(node.deadline);

    const startX = Math.min(Math.max(e.clientX - innerLeft, 0), totalWidth - 1);
    const startDragDate = xToDate(buckets, startX);

    let currentExecDate = execDate;
    let currentDeadlineDate = deadlineDate;

    const tooltip = createDragTooltip();

    const onMouseMove = (moveEvent) => {
      const x = Math.min(Math.max(moveEvent.clientX - innerLeft, 0), totalWidth - 1);
      const dragDate = xToDate(buckets, x);
      const deltaDays = Math.round((dragDate - startDragDate) / MS_PER_DAY);

      currentExecDate = addDays(execDate, deltaDays);
      currentDeadlineDate = addDays(deadlineDate, deltaDays);

      const left = dateToX(buckets, currentExecDate);
      const right = dateToX(buckets, addDays(currentDeadlineDate, 1));
      bar.style.left = `${left + 1}px`;
      bar.style.width = `${Math.max(right - left - 2, 4)}px`;

      updateDragTooltipRange(tooltip, currentExecDate, currentDeadlineDate, moveEvent.clientX, moveEvent.clientY);
      if (onDrag) onDrag();
    };

    const onMouseUp = () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      endExclusiveDrag();
      tooltip.remove();

      if (currentExecDate.getTime() !== execDate.getTime()) {
        updateTask(node.id, {
          execution_date: toISO(currentExecDate),
          deadline: toISO(currentDeadlineDate),
        })
          .then(() => (afterCommit ? afterCommit() : reload()))
          .catch((err) => alert(err.message));
      }
    };

    beginExclusiveDrag(onMouseUp);
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  });
}
