import { fetchTasks } from "./api.js";

export const state = {
  tasks: [],
  currentView: "albero",
  expandedIds: new Set(),
  searchText: "",
  leafFilters: {
    statusGroup: "TUTTE",
    rootIds: null, // null = tutti i progetti visibili
    sortBy: "padre",
  },
  selectedNoteNodeId: null,
  focusNewNoteInput: false,
  scrollToNodeId: null,
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
