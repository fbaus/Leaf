import { state, rerender } from "./state.js";
import { buildTree, byId, extraBadges } from "./utils.js";
import { addNote, updateNote, fetchNotesSubtree } from "./api.js";

function selectNode(nodeId) {
  state.selectedNoteNodeId = nodeId;
  rerender();
}

function renderNoteNode(node) {
  const li = document.createElement("li");
  const row = document.createElement("div");
  row.className = "tree-row";

  const hasChildren = node.children.length > 0;
  let childrenUl = null;

  if (hasChildren) {
    const toggle = document.createElement("button");
    toggle.className = "toggle-btn";
    const expanded = state.expandedIds.has(node.id);
    toggle.textContent = expanded ? "▼" : "▶";

    childrenUl = document.createElement("ul");
    childrenUl.style.display = expanded ? "block" : "none";

    toggle.onclick = () => {
      const isExpanded = state.expandedIds.has(node.id);
      if (isExpanded) state.expandedIds.delete(node.id);
      else state.expandedIds.add(node.id);
      childrenUl.style.display = isExpanded ? "none" : "block";
      toggle.textContent = isExpanded ? "▶" : "▼";
    };
    row.appendChild(toggle);
  } else {
    const spacer = document.createElement("span");
    spacer.className = "toggle-spacer";
    row.appendChild(spacer);
  }

  const title = document.createElement("span");
  title.className = "node-title";
  title.title = "Clicca per vedere le note di questo nodo";
  if (state.selectedNoteNodeId === node.id) title.classList.add("selected-node");
  title.textContent = node.title;
  title.onclick = () => selectNode(node.id);
  row.appendChild(title);

  row.appendChild(extraBadges(node));

  const noteBtn = document.createElement("button");
  noteBtn.textContent = "📝";
  noteBtn.title = "Aggiungi nota";
  noteBtn.onclick = async () => {
    const text = prompt("Testo della nota:");
    if (!text) return;
    try {
      await addNote(node.id, text);
      state.selectedNoteNodeId = node.id;
      rerender();
    } catch (err) {
      alert(err.message);
    }
  };
  row.appendChild(noteBtn);

  li.appendChild(row);

  if (childrenUl) {
    node.children.forEach((c) => childrenUl.appendChild(renderNoteNode(c)));
    li.appendChild(childrenUl);
  }

  return li;
}

let notesRequestToken = 0;

async function renderNotesPanel(sidePanel, nodeId) {
  const requestToken = ++notesRequestToken;

  const heading = document.createElement("h3");
  heading.textContent = "Note";
  sidePanel.appendChild(heading);

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

  notes.forEach((note) => {
    const box = document.createElement("div");
    box.className = "note-box";

    const nodeLabel = document.createElement("div");
    nodeLabel.className = "note-node-title";
    nodeLabel.textContent = tasksById[note.task_id]?.title || "—";
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
  });
}

export function renderNotesView(mainPanel, sidePanel) {
  const tree = buildTree(state.tasks);
  const ul = document.createElement("ul");
  ul.className = "tree-root";
  tree.forEach((n) => ul.appendChild(renderNoteNode(n)));
  mainPanel.appendChild(ul);

  if (state.selectedNoteNodeId !== null) {
    renderNotesPanel(sidePanel, state.selectedNoteNodeId);
  }
}
