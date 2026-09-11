// Vista "Pianificazione": lavagna oraria usa-e-getta dentro il Calendario (vedi
// render_calendar.js, che la richiama al posto della timeline a bucket quando
// state.calendarMode === "planning"). Griglia fissa di 7 giorni da oggi, passo di 15
// minuti, scorrelata da status/EX/DL dei task: serve solo da riferimento leggero per la
// giornata, non è un piano vero e proprio (il passato viene cancellato lato server ad
// ogni apertura, vedi GET /planning in app.py).

import { state, rerender } from "./state.js";
import { fetchPlanningBlocks, createPlanningBlock, updatePlanningBlock, deletePlanningBlock } from "./api.js";
import { showContextMenu } from "./context_menu.js";
import {
  PLANNING_DAYS,
  buildPlanningDays,
  planningDayWidth,
  planningMinutesToX,
  planningXToMinutes,
  planningTodayLineOffset,
  createDragTooltip,
  beginExclusiveDrag,
  endExclusiveDrag,
} from "./timeline.js";

function formatHourLabel(hour) {
  return `${String(hour).padStart(2, "0")}:00`;
}

function formatMinutes(totalMinutes) {
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

// la linea "adesso" si aggiorna da sola, senza bisogno di refreshare la pagina: ogni tick
// sposta solo lo style.left dell'elemento già presente nel DOM (nessun ridisegno della
// griglia, nessuna chiamata di rete) — un lavoro trascurabile, quindi 30s di cadenza sono
// più che sufficienti (la linea si sposta di 1px al minuto, lo scarto resta impercettibile).
// Gira per tutta la vita della pagina: costa una singola query DOM ogni 30s anche quando la
// vista Pianificazione non è aperta, il che è già abbastanza leggero da non giustificare la
// complessità di un avvio/arresto legato all'apertura/chiusura del Calendario
setInterval(() => {
  if (state.calendarMode !== "planning") return;
  const line = document.querySelector(".calendar-today-line");
  if (!line) return;
  line.style.left = `${planningTodayLineOffset()}px`;
}, 30000);

// ricarica i blocchi dal server e ridisegna — va chiamata esplicitamente (ingresso in
// modalità Pianificazione, dopo una creazione/eliminazione), mai dentro il rendering
// stesso: altrimenti ogni fetch->rerender ne innescherebbe un altro all'infinito
export function refreshPlanningBlocks() {
  fetchPlanningBlocks()
    .then((blocks) => {
      state.planningBlocks = blocks;
      rerender();
    })
    .catch((err) => alert(err.message));
}

function rowIndexForY(rowRanges, y) {
  return rowRanges.findIndex((r) => y >= r.top && y < r.bottom);
}

// gesto di creazione: click-e-trascina su un'area vuota della griglia (non su un blocco
// già esistente) disegna un blocco transitorio e lo salva al rilascio. Diverso dal
// trascinamento di un'estremità/barra esistente (attachBarHandleDrag/attachBarMoveDrag in
// timeline.js): qui non c'è ancora nulla, riusa solo le primitive di coordinate/tooltip/
// esclusione-drag già pronte
function attachPlanningCreateDrag(inner, leaves, rowRanges, days, dayWidth, superHeaderHeight) {
  inner.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    if (e.target.closest(".planning-block")) return;

    const innerRect = inner.getBoundingClientRect();
    const yRelativeToTable = e.clientY - innerRect.top - superHeaderHeight;
    const rowIndex = rowIndexForY(rowRanges, yRelativeToTable);
    if (rowIndex < 0) return;
    const node = leaves[rowIndex];
    const range = rowRanges[rowIndex];
    if (!node || !range) return;

    e.preventDefault();

    const xStart = e.clientX - innerRect.left;
    const anchor = planningXToMinutes(xStart);
    const dayStartX = anchor.dayIndex * dayWidth;
    const dayEndX = dayStartX + dayWidth - 1;

    const bar = document.createElement("div");
    bar.className = "calendar-bar planning-block";
    const height = range.bottom - range.top;
    bar.style.top = `${range.top + height * 0.3 + superHeaderHeight}px`;
    bar.style.height = `${height * 0.4}px`;
    inner.appendChild(bar);

    const tooltip = createDragTooltip();

    const updateBar = (current) => {
      const startMin = Math.min(anchor.minutes, current.minutes);
      const endMin = Math.max(anchor.minutes, current.minutes);
      const left = planningMinutesToX(anchor.dayIndex, startMin);
      const right = planningMinutesToX(anchor.dayIndex, endMin);
      bar.style.left = `${left + 1}px`;
      bar.style.width = `${Math.max(right - left - 2, 2)}px`;
      return { startMin, endMin };
    };

    let lastRange = updateBar(anchor);

    const onMouseMove = (moveEvent) => {
      // il blocco non attraversa la mezzanotte: la X resta clampata dentro il giorno
      // in cui è iniziato il trascinamento, prima ancora di convertirla in minuti
      const rawX = moveEvent.clientX - innerRect.left;
      const clampedX = Math.min(Math.max(rawX, dayStartX), dayEndX);
      const current = planningXToMinutes(clampedX);
      lastRange = updateBar(current);
      tooltip.textContent = `${formatMinutes(lastRange.startMin)} – ${formatMinutes(lastRange.endMin)}`;
      tooltip.style.left = `${moveEvent.clientX + 14}px`;
      tooltip.style.top = `${moveEvent.clientY - 28}px`;
    };

    const onMouseUp = () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      endExclusiveDrag();
      tooltip.remove();
      bar.remove();

      if (lastRange.endMin - lastRange.startMin >= 15) {
        createPlanningBlock({
          task_id: node.id,
          day: days[anchor.dayIndex].iso,
          start_min: lastRange.startMin,
          end_min: lastRange.endMin,
        })
          .then(() => refreshPlanningBlocks())
          .catch((err) => alert(err.message));
      }
    };

    beginExclusiveDrag(onMouseUp);
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  });
}

// trascinamento di un'estremità di un blocco già esistente (gli stessi "pallini di
// aggancio" di attachBarHandleDrag in timeline.js, ma su minuti invece che su date): il
// blocco resta sempre dentro il giorno in cui vive (non attraversa la mezzanotte, come in
// creazione), le due estremità si clampano a vicenda restando ad almeno 15 minuti di
// distanza. Niente maniglia centrale di spostamento in blocco: qui basta ridimensionare
function attachPlanningHandleDrag(handle, edge, block, dayIndex, dayWidth, inner, bar) {
  handle.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();

    const innerLeft = inner.getBoundingClientRect().left;
    const dayStartX = dayIndex * dayWidth;
    const dayEndX = dayStartX + dayWidth - 1;
    const originalStart = block.start_min;
    const originalEnd = block.end_min;
    let currentStart = originalStart;
    let currentEnd = originalEnd;

    const tooltip = createDragTooltip();

    const onMouseMove = (moveEvent) => {
      const rawX = moveEvent.clientX - innerLeft;
      const clampedX = Math.min(Math.max(rawX, dayStartX), dayEndX);
      const { minutes } = planningXToMinutes(clampedX);

      if (edge === "left") {
        currentStart = Math.min(Math.max(minutes, 0), originalEnd - 15);
      } else {
        currentEnd = Math.max(Math.min(minutes, 1440), originalStart + 15);
      }

      const left = planningMinutesToX(dayIndex, currentStart);
      const right = planningMinutesToX(dayIndex, currentEnd);
      bar.style.left = `${left + 1}px`;
      bar.style.width = `${Math.max(right - left - 2, 2)}px`;

      tooltip.textContent = `${formatMinutes(currentStart)} – ${formatMinutes(currentEnd)}`;
      tooltip.style.left = `${moveEvent.clientX + 14}px`;
      tooltip.style.top = `${moveEvent.clientY - 28}px`;
    };

    const onMouseUp = () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      endExclusiveDrag();
      tooltip.remove();

      if (edge === "left" && currentStart !== originalStart) {
        updatePlanningBlock(block.id, { start_min: currentStart })
          .then(() => refreshPlanningBlocks())
          .catch((err) => alert(err.message));
      } else if (edge === "right" && currentEnd !== originalEnd) {
        updatePlanningBlock(block.id, { end_min: currentEnd })
          .then(() => refreshPlanningBlocks())
          .catch((err) => alert(err.message));
      }
    };

    beginExclusiveDrag(onMouseUp);
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  });
}

export function renderPlanningInner(inner, leaves, bodyRows, tableRect, tableHeight, superHeaderHeight, theadHeight) {
  const days = buildPlanningDays();
  const dayWidth = planningDayWidth();
  const totalWidth = dayWidth * PLANNING_DAYS;

  // fascia superiore: un'etichetta per giorno (es. "giovedì 11 settembre"), stessa
  // classe del bucket-grid (super-header-cell) per restare visivamente coerente
  const superHeaderRow = document.createElement("div");
  superHeaderRow.className = "calendar-header-row";
  superHeaderRow.style.height = `${superHeaderHeight}px`;
  days.forEach((day) => {
    const cell = document.createElement("div");
    cell.className = "super-header-cell";
    cell.style.width = `${dayWidth}px`;
    cell.textContent = day.label;
    superHeaderRow.appendChild(cell);
  });
  inner.appendChild(superHeaderRow);

  // intestazione: una cella per ora, 24 per giorno (PX_PER_MINUTE=1 → 60px l'una)
  const headerRow = document.createElement("div");
  headerRow.className = "calendar-header-row";
  headerRow.style.height = `${theadHeight}px`;
  for (let d = 0; d < PLANNING_DAYS; d++) {
    for (let h = 0; h < 24; h++) {
      const cell = document.createElement("div");
      cell.className = "calendar-bucket-header";
      cell.style.width = "60px";
      cell.textContent = formatHourLabel(h);
      headerRow.appendChild(cell);
    }
  }
  inner.appendChild(headerRow);

  // sfondo grigio per le ore non lavorative (18:00-08:00, su ogni giorno) e per i giorni di
  // weekend (colonna intera): stesso trattamento visivo/classe usata in vista timeline per
  // sabato/domenica (.calendar-weekend-band, pointer-events:none), disegnato per primo così
  // resta sotto le linee della griglia e le barre. Puramente visivo: non limita in alcun modo
  // il gesto di creazione (il mousedown è su .calendar-inner, gli eventi arrivano comunque
  // per bubbling attraverso la banda). La banda copre solo l'area delle righe (sotto
  // l'intestazione oraria): essendo position:absolute renderebbe altrimenti sopra la riga di
  // intestazione (che è in flusso normale, non posizionata) nascondendo le etichette delle ore
  const rowsTop = superHeaderHeight + theadHeight;
  const rowsHeight = tableHeight - theadHeight;
  days.forEach((day, d) => {
    const dayOffset = d * dayWidth;
    const isWeekend = day.date.getDay() === 0 || day.date.getDay() === 6;
    if (isWeekend) {
      const band = document.createElement("div");
      band.className = "calendar-weekend-band";
      band.style.left = `${dayOffset}px`;
      band.style.top = `${rowsTop}px`;
      band.style.width = `${dayWidth}px`;
      band.style.height = `${rowsHeight}px`;
      inner.appendChild(band);
    } else {
      [
        [0, 8 * 60],
        [18 * 60, 24 * 60],
      ].forEach(([startMin, endMin]) => {
        const band = document.createElement("div");
        band.className = "calendar-weekend-band";
        band.style.left = `${dayOffset + startMin}px`;
        band.style.top = `${rowsTop}px`;
        band.style.width = `${endMin - startMin}px`;
        band.style.height = `${rowsHeight}px`;
        inner.appendChild(band);
      });
    }
  });

  // righe-guida verticali: una piena ad ogni ora (anche sui confini di giornata), una
  // più chiara ad ogni quarto d'ora
  for (let d = 0; d < PLANNING_DAYS; d++) {
    for (let q = 1; q <= 24 * 4; q++) {
      const minutes = q * 15;
      const x = planningMinutesToX(d, minutes);
      const line = document.createElement("div");
      line.className = minutes % 60 === 0 ? "calendar-grid-line" : "planning-quarter-line";
      line.style.left = `${x}px`;
      line.style.top = `${superHeaderHeight}px`;
      line.style.height = `${tableHeight}px`;
      inner.appendChild(line);
    }
  }

  // riga orizzontale per ogni task, stesso bordo della tabella FOGLIE reale (stessa
  // tecnica di misurazione della vista timeline, per restare allineati alla tabella)
  const rowRanges = bodyRows.map((tr) => {
    const r = tr.getBoundingClientRect();
    return { top: r.top - tableRect.top, bottom: r.bottom - tableRect.top };
  });
  rowRanges.forEach((r) => {
    const rowLine = document.createElement("div");
    rowLine.className = "calendar-row-line";
    rowLine.style.top = `${r.bottom + superHeaderHeight}px`;
    rowLine.style.width = `${totalWidth}px`;
    inner.appendChild(rowLine);
  });

  // linea "adesso": sempre nel giorno 0, che è sempre oggi (primo della finestra)
  const nowOffset = planningTodayLineOffset();
  const todayLine = document.createElement("div");
  todayLine.className = "calendar-today-line";
  todayLine.style.left = `${nowOffset}px`;
  todayLine.style.top = `${superHeaderHeight}px`;
  todayLine.style.height = `${tableHeight}px`;
  inner.appendChild(todayLine);

  // blocchi esistenti (solo quelli la cui riga è fra le foglie attualmente visibili)
  const dayIndexByIso = new Map(days.map((d, i) => [d.iso, i]));
  (state.planningBlocks || []).forEach((block) => {
    const rowIndex = leaves.findIndex((n) => n.id === block.task_id);
    const dayIndex = dayIndexByIso.get(block.day);
    if (rowIndex < 0 || dayIndex === undefined) return;
    const range = rowRanges[rowIndex];
    if (!range) return;

    const left = planningMinutesToX(dayIndex, block.start_min);
    const right = planningMinutesToX(dayIndex, block.end_min);
    const height = range.bottom - range.top;

    const bar = document.createElement("div");
    bar.className = "calendar-bar planning-block";
    bar.style.left = `${left + 1}px`;
    bar.style.width = `${Math.max(right - left - 2, 4)}px`;
    bar.style.top = `${range.top + height * 0.3 + superHeaderHeight}px`;
    bar.style.height = `${height * 0.4}px`;
    bar.title = `${leaves[rowIndex].title} (${formatMinutes(block.start_min)}–${formatMinutes(block.end_min)})`;

    const leftHandle = document.createElement("div");
    leftHandle.className = "calendar-bar-handle left";
    bar.appendChild(leftHandle);
    attachPlanningHandleDrag(leftHandle, "left", block, dayIndex, dayWidth, inner, bar);

    const rightHandle = document.createElement("div");
    rightHandle.className = "calendar-bar-handle right";
    bar.appendChild(rightHandle);
    attachPlanningHandleDrag(rightHandle, "right", block, dayIndex, dayWidth, inner, bar);

    bar.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      showContextMenu(e.clientX, e.clientY, [
        {
          label: "Elimina",
          onClick: () => {
            deletePlanningBlock(block.id)
              .then(() => refreshPlanningBlocks())
              .catch((err) => alert(err.message));
          },
        },
      ]);
    });
    inner.appendChild(bar);
  });

  attachPlanningCreateDrag(inner, leaves, rowRanges, days, dayWidth, superHeaderHeight);

  const initialScrollLeft = Math.max(nowOffset - 40, 0);
  return { totalWidth, initialScrollLeft };
}
