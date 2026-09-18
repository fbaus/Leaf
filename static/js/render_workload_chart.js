// Vista "Carico di lavoro": grafico storico del carico di un utente nel tempo. Il carico di
// un progetto è la somma ricorsiva del carico delle sue FOGLIE attive (stessa regola di
// compute_carico_lavoro_rollup in app.py, mai il totale stimato spalmato sull'intera durata
// del progetto): ogni foglia (`entry.leaves`, già filtrate ed espanse dal backend) contribuisce
// un segmento *piatto*, di altezza costante `value`, solo nei giorni della propria finestra
// EX-DL — zero fuori da essa, anche se un'altra foglia dello stesso progetto ha una finestra
// diversa. Il grafico globale dell'utente somma le foglie di TUTTI i suoi task; le spunte
// "grafico" nella tabella sotto (vedi render_workload.js) sovrappongono le sole foglie del
// singolo task selezionato, con un colore.
import { buildBuckets, bucketOffset, todayLineOffset, addDays, parseISO, MS_PER_DAY } from "./timeline.js";

export const CHART_COLORS = [
  "#1565c0", "#c62828", "#2e7d32", "#f57f17",
  "#6a1b9a", "#00838f", "#ad1457", "#4e342e",
];

export function colorForIndex(index) {
  return CHART_COLORS[index % CHART_COLORS.length];
}

const CHART_H = 200; // altezza logica dell'SVG (viewBox): scalata via CSS all'altezza reale del contenitore
const HEADER_H = 26; // px, riga di intestazione dei bucket sopra l'SVG

function bucketDayCount(bucket) {
  return Math.round((bucket.end - bucket.start) / MS_PER_DAY);
}

// giorni di sovrapposizione fra la finestra [ex, dl] (inclusi entrambi gli estremi) del
// task e il bucket [start, end) dell'asse
function overlapDays(bucket, ex, dl) {
  const start = bucket.start > ex ? bucket.start : ex;
  const dlExclusive = addDays(dl, 1);
  const end = bucket.end < dlExclusive ? bucket.end : dlExclusive;
  return Math.max(Math.round((end - start) / MS_PER_DAY), 0);
}

// valore medio (%) del carico di una foglia nel bucket: essendo una percentuale, quando il
// bucket raggruppa più giorni (Mese/Anno/Globale) va mediato, non sommato — la frazione di
// giorni del bucket coperti dalla finestra EX-DL della foglia, moltiplicata per il suo
// valore costante (già calcolato dal backend, vedi collect_active_leaves in app.py)
function bucketValueForLeaf(leaf, bucket) {
  const overlap = overlapDays(bucket, parseISO(leaf.execution_date), parseISO(leaf.deadline));
  if (overlap <= 0) return 0;
  return (overlap / bucketDayCount(bucket)) * leaf.value;
}

function buildSeries(leaves, buckets) {
  return buckets.map((bucket) => leaves.reduce((sum, leaf) => sum + bucketValueForLeaf(leaf, bucket), 0));
}

// disegna un "gradino" (non una linea che interpola fra i centri dei bucket): il valore è
// costante per tutta la larghezza del bucket, con un salto verticale al bucket successivo
function stepPath(buckets, values, yOf) {
  let d = "";
  let x = 0;
  buckets.forEach((bucket, i) => {
    const y = yOf(values[i]);
    d += i === 0 ? `M ${x} ${y}` : ` L ${x} ${y}`;
    x += bucket.width;
    d += ` L ${x} ${y}`;
  });
  return d;
}

// linee orizzontali grigio chiaro alle principali divisioni dell'asse y (stesse frazioni
// delle etichette in buildAxis), per leggere più facilmente i valori del grafico
function buildGridlines(svg, maxY, yOf, totalWidth) {
  [0, 0.25, 0.5, 0.75, 1].forEach((frac) => {
    const y = yOf(frac * maxY);
    const line = document.createElementNS(svg.namespaceURI, "line");
    line.setAttribute("x1", 0);
    line.setAttribute("x2", totalWidth);
    line.setAttribute("y1", y);
    line.setAttribute("y2", y);
    line.setAttribute("class", "workload-chart-gridline");
    svg.appendChild(line);
  });
}

function buildHeader(buckets) {
  const header = document.createElement("div");
  header.className = "workload-chart-header";
  header.style.height = `${HEADER_H}px`;
  buckets.forEach((b) => {
    const cell = document.createElement("div");
    cell.className = "workload-chart-bucket-header";
    cell.style.width = `${b.width}px`;
    b.label.forEach((line) => {
      const lineEl = document.createElement("div");
      lineEl.textContent = line;
      cell.appendChild(lineEl);
    });
    header.appendChild(cell);
  });
  return header;
}

function buildAxis(maxY) {
  const axis = document.createElement("div");
  axis.className = "workload-chart-axis";

  const spacer = document.createElement("div");
  spacer.className = "workload-chart-axis-spacer";
  spacer.style.height = `${HEADER_H}px`;
  axis.appendChild(spacer);

  const labels = document.createElement("div");
  labels.className = "workload-chart-axis-labels";
  [1, 0.75, 0.5, 0.25, 0].forEach((frac) => {
    const label = document.createElement("div");
    label.className = "workload-chart-axis-label";
    label.style.top = `${(1 - frac) * 100}%`;
    label.textContent = `${Math.round(maxY * frac)}%`;
    labels.appendChild(label);
  });
  axis.appendChild(labels);

  return axis;
}

// `entries`: tutti i task (delegati + progetti propri) dell'utente, per il segmento
// globale (somma delle foglie attive di tutti, `entry.leaves`). `checkedEntries`:
// sottoinsieme con la spunta "grafico" attiva in render_workload.js, ciascuno sovrapposto
// (solo le proprie foglie) con il colore di `colorForIndex` alla propria posizione
// nell'array (stesso ordine/colore usato per colorare il titolo in tabella).
export function renderWorkloadChart(entries, checkedEntries, granularity) {
  const allLeaves = entries.flatMap((e) => e.leaves || []);
  const buckets = buildBuckets(allLeaves, granularity);
  const totalWidth = buckets.reduce((sum, b) => sum + b.width, 0);

  const globalSeries = buildSeries(allLeaves, buckets);
  const overlaySeries = checkedEntries.map((entry) => buildSeries(entry.leaves || [], buckets));

  const rawMax = Math.max(100, ...globalSeries, ...overlaySeries.flat());
  const maxY = Math.ceil(rawMax / 25) * 25;
  const yOf = (value) => CHART_H - (Math.min(value, maxY) / maxY) * CHART_H;

  const wrapper = document.createElement("div");
  wrapper.className = "workload-chart-wrapper";

  const body = document.createElement("div");
  body.className = "workload-chart-body";
  body.appendChild(buildAxis(maxY));

  const scroll = document.createElement("div");
  scroll.className = "workload-chart-scroll";

  const inner = document.createElement("div");
  inner.className = "workload-chart-inner";
  inner.style.width = `${totalWidth}px`;
  inner.appendChild(buildHeader(buckets));

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${Math.max(totalWidth, 1)} ${CHART_H}`);
  svg.setAttribute("preserveAspectRatio", "none");
  svg.classList.add("workload-chart-svg");

  buildGridlines(svg, maxY, yOf, totalWidth);

  const todayOffset = todayLineOffset(buckets);
  if (todayOffset !== null) {
    const todayLine = document.createElementNS(svg.namespaceURI, "line");
    todayLine.setAttribute("x1", todayOffset);
    todayLine.setAttribute("x2", todayOffset);
    todayLine.setAttribute("y1", 0);
    todayLine.setAttribute("y2", CHART_H);
    todayLine.setAttribute("class", "workload-chart-today-line");
    svg.appendChild(todayLine);
  }

  const globalPath = document.createElementNS(svg.namespaceURI, "path");
  globalPath.setAttribute("d", stepPath(buckets, globalSeries, yOf));
  globalPath.setAttribute("class", "workload-chart-global-line");
  svg.appendChild(globalPath);

  checkedEntries.forEach((entry, i) => {
    const path = document.createElementNS(svg.namespaceURI, "path");
    path.setAttribute("d", stepPath(buckets, overlaySeries[i], yOf));
    path.setAttribute("class", "workload-chart-overlay-line");
    path.setAttribute("stroke", colorForIndex(i));
    svg.appendChild(path);
  });

  inner.appendChild(svg);
  scroll.appendChild(inner);
  body.appendChild(scroll);
  wrapper.appendChild(body);

  const todayIndex = buckets.findIndex((b) => b.isToday);
  const initialScrollLeft = todayIndex >= 0 ? Math.max(bucketOffset(buckets, todayIndex) - 60, 0) : 0;
  requestAnimationFrame(() => {
    scroll.scrollLeft = initialScrollLeft;
  });

  return wrapper;
}
