import { state, onRender, reload, reloadWorkload, USER_ROOT_KEY } from "./state.js";
import { renderTree } from "./render_tree.js";
import { renderLeaves } from "./render_leaves.js";
import { renderWorkload } from "./render_workload.js";
import { renderNotesSidePanel } from "./render_notes.js";
import { renderTicket } from "./render_ticket.js";
import { openCreateModal, openCreateTicketModal, initModal } from "./modal.js";
import { captureFocus, restoreFocus } from "./focus.js";
import { refreshGanttIfOpen } from "./render_gantt.js";
import { fetchMe } from "./api.js";
import { initLogin, showLoginOverlay } from "./login.js";
import { initSettings } from "./settings.js";

const mainPanel = document.getElementById("main-panel");
const sidePanel = document.getElementById("side-panel");
const workspace = document.getElementById("workspace");
const panelResizeHandle = document.getElementById("panel-resize-handle");
const userInfo = document.getElementById("user-info");
const currentUsernameEl = document.getElementById("current-username");
const viewAllToggle = document.getElementById("view-all-toggle");

function updateUserInfo() {
  currentUsernameEl.textContent = state.currentUser ? state.currentUser.username : "";
  userInfo.classList.toggle("hidden", !state.currentUser);
  viewAllToggle.classList.toggle("hidden", !state.currentUser?.is_superuser);
  viewAllToggle.classList.toggle("active", state.viewAllUsers);
}

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
  } else if (state.currentView === "carico") {
    renderWorkload(mainPanel, sidePanel);
  } else if (state.currentView === "ticket") {
    renderTicket(mainPanel, sidePanel, sideFocus);
  }

  const customWidth =
    (state.currentView === "albero" || state.currentView === "ticket") && state.sidePanelWidth !== null;
  sidePanel.style.width = customWidth ? `${state.sidePanelWidth}px` : "";
  sidePanel.style.maxWidth = customWidth ? "none" : "";

  restoreFocus(mainPanel, mainFocus);
  refreshGanttIfOpen();
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

document.addEventListener("DOMContentLoaded", async () => {
  document.querySelectorAll(".view-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.currentView = btn.dataset.view;
      // cambiare vista è il gesto di "navigazione" più naturale e frequente: senza un
      // refetch qui, un cambiamento fatto da un altro utente (es. l'esecutore di un task
      // delegato che sposta la deadline) resta invisibile finché non si ricarica l'intera
      // pagina — reload()/reloadWorkload() rifanno anche il render, non serve chiamarlo a parte
      if (state.currentView === "carico") reloadWorkload();
      else reload();
    });
  });

  document.getElementById("add-root-task").addEventListener("click", () => {
    openCreateModal(null);
  });

  document.getElementById("add-ticket-task").addEventListener("click", () => {
    openCreateTicketModal();
  });

  viewAllToggle.addEventListener("click", async () => {
    state.viewAllUsers = !state.viewAllUsers;
    updateUserInfo();
    if (state.currentView === "carico") await reloadWorkload();
    else await reload();
  });

  document.getElementById("expand-all").addEventListener("click", () => {
    state.tasks.forEach((t) => state.expandedIds.add(t.id));
    state.expandedIds.add(USER_ROOT_KEY);
    render();
  });

  document.getElementById("collapse-all").addEventListener("click", () => {
    state.expandedIds.clear();
    render();
  });

  initModal(() => reload());
  initSettings();

  // gate di sessione: se /me risponde 401 (nessuna sessione valida) si mostra il login
  // invece di procedere con reload() — è la primissima chiamata di rete che l'app fa
  initLogin(async (user) => {
    state.currentUser = user;
    updateUserInfo();
    await reload();
  });

  try {
    state.currentUser = await fetchMe();
    updateUserInfo();
    await reload();
  } catch (e) {
    showLoginOverlay();
  }
});
