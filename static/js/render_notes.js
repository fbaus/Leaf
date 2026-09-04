import { state, rerender } from "./state.js";
import { byId } from "./utils.js";
import { addNote, updateNote, fetchNotesSubtree } from "./api.js";
import { jumpToTree } from "./navigate.js";

function renderComposeBox(sidePanel, nodeId) {
  const box = document.createElement("div");
  box.className = "note-compose";

  const textarea = document.createElement("textarea");
  textarea.placeholder = "Scrivi una nuova nota...";
  textarea.cols = 80;
  textarea.rows = 5;
  box.appendChild(textarea);

  const addBtn = document.createElement("button");
  addBtn.textContent = "Aggiungi nota";
  addBtn.onclick = async () => {
    const text = textarea.value.trim();
    if (!text) return;
    try {
      await addNote(nodeId, text);
      rerender();
    } catch (err) {
      alert(err.message);
    }
  };
  box.appendChild(addBtn);

  sidePanel.appendChild(box);

  if (state.focusNewNoteInput) {
    textarea.focus();
    state.focusNewNoteInput = false;
  }
}

function renderNoteBox(sidePanel, note, tasksById) {
  const box = document.createElement("div");
  box.className = "note-box";

  const nodeLabel = document.createElement("div");
  nodeLabel.className = "note-node-title leaf-title-cell";
  nodeLabel.textContent = tasksById[note.task_id]?.title || "—";
  nodeLabel.title = "Vai nell'albero";
  nodeLabel.onclick = () => jumpToTree(note.task_id);
  box.appendChild(nodeLabel);

  const dateLabel = document.createElement("div");
  dateLabel.className = "note-date";
  dateLabel.textContent = note.note_date;
  box.appendChild(dateLabel);

  const textarea = document.createElement("textarea");
  textarea.value = note.text;
  box.appendChild(textarea);

  const saveBtn = document.createElement("button");
  saveBtn.textContent = "Salva modifiche";
  saveBtn.onclick = async () => {
    try {
      await updateNote(note.id, textarea.value);
      rerender();
    } catch (err) {
      alert(err.message);
    }
  };
  box.appendChild(saveBtn);

  sidePanel.appendChild(box);
}

let notesRequestToken = 0;

async function loadAndRenderNotes(sidePanel, nodeId) {
  const requestToken = ++notesRequestToken;
  const notes = await fetchNotesSubtree(nodeId);

  // una selezione più recente ha già sostituito questo pannello: non scrivere dati stantii
  if (requestToken !== notesRequestToken) return;

  if (notes.length === 0) {
    const empty = document.createElement("p");
    empty.textContent = "Nessuna nota.";
    sidePanel.appendChild(empty);
    return;
  }

  const tasksById = byId(state.tasks);
  notes.forEach((note) => renderNoteBox(sidePanel, note, tasksById));
}

export function renderNotesSidePanel(sidePanel) {
  const heading = document.createElement("h3");
  heading.textContent = "Note";
  sidePanel.appendChild(heading);

  if (state.selectedNoteNodeId === null) {
    const placeholder = document.createElement("p");
    placeholder.textContent = "Seleziona un nodo nell'albero per leggere o scrivere le sue note.";
    sidePanel.appendChild(placeholder);
    return;
  }

  renderComposeBox(sidePanel, state.selectedNoteNodeId);
  loadAndRenderNotes(sidePanel, state.selectedNoteNodeId);
}
