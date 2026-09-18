import { fetchTasks, fetchWorkload } from "./api.js";

export const state = {
  tasks: [],
  workloadUsers: [], // dati della vista "Carico di lavoro" (GET /workload), caricati on-demand
  expandedWorkloadUserIds: new Set(),
  // id utente -> il suo grafico storico è aperto (indipendente dall'espansione della riga
  // utente: il grafico non è sempre visibile, va aperto a parte col suo bottone freccia)
  expandedWorkloadChartUserIds: new Set(),
  // granularità condivisa fra tutti i grafici storici degli utenti espansi (render_workload_chart.js)
  workloadGranularity: "settimana",
  // id dei singoli task (progetti/deleghe) con la spunta "grafico" attiva, sovrapposti al
  // grafico globale del rispettivo utente — condiviso perché gli id sono univoci in tutta l'app
  workloadCheckedEntryIds: new Set(),
  currentUser: null, // { id, username, is_superuser } dopo login/fetchMe riusciti, altrimenti null
  currentView: "albero",
  expandedIds: new Set(),
  searchText: "",
  leafFilters: {
    statusGroup: "APERTE",
    rootIds: null, // null = tutti i progetti visibili
    sortBy: "status",
    dateSecondarySort: null, // null | "execution_date" | "deadline" (bottoni EX/DL nel calendario)
  },
  selectedNoteNodeId: null,
  focusNewNoteInput: false,
  scrollToNodeId: null,
  highlightedDepsSourceId: null, // id del task il cui bottone "Dipendenze" è attivo
  highlightedDepsIds: new Set(), // id dei nodi dipendenza da evidenziare in giallo
  calendarOpen: false,
  calendarMode: "timeline", // "timeline" (barre EX/DL a bucket) | "planning" (lavagna oraria usa-e-getta)
  calendarGranularity: "giorno", // "giorno" | "settimana" | "mese" | "anno" (valida solo in modalità "timeline")
  calendarLeftOffset: null, // px da sinistra di #main-panel al bordo sinistro del calendario; null = default
  planningBlocks: [], // blocchi della vista Pianificazione, caricati on-demand (vedi refreshPlanningBlocks in render_planning.js)
  notesSearchText: "",
  expandedNoteIds: new Set(), // id delle singole note (per giorno) espanse a tutta l'altezza del testo
  editingNoteRowIds: new Set(), // id delle singole righe-nota (per giorno) in modifica inline
  sidePanelWidth: null, // px, larghezza #side-panel in ALBERO; null = default CSS (50%)
};

let renderCallback = () => {};

export function onRender(cb) {
  renderCallback = cb;
}

export function rerender() {
  renderCallback();
}

export async function reload() {
  state.tasks = await fetchTasks();
  rerender();
}

export async function reloadWorkload() {
  state.workloadUsers = await fetchWorkload();
  rerender();
}
