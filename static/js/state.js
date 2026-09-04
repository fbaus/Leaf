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
