import { fetchTasks } from "./api.js";

export const state = {
  tasks: [],
  currentView: "albero",
  expandedIds: new Set(),
  searchText: "",
  leafFilters: {
    statusGroup: "APERTE",
    rootIds: null, // null = tutti i progetti visibili
    sortBy: "status",
  },
  selectedNoteNodeId: null,
  focusNewNoteInput: false,
  scrollToNodeId: null,
  highlightedDepsSourceId: null, // id del task il cui bottone "Dipendenze" è attivo
  highlightedDepsIds: new Set(), // id dei nodi dipendenza da evidenziare in giallo
  calendarOpen: false,
  calendarGranularity: "giorno", // "giorno" | "settimana" | "mese" | "anno"
  calendarLeftOffset: null, // px da sinistra di #main-panel al bordo sinistro del calendario; null = default
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
