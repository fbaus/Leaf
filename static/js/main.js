import { state, onRender, reload } from "./state.js";
import { renderTree } from "./render_tree.js";
import { renderLeaves } from "./render_leaves.js";
import { renderNotesSidePanel } from "./render_notes.js";
import { openCreateModal, initModal } from "./modal.js";
import { captureFocus, restoreFocus } from "./focus.js";

const mainPanel = document.getElementById("main-panel");
const sidePanel = document.getElementById("side-panel");
const workspace = document.getElementById("workspace");
const panelResizeHandle = document.getElementById("panel-resize-handle");

function render() {
  document.body.dataset.view = state.currentView;
  document.querySelectorAll(".view-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.view === state.currentView);
  });

  // il pannello NOTE si popola in modo asincrono: il suo ripristino del focus avviene
  // dentro renderNotesSidePanel stesso, una volta che il contenuto è davvero nel DOM
  const mainFocus = captureFocus(mainPanel);
  const sideFocus = captureFocus(sidePanel);

  mainPanel.innerHTML = "";
  sidePanel.innerHTML = "";

  if (state.currentView === "albero") {
    renderTree(mainPanel);
    renderNotesSidePanel(sidePanel, sideFocus);
  } else if (state.currentView === "foglie") {
    renderLeaves(mainPanel, sidePanel);
  }

  const customWidth = state.currentView === "albero" && state.sidePanelWidth !== null;
  sidePanel.style.width = customWidth ? `${state.sidePanelWidth}px` : "";
  sidePanel.style.maxWidth = customWidth ? "none" : "";

  restoreFocus(mainPanel, mainFocus);
}

onRender(render);

// ---------------------------------------------------------------------------
// Divisore trascinabile fra area NODI e area NOTE (vista ALBERO)
// ---------------------------------------------------------------------------

let activePanelResizeCleanup = null;

panelResizeHandle.addEventListener("mousedown", (e) => {
  e.preventDefault();
  if (activePanelResizeCleanup) activePanelResizeCleanup();

  const workspaceRect = workspace.getBoundingClientRect();
  const minWidth = 200;
  const maxWidth = workspaceRect.width * 0.7;

  const onMouseMove = (moveEvent) => {
    const newWidth = Math.min(Math.max(workspaceRect.right - moveEvent.clientX, minWidth), maxWidth);
    state.sidePanelWidth = newWidth;
    sidePanel.style.width = `${newWidth}px`;
    sidePanel.style.maxWidth = "none";
  };
  const onMouseUp = () => {
    document.removeEventListener("mousemove", onMouseMove);
    document.removeEventListener("mouseup", onMouseUp);
    activePanelResizeCleanup = null;
  };
  activePanelResizeCleanup = onMouseUp;
  document.addEventListener("mousemove", onMouseMove);
  document.addEventListener("mouseup", onMouseUp);
});

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

  initModal(() => reload());

  reload();
});
