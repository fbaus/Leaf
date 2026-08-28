import { state, onRender, reload } from "./state.js";
import { renderTree } from "./render_tree.js";
import { renderLeaves } from "./render_leaves.js";
import { renderNodes } from "./render_nodes.js";
import { renderNotesView } from "./render_notes.js";
import { openCreateModal, initModal } from "./modal.js";

const mainPanel = document.getElementById("main-panel");
const sidePanel = document.getElementById("side-panel");

function render() {
  document.body.dataset.view = state.currentView;
  document.querySelectorAll(".view-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.view === state.currentView);
  });

  mainPanel.innerHTML = "";
  sidePanel.innerHTML = "";

  if (state.currentView === "albero") renderTree(mainPanel);
  else if (state.currentView === "foglie") renderLeaves(mainPanel, sidePanel);
  else if (state.currentView === "nodi") renderNodes(mainPanel);
  else if (state.currentView === "note") renderNotesView(mainPanel, sidePanel);
}

onRender(render);

document.addEventListener("DOMContentLoaded", () => {
  document.querySelectorAll(".view-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.currentView = btn.dataset.view;
      render();
    });
  });

  document.getElementById("add-root-task").addEventListener("click", () => {
    openCreateModal(null);
  });

  document.getElementById("expand-all").addEventListener("click", () => {
    state.tasks.forEach((t) => state.expandedIds.add(t.id));
    render();
  });

  document.getElementById("collapse-all").addEventListener("click", () => {
    state.expandedIds.clear();
    render();
  });

  document.getElementById("search-box").addEventListener("input", (e) => {
    state.searchText = e.target.value;
    render();
  });

  initModal(() => reload());

  reload();
});
