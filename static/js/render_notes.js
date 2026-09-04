import { state, rerender } from "./state.js";
import { byId } from "./utils.js";
import { addNote, updateNote, fetchNotesSubtree } from "./api.js";
import { jumpToTree } from "./navigate.js";
import { renderNoteText } from "./note_links.js";
import { restoreFocus } from "./focus.js";

const MAX_DEFAULT_ENTRY_HEIGHT = 210; // ~10 righe

function formatNoteDate(isoDate) {
  const [y, m, d] = isoDate.split("-");
  return `${d}/${m}/${y}`;
}

function openAddNoteModal(nodeId, nodeTitle) {
  const overlay = document.createElement("div");
  overlay.className = "confirm-overlay";

  const box = document.createElement("div");
  box.className = "confirm-box note-modal-box";

  const heading = document.createElement("h3");
  heading.textContent = `Nuova nota — ${nodeTitle}`;
  box.appendChild(heading);

  const textarea = document.createElement("textarea");
  textarea.className = "note-modal-textarea";
  textarea.cols = 200;
  textarea.rows = 10;
  box.appendChild(textarea);

  const actions = document.createElement("div");
  actions.className = "confirm-actions";

  const cancelBtn = document.createElement("button");
  cancelBtn.textContent = "Annulla";
  cancelBtn.onclick = () => overlay.remove();
  actions.appendChild(cancelBtn);

  const addBtn = document.createElement("button");
  addBtn.textContent = "Aggiungi";
  addBtn.onclick = async () => {
    const text = textarea.value.trim();
    if (!text) return;
    try {
      await addNote(nodeId, text);
      overlay.remove();
      rerender();
    } catch (err) {
      alert(err.message);
    }
  };
  actions.appendChild(addBtn);

  box.appendChild(actions);

  let mouseDownOnBackdrop = false;
  overlay.addEventListener("mousedown", (e) => {
    mouseDownOnBackdrop = e.target === overlay;
  });
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay && mouseDownOnBackdrop) overlay.remove();
  });

  overlay.appendChild(box);
  document.body.appendChild(overlay);
  textarea.focus();
}

function applyDefaultHeight(entryBox, isExpanded) {
  if (isExpanded) {
    entryBox.style.height = `${entryBox.scrollHeight}px`;
  } else {
    entryBox.style.height = `${Math.min(entryBox.scrollHeight, MAX_DEFAULT_ENTRY_HEIGHT)}px`;
  }
}

function renderEntry(listEl, note, highlightTerm) {
  const row = document.createElement("div");
  row.className = "note-entry-row";

  const controls = document.createElement("div");
  controls.className = "note-entry-controls";

  const editBtn = document.createElement("button");
  editBtn.className = "note-entry-edit-btn";
  editBtn.textContent = "✎";
  editBtn.title = "Modifica questa nota";
  editBtn.onclick = () => {
    state.editingNoteRowIds.add(note.id);
    rerender();
  };
  controls.appendChild(editBtn);

  const isExpanded = state.expandedNoteIds.has(note.id);
  const expandBtn = document.createElement("button");
  expandBtn.className = "note-entry-expand-btn";
  expandBtn.textContent = isExpanded ? "⤡" : "⤢";
  expandBtn.title = isExpanded ? "Comprimi" : "Espandi a tutto il testo";
  expandBtn.onclick = () => {
    if (isExpanded) state.expandedNoteIds.delete(note.id);
    else state.expandedNoteIds.add(note.id);
    rerender();
  };
  controls.appendChild(expandBtn);

  row.appendChild(controls);

  const entryBox = document.createElement("div");
  entryBox.className = "note-entry-box";

  const dateLabel = document.createElement("div");
  dateLabel.className = "note-entry-date";
  dateLabel.textContent = formatNoteDate(note.note_date);
  entryBox.appendChild(dateLabel);

  if (state.editingNoteRowIds.has(note.id)) {
    const textarea = document.createElement("textarea");
    textarea.className = "note-entry-edit";
    textarea.value = note.text;
    textarea.rows = 6;
    entryBox.appendChild(textarea);

    const saveBtn = document.createElement("button");
    saveBtn.className = "note-entry-save-btn";
    saveBtn.textContent = "Salva";
    saveBtn.onclick = async () => {
      try {
        await updateNote(note.id, textarea.value);
        state.editingNoteRowIds.delete(note.id);
        rerender();
      } catch (err) {
        alert(err.message);
      }
    };
    entryBox.appendChild(saveBtn);
  } else {
    const textDiv = document.createElement("div");
    textDiv.className = "note-entry-text";
    renderNoteText(textDiv, note.text, highlightTerm);
    entryBox.appendChild(textDiv);
  }

  row.appendChild(entryBox);
  listEl.appendChild(row);

  // niente misurazione qui: l'elemento non è ancora nel documento (scrollHeight
  // sarebbe 0), va fatta dopo che l'intera card è stata attaccata al DOM reale
  return state.editingNoteRowIds.has(note.id) ? null : { entryBox, isExpanded };
}

function renderNodeCard(sidePanel, taskId, notesForTask, tasksById) {
  const isSelected = taskId === state.selectedNoteNodeId;

  const card = document.createElement("div");
  card.className = "note-card";

  const header = document.createElement("div");
  header.className = "note-card-header";

  const titleEl = document.createElement("span");
  titleEl.className = "note-node-title leaf-title-cell";
  titleEl.textContent = tasksById[taskId]?.title || "—";
  titleEl.title = "Vai nell'albero";
  titleEl.onclick = () => jumpToTree(taskId);
  header.appendChild(titleEl);

  card.appendChild(header);

  if (isSelected) {
    const searchInput = document.createElement("input");
    searchInput.type = "text";
    searchInput.className = "notes-search-box";
    searchInput.placeholder = "Cerca nelle note...";
    searchInput.value = state.notesSearchText;
    searchInput.dataset.preserveFocusKey = "notes-search";
    searchInput.oninput = (e) => {
      state.notesSearchText = e.target.value;
      rerender();
    };
    card.appendChild(searchInput);
  }

  const sorted = [...notesForTask].sort((a, b) => b.note_date.localeCompare(a.note_date));
  const needle = isSelected ? state.notesSearchText.trim().toLowerCase() : "";
  const visible = needle ? sorted.filter((n) => n.text.toLowerCase().includes(needle)) : sorted;

  let toMeasure = [];
  if (visible.length === 0) {
    const empty = document.createElement("p");
    empty.className = "note-history-empty";
    empty.textContent = needle ? "Nessuna nota corrisponde alla ricerca." : "Nessuna nota.";
    card.appendChild(empty);
  } else {
    const list = document.createElement("div");
    list.className = "note-entry-list";
    toMeasure = visible.map((note) => renderEntry(list, note, needle)).filter(Boolean);
    card.appendChild(list);
  }

  sidePanel.appendChild(card);

  // solo ora la card è nel documento: scrollHeight riflette il layout vero
  toMeasure.forEach(({ entryBox, isExpanded }) => applyDefaultHeight(entryBox, isExpanded));
}

function groupByTask(notes) {
  const map = new Map();
  notes.forEach((n) => {
    if (!map.has(n.task_id)) map.set(n.task_id, []);
    map.get(n.task_id).push(n);
  });
  return map;
}

function orderedTaskIds(grouped) {
  const ids = [...grouped.keys()];
  const maxDate = (taskId) => grouped.get(taskId).reduce((m, n) => (n.note_date > m ? n.note_date : m), "");
  ids.sort((a, b) => {
    if (a === state.selectedNoteNodeId) return -1;
    if (b === state.selectedNoteNodeId) return 1;
    return maxDate(b).localeCompare(maxDate(a));
  });
  return ids;
}

let notesRequestToken = 0;

async function loadAndRenderNotes(sidePanel, nodeId, focusToRestore) {
  const requestToken = ++notesRequestToken;
  const notes = await fetchNotesSubtree(nodeId);

  // una selezione più recente ha già sostituito questo pannello: non scrivere dati stantii
  if (requestToken !== notesRequestToken) return;

  const grouped = groupByTask(notes);
  if (!grouped.has(nodeId)) grouped.set(nodeId, []); // il nodo selezionato mostra sempre la sua card, anche senza note

  const tasksById = byId(state.tasks);
  orderedTaskIds(grouped).forEach((taskId) => {
    renderNodeCard(sidePanel, taskId, grouped.get(taskId), tasksById);
  });

  // il pannello note si popola in modo asincrono (fetch): il ripristino del focus del campo
  // di ricerca note va rifatto qui, dopo che le card esistono davvero nel DOM
  restoreFocus(sidePanel, focusToRestore);

  if (state.focusNewNoteInput) {
    state.focusNewNoteInput = false;
    openAddNoteModal(nodeId, tasksById[nodeId]?.title || "—");
  }
}

export function renderNotesSidePanel(sidePanel, focusToRestore) {
  const heading = document.createElement("h3");
  heading.textContent = "Note";
  sidePanel.appendChild(heading);

  if (state.selectedNoteNodeId === null) {
    const placeholder = document.createElement("p");
    placeholder.textContent = "Seleziona un nodo nell'albero per leggere o scrivere le sue note.";
    sidePanel.appendChild(placeholder);
    return;
  }

  const tasksById = byId(state.tasks);
  const addBtn = document.createElement("button");
  addBtn.className = "add-note-btn";
  addBtn.textContent = "+ Aggiungi nota";
  addBtn.onclick = () => openAddNoteModal(state.selectedNoteNodeId, tasksById[state.selectedNoteNodeId]?.title || "—");
  sidePanel.appendChild(addBtn);

  loadAndRenderNotes(sidePanel, state.selectedNoteNodeId, focusToRestore);
}
