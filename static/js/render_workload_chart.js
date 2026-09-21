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

export const CHART_H = 200; // altezza logica dell'SVG (viewBox): scalata via CSS all'altezza reale del contenitore
const HEADER_H = 26; // px, riga di intestazione dei bucket sopra l'SVG

function bucketDayCount(bucket) {
  return Math.round((bucket.end - bucket.start) / MS_PER_DAY);
}

// giorni LAVORATIVI di sovrapposizione fra la finestra [ex, dl] (inclusi entrambi gli
// estremi) del task e il bucket [start, end) dell'asse — i weekend contano 0, coerente con
// count_business_days in app.py: il valore costante della foglia (leaf.value) è già
// calcolato assumendo che nei weekend non ci sia capacità disponibile, quindi il grafico
// deve mostrare lo stesso 0% in quei giorni, non restare "piatto" anche sabato e domenica
function overlapBusinessDays(bucket, ex, dl) {
  const start = bucket.start > ex ? bucket.start : ex;
  const dlExclusive = addDays(dl, 1);
  const end = bucket.end < dlExclusive ? bucket.end : dlExclusive;
  let count = 0;
  for (let d = start; d < end; d = addDays(d, 1)) {
    const dow = d.getDay(); // 0 = domenica, 6 = sabato
    if (dow !== 0 && dow !== 6) count++;
  }
  return count;
}

// valore medio (%) del carico di una foglia nel bucket: essendo una percentuale, quando il
// bucket raggruppa più giorni (Mese/Anno/Globale) va mediato, non sommato — la frazione di
// giorni LAVORATIVI del bucket coperti dalla finestra EX-DL della foglia, moltiplicata per
// il suo valore costante (già calcolato dal backend, vedi collect_active_leaves in app.py).
// Il denominatore resta il totale dei giorni DI CALENDARIO del bucket (non solo lavorativi):
// così, su un bucket di più giorni, il weekend pesa correttamente come "0%" nella media
// invece di essere escluso dal conteggio (che alzerebbe artificialmente la media)
function bucketValueForLeaf(leaf, bucket) {
  const overlap = overlapBusinessDays(bucket, parseISO(leaf.execution_date), parseISO(leaf.deadline));
  if (overlap <= 0) return 0;
  return (overlap / bucketDayCount(bucket)) * leaf.value;
}

// serie di valori (uno per bucket) del carico di un insieme di foglie — riusata sia per il
// grafico globale/overlay della vista Carico di lavoro sia per il grafico "carico
// complessivo" in cima alla Vista Gantt (vedi render_gantt.js)
export function buildLeafSeries(leaves, buckets) {
  return buckets.map((bucket) => leaves.reduce((sum, leaf) => sum + bucketValueForLeaf(leaf, bucket), 0));
}

// scala verticale comune a più serie: almeno 100%, arrotondata al 25% superiore più
// vicino — un passo piccolo (25, non 100) tiene la scala "morbida": quando un valore
// supera di poco la scala attuale, questa cresce del minimo necessario, invece di
// raddoppiare di colpo (es. 100 -> 200) facendo sembrare che la barra sia scesa anche se
// il valore reale è aumentato (le etichette restano comunque sempre multiple di 25, vedi
// axisStep sotto — non sono più i quarti fissi di maxY, che non lo garantirebbero)
export function computeMaxY(seriesList) {
  const allValues = seriesList.flatMap((s) => s.values);
  return Math.ceil(Math.max(100, ...allValues) / 25) * 25;
}

// passo delle etichette/griglia: sempre un multiplo di 25, scelto per restare intorno a
// 4-5 etichette anche quando la scala (maxY) cresce
function axisStep(maxY) {
  return Math.max(25, Math.round(maxY / 4 / 25) * 25);
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

// linee orizzontali grigio chiaro alle principali divisioni dell'asse y (stessi valori
// delle etichette in buildAxisLabels, vedi axisStep), per leggere più facilmente i valori
function buildGridlines(svg, maxY, yOf, totalWidth) {
  const step = axisStep(maxY);
  for (let v = 0; v <= maxY; v += step) {
    const y = yOf(v);
    const line = document.createElementNS(svg.namespaceURI, "line");
    line.setAttribute("x1", 0);
    line.setAttribute("x2", totalWidth);
    line.setAttribute("y1", y);
    line.setAttribute("y2", y);
    line.setAttribute("class", "workload-chart-gridline");
    svg.appendChild(line);
  }
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

// le sole etichette percentuali (senza lo spacer per l'intestazione dei bucket sopra):
// riusate anche dal grafico "carico complessivo" del Gantt (render_gantt.js), che non ha
// una fascia di intestazione propria da compensare
export function buildAxisLabels(maxY) {
  const labels = document.createElement("div");
  labels.className = "workload-chart-axis-labels";
  const step = axisStep(maxY);
  for (let v = 0; v <= maxY; v += step) {
    const label = document.createElement("div");
    label.className = "workload-chart-axis-label";
    label.style.top = `${(1 - v / maxY) * 100}%`;
    label.textContent = `${v}%`;
    labels.appendChild(label);
  }
  return labels;
}

function buildAxis(maxY) {
  const axis = document.createElement("div");
  axis.className = "workload-chart-axis";

  const spacer = document.createElement("div");
  spacer.className = "workload-chart-axis-spacer";
  spacer.style.height = `${HEADER_H}px`;
  axis.appendChild(spacer);
  axis.appendChild(buildAxisLabels(maxY));

  return axis;
}

// costruisce l'SVG del grafico (griglia + linea "oggi" + una polilinea a gradini per ogni
// serie in `seriesList`, ciascuna `{values, className?, color?}`) — riusato sia dal
// grafico della vista Carico di lavoro (sotto, con eventuali serie sovrapposte colorate)
// sia dal grafico "carico complessivo" del Gantt (una sola serie, buckets già calcolati lì
// per restare allineato alla sua timeline, vedi render_gantt.js)
export function buildChartSvg(buckets, totalWidth, seriesList, maxY) {
  const yOf = (value) => CHART_H - (Math.min(value, maxY) / maxY) * CHART_H;

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

  seriesList.forEach(({ values, className, color }) => {
    const path = document.createElementNS(svg.namespaceURI, "path");
    path.setAttribute("d", stepPath(buckets, values, yOf));
    if (className) path.setAttribute("class", className);
    if (color) path.setAttribute("stroke", color);
    svg.appendChild(path);
  });

  return svg;
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

  const globalSeries = buildLeafSeries(allLeaves, buckets);
  const overlaySeries = checkedEntries.map((entry) => buildLeafSeries(entry.leaves || [], buckets));
  const maxY = computeMaxY([{ values: globalSeries }, ...overlaySeries.map((values) => ({ values }))]);

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

  const seriesList = [
    { values: globalSeries, className: "workload-chart-global-line" },
    ...checkedEntries.map((entry, i) => ({
      values: overlaySeries[i],
      className: "workload-chart-overlay-line",
      color: colorForIndex(i),
    })),
  ];
  inner.appendChild(buildChartSvg(buckets, totalWidth, seriesList, maxY));

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
