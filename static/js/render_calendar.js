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
  attachLockedBarNotice,
  cancelActiveDrag,
  beginExclusiveDrag,
  endExclusiveDrag,
} from "./timeline.js";
import { renderPlanningInner, refreshPlanningBlocks } from "./render_planning.js";
import { buildLeafSeries, computeMaxY, buildChartSvg, buildAxisLabels } from "./render_workload_chart.js";
import { fetchLeavesCarico } from "./api.js";

const TOOLBAR_HEIGHT = 30; // deve combaciare con l'altezza fissata in .calendar-toolbar (style.css)
const PROXY_HEIGHT = 14; // deve combaciare con .calendar-scrollbar-proxy (style.css)
const SUPER_HEADER_HEIGHT = 20; // fascia settimane/mesi/anni (o giorni, in Pianificazione) sopra l'intestazione normale
// più basso dei 90px del grafico "carico complessivo" nel Gantt (che vive in un template suo,
// libero di essere alto quanto serve): qui invece lo spazio sopra la <table> FOGLIE è reale,
// preso in prestito dal margin-bottom della barra filtri (vedi renderFilterBar in
// render_leaves.js) — va tenuto contenuto. Esportato perché render_leaves.js deve riservargli
// davvero quello spazio (altrimenti il grafico, per quanto ben calcolato qui, si
// sovrapporrebbe alle prime barre reali sotto — un overlay non può "spingere giù" la vera
// tabella sotto di sé, che non sa nulla di lui)
export const CHART_ROW_HEIGHT = 64; // deve combaciare con .calendar-chart-scroll (style.css)

// stessa condizione usata più sotto in renderCalendarOverlay per costruire la riga del
// grafico: esportata perché render_leaves.js deve riservargli lo spazio reale sopra la
// <table> (vedi renderFilterBar) PRIMA che renderCalendarOverlay stessa giri — deve restare
// l'unico posto dove questa condizione è scritta, non duplicata fra i due file
export function isWorkloadChartVisible() {
  return state.calendarOpen && state.calendarMode === "timeline";
}

// ---------------------------------------------------------------------------
// Carico di lavoro (grafico sopra la vista timeline, del tutto analogo al "carico
// complessivo" della Vista Gantt — vedi drawSummaryChart in render_gantt.js): le foglie con
// `value` già calcolato dal backend (mai duplicare la formula del carico in JS, vedi
// commento su /leaves-carico in app.py), per la somma esatta delle foglie ATTUALMENTE
// VISUALIZZATE in Vista Foglie col filtro selezionato — un elenco piatto già filtrato lato
// client, non un sottoalbero. Ricaricato solo quando cambia qualcosa che potrebbe cambiare
// il risultato (l'insieme di id visualizzati, o uno dei campi da cui dipende la formula del
// carico su uno di essi — non a ogni rerender): la vista si aggiorna da sé quando la
// risposta arriva.
// ---------------------------------------------------------------------------

let workloadLeavesKey = null;
let workloadLeaves = [];

function refreshWorkloadChartData(leaves) {
  const sorted = [...leaves].sort((a, b) => a.id - b.id);
  const key = sorted
    .map((l) => `${l.id}:${l.execution_date}:${l.deadline}:${l.estimated_days}:${l.status}:${l.label}`)
    .join("|");
  if (key === workloadLeavesKey) return;
  workloadLeavesKey = key;
  const ids = sorted.map((l) => l.id);
  if (ids.length === 0) {
    workloadLeaves = [];
    return;
  }
  fetchLeavesCarico(ids)
    .then((result) => {
      workloadLeaves = result;
      rerender();
    })
    .catch(() => {
      workloadLeaves = [];
    });
}

// stessa idea di drawSummaryChart nel Gantt: stessi buckets/stessa larghezza totale della
// timeline sottostante (bucket-allineato con essa), inserita come riga scorrevole in più
// nel gruppo di sincronizzazione orizzontale (vedi syncTargets in renderCalendarOverlay).
// L'asse delle percentuali non ha, qui, una colonna riservata a fianco come nel Gantt
// (l'outline pane): resta "agganciato" (position: sticky) al bordo sinistro del riquadro
// scorrevole invece di occupare spazio proprio, sovrapponendosi appena al grafico sotto di
// sé — stesso principio della prima colonna "congelata" di un foglio di calcolo
function buildChartRow(buckets, totalWidth) {
  const chartScroll = document.createElement("div");
  chartScroll.className = "calendar-chart-scroll";

  const chartInner = document.createElement("div");
  chartInner.className = "calendar-chart-inner";
  chartInner.style.width = `${totalWidth}px`;

  const series = buildLeafSeries(workloadLeaves, buckets);
  const maxY = computeMaxY([{ values: series }]);

  // l'SVG riempie tutto .calendar-chart-inner (posizionato fuori dal flusso, invece che
  // semplicemente "sotto" le etichette in blocco): le etichette dell'asse, in flusso
  // normale, vi galleggiano sopra invece di spingerlo più in basso, fuori dall'area visibile
  // (.calendar-chart-scroll ha overflow-y: hidden)
  const svg = buildChartSvg(buckets, totalWidth, [{ values: series, className: "workload-chart-global-line" }], maxY);
  svg.classList.add("calendar-chart-svg-layer");
  chartInner.appendChild(svg);

  const axisLabels = buildAxisLabels(maxY);
  axisLabels.classList.add("calendar-chart-axis-labels");
  // .calendar-chart-inner non è un contenitore flex (a differenza di .workload-chart-axis
  // nella vista Carico di lavoro): senza un'altezza esplicita le etichette, posizionate in
  // percentuale, collasserebbero tutte a top:0 (stesso accorgimento del Gantt, vedi
  // drawSummaryChart in render_gantt.js)
  axisLabels.style.height = "100%";
  chartInner.appendChild(axisLabels);

  chartScroll.appendChild(chartInner);
  return chartScroll;
}

// ---------------------------------------------------------------------------
// Corpo della vista "timeline" (barre EX/DL a bucket giorno/settimana/mese/anno):
// tutta la logica già esistente, invariata, solo estratta in funzione per convivere
// con il corpo alternativo della vista "Pianificazione" (vedi render_planning.js)
// ---------------------------------------------------------------------------

function renderTimelineInner(headerInner, inner, leaves, bodyRows, tableRect, tableHeight, superHeaderHeight, granularity, theadHeight, opts = {}) {
  const { afterCommit } = opts;
  const buckets = buildBuckets(leaves, granularity);
  const totalWidth = buckets.reduce((sum, b) => sum + b.width, 0);
  const todayIndex = buckets.findIndex((b) => b.isToday);
  // altezza della sola area righe (tableHeight della <table> reale include anche il suo
  // thead): da quando la fascia super-header + intestazione giorni vive in un contenitore
  // sticky separato (.calendar-header-scroll, vedi renderCalendarOverlay), .calendar-inner
  // rappresenta SOLO l'area corpo, quindi parte da top:0 invece che da superHeaderHeight
  const bodyHeight = tableHeight - theadHeight;

  // fascia superiore (settimane/mesi/anni raggruppati): per "anno" (vista "Globale") non
  // c'è raggruppamento, ma la fascia resta comunque presente (vuota, grigia) invece di
  // sparire — così l'altezza del calendario non cambia cambiando granularità.
  const superGroups = buildSuperHeaderGroups(buckets, granularity);

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
  headerInner.appendChild(superHeaderRow);

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
  headerInner.appendChild(headerRow);

  // sfondo grigio per le colonne di sabato/domenica (vista Giorno), disegnato per primo
  // così resta sotto le linee della griglia, la linea di "oggi" e le barre
  buckets.forEach((b, i) => {
    if (!b.isWeekend) return;
    const band = document.createElement("div");
    band.className = "calendar-weekend-band";
    band.style.left = `${bucketOffset(buckets, i)}px`;
    band.style.top = "0";
    band.style.width = `${b.width}px`;
    band.style.height = `${bodyHeight}px`;
    inner.appendChild(band);
  });

  // linee verticali grigie di separazione fra i bucket, per tutta l'altezza della tabella
  // (non solo nell'intestazione), disegnate prima delle barre così restano sullo sfondo
  buckets.forEach((b, i) => {
    const line = document.createElement("div");
    line.className = "calendar-grid-line";
    line.style.left = `${bucketOffset(buckets, i) + b.width}px`;
    line.style.top = "0";
    line.style.height = `${bodyHeight}px`;
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
    rowLine.style.top = `${rowRect.bottom - tableRect.top - theadHeight}px`;
    rowLine.style.width = `${totalWidth}px`;
    inner.appendChild(rowLine);
  });

  const todayOffset = todayLineOffset(buckets);
  if (todayOffset !== null) {
    const todayLine = document.createElement("div");
    todayLine.className = "calendar-today-line";
    todayLine.style.left = `${todayOffset}px`;
    todayLine.style.top = "0";
    todayLine.style.height = `${bodyHeight}px`;
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
    const top = rowRect.top - tableRect.top - theadHeight;
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
      // un task delegato è modificabile solo dall'esecutore (owner): per il committente i
      // puntini restano visibili ma solo informativi, con un avviso al posto del trascinamento
      const isOwner = node.owner_id === state.currentUser?.id;

      const leftHandle = document.createElement("div");
      leftHandle.className = isOwner ? "calendar-bar-handle left" : "calendar-bar-handle left info-only";
      bar.appendChild(leftHandle);

      const rightHandle = document.createElement("div");
      rightHandle.className = isOwner ? "calendar-bar-handle right" : "calendar-bar-handle right info-only";
      bar.appendChild(rightHandle);

      const centerHandle = document.createElement("div");
      centerHandle.className = isOwner ? "calendar-bar-handle center" : "calendar-bar-handle center info-only";
      bar.appendChild(centerHandle);

      if (isOwner) {
        centerHandle.title = "Trascina per spostare l'intera barra";
        attachBarHandleDrag(leftHandle, "left", node, buckets, totalWidth, inner, bar, { afterCommit });
        attachBarHandleDrag(rightHandle, "right", node, buckets, totalWidth, inner, bar, { afterCommit });
        attachBarMoveDrag(centerHandle, node, buckets, totalWidth, inner, bar, { afterCommit });
      } else {
        attachLockedBarNotice(leftHandle);
        attachLockedBarNotice(rightHandle);
        attachLockedBarNotice(centerHandle);
      }
    }

    inner.appendChild(bar);
  });

  const initialScrollLeft = todayIndex >= 0 ? Math.max(bucketOffset(buckets, todayIndex) - 40, 0) : 0;
  return { totalWidth, initialScrollLeft, buckets };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export function renderCalendarOverlay(mainPanel, leaves, opts = {}) {
  const {
    minCol = 1, defaultCol = 2, maxCol = 4,
    afterCommit, hidePianificazione = false, hideDateSort = false, hideWorkloadChart = false,
  } = opts;
  const table = mainPanel.querySelector("table.leaves-table");
  if (!table || !table.tHead) return;

  // la vista Carico di lavoro non offre "Pianificazione" (lavagna oraria personale, non
  // ha senso su task di più utenti): se lo stato globale del calendario era rimasto su
  // "planning" da un uso precedente in Foglie, si forza a "timeline" qui
  if (hidePianificazione && state.calendarMode === "planning") {
    state.calendarMode = "timeline";
  }
  const mode = state.calendarMode;
  const granularity = state.calendarGranularity;
  const superHeaderHeight = SUPER_HEADER_HEIGHT;
  // niente grafico in Pianificazione (lavagna oraria usa-e-getta, scorrelata da EX/DL: il
  // concetto di "carico % della giornata coperto da EX-DL" non si applica)
  const showWorkloadChart = !hideWorkloadChart && mode === "timeline";
  if (showWorkloadChart) refreshWorkloadChartData(leaves);
  const chartRowHeight = showWorkloadChart ? CHART_ROW_HEIGHT : 0;

  const tableRect = table.getBoundingClientRect();
  const theadHeight = table.tHead.getBoundingClientRect().height;
  const mainPanelRect = mainPanel.getBoundingClientRect();
  const mainPanelLeft = mainPanelRect.left;
  // il bordo sinistro del calendario è trascinabile fra le colonne minCol e maxCol (di
  // default, fra Titolo e Descrizione in Foglie): Data di esecuzione e Deadline restano
  // sempre coperte dal calendario, mai scopribili trascinando verso destra
  const minLeft = table.tHead.rows[0].children[minCol].getBoundingClientRect().right - mainPanelLeft;
  const maxLeft = table.tHead.rows[0].children[maxCol].getBoundingClientRect().right - mainPanelLeft;
  const defaultLeft = table.tHead.rows[0].children[defaultCol].getBoundingClientRect().right - mainPanelLeft;
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
  overlay.style.top = `${tableRect.top - mainPanelRect.top - TOOLBAR_HEIGHT - superHeaderHeight - chartRowHeight}px`;
  overlay.style.height = `${tableHeight + TOOLBAR_HEIGHT + PROXY_HEIGHT + superHeaderHeight + chartRowHeight}px`;

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

  // "Pianificazione" è un quinto bottone-vista pari agli altri, sempre a sinistra di
  // "Settimana": passa alla lavagna oraria usa-e-getta (render_planning.js), scorrelata
  // da EX/DL. Cliccare una qualunque granularità torna alla vista timeline a bucket.
  // Non ha senso in Carico di lavoro (è personale, non su task di più utenti).
  if (!hidePianificazione) {
    const planningBtn = document.createElement("button");
    planningBtn.className = "filter-group-btn";
    planningBtn.classList.toggle("active", mode === "planning");
    planningBtn.textContent = "Pianificazione";
    planningBtn.onclick = () => {
      state.calendarMode = "planning";
      rerender();
      refreshPlanningBlocks();
    };
    toolbar.appendChild(planningBtn);
  }

  GRANULARITIES.forEach(({ key, label }) => {
    const btn = document.createElement("button");
    btn.className = "filter-group-btn";
    btn.classList.toggle("active", mode === "timeline" && granularity === key);
    btn.textContent = label;
    btn.onclick = () => {
      state.calendarMode = "timeline";
      state.calendarGranularity = key;
      rerender();
    };
    toolbar.appendChild(btn);
  });

  // sorting secondario a scelta manuale (in aggiunta al criterio di ordinamento primario
  // della tabella FOGLIE), per data di esecuzione o per deadline, su tutti gli status —
  // resta valido anche in Pianificazione: determina comunque l'ordine delle righe.
  // Non applicabile in Carico di lavoro, che non usa state.leafFilters per l'ordinamento.
  if (!hideDateSort) {
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
  }

  overlay.appendChild(toolbar);

  // fascia super-header + intestazione giorni/ore: contenitore sticky separato da
  // .calendar-scroll (vedi sotto il perché), che scorre solo in orizzontale e resta
  // agganciato sotto la toolbar mentre #main-panel scorre in verticale
  const headerScroll = document.createElement("div");
  headerScroll.className = "calendar-header-scroll";
  headerScroll.style.top = `${TOOLBAR_HEIGHT}px`;
  headerScroll.style.height = `${superHeaderHeight + theadHeight}px`;

  const headerInner = document.createElement("div");
  headerInner.className = "calendar-header-inner";

  const scroll = document.createElement("div");
  scroll.className = "calendar-scroll";

  const inner = document.createElement("div");
  inner.className = "calendar-inner";

  const { totalWidth, initialScrollLeft, buckets } =
    mode === "planning"
      ? renderPlanningInner(headerInner, inner, leaves, bodyRows, tableRect, tableHeight, superHeaderHeight, theadHeight)
      : renderTimelineInner(headerInner, inner, leaves, bodyRows, tableRect, tableHeight, superHeaderHeight, granularity, theadHeight, { afterCommit });
  headerInner.style.width = `${totalWidth}px`;
  inner.style.width = `${totalWidth}px`;
  // .calendar-inner non ha altezza CSS propria: in flusso normale la sua altezza "auto"
  // sarebbe 0 (tutto il contenuto — bande, linee, barre — è position:absolute e non
  // contribuisce all'altezza del genitore). Senza questa riga il box reale di
  // .calendar-inner resterebbe alto 0px: le barre/linee restano visibili (sono figli
  // assoluti, possono "uscire" dal box), ma un click reale del mouse non arriverebbe mai al
  // listener mousedown attaccato a .calendar-inner (il click colpirebbe invece il genitore
  // .calendar-scroll) — è per questo che il trascina-per-creare in Pianificazione
  // risultava non rispondere al click reale, pur avendo funzionato nei test con eventi
  // sintetici dispatchati direttamente su inner.
  inner.style.height = `${tableHeight - theadHeight}px`;

  headerScroll.appendChild(headerInner);
  overlay.appendChild(headerScroll);

  // sticky anch'esso, agganciato subito sotto la fascia intestazione (stesso principio di
  // toolbar/headerScroll sopra): altrimenti, scorrendo #main-panel in verticale, finirebbe
  // nascosto/tagliato sotto di essa invece di restare visibile insieme al resto dell'intestazione
  const chartScroll = showWorkloadChart ? buildChartRow(buckets, totalWidth) : null;
  if (chartScroll) {
    chartScroll.style.top = `${TOOLBAR_HEIGHT + superHeaderHeight + theadHeight}px`;
    overlay.appendChild(chartScroll);
  }

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

  // scorrimento orizzontale sincronizzato fra tutti gli elementi (fascia intestazione
  // sticky, grafico del carico se presente, corpo, scrollbar "proxy" in fondo): qualunque
  // può iniziare lo scroll (drag diretto sul corpo, o sulla proxy), gli altri si allineano
  const syncTargets = chartScroll ? [headerScroll, chartScroll, scroll, proxy] : [headerScroll, scroll, proxy];
  let syncing = false;
  syncTargets.forEach((el) => {
    el.addEventListener("scroll", () => {
      if (syncing) return;
      syncing = true;
      syncTargets.forEach((other) => {
        if (other !== el) other.scrollLeft = el.scrollLeft;
      });
      syncing = false;
    });
  });

  overlay.appendChild(proxy);
  mainPanel.appendChild(overlay);

  scroll.scrollLeft = initialScrollLeft;
  headerScroll.scrollLeft = initialScrollLeft;
  if (chartScroll) chartScroll.scrollLeft = initialScrollLeft;
}
