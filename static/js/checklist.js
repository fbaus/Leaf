import {
  fetchChecklist,
  addChecklistItem,
  updateChecklistItem,
  deleteChecklistItem,
  convertAllChecklistItems,
} from "./api.js";
import { showConfirmDialog } from "./confirm_dialog.js";

function dateSortKey(value) {
  return value ? value : "9999-99-99";
}

function sortItems(items) {
  return [...items].sort((a, b) => dateSortKey(a.deadline).localeCompare(dateSortKey(b.deadline)));
}

function createDraftItem() {
  return { id: null, description: "", assegnato: "", execution_date: "", deadline: "", completed: 0 };
}

// `onConverted` viene chiamato dopo una trasformazione riuscita, per far ricaricare
// all'esterno (modal.js) la lista dei task e mostrare il nuovo nodo nell'albero
export function renderChecklist(container, taskId, onConverted) {
  let items = [];
  let draft = null; // al massimo una riga non ancora salvata per volta

  async function load() {
    items = await fetchChecklist(taskId);
    draw();
  }

  async function saveField(item, field, value) {
    item[field] = value;

    if (item.id === null) {
      if (!item.description || !item.description.trim()) return;
      try {
        const saved = await addChecklistItem(taskId, {
          description: item.description.trim(),
          assegnato: item.assegnato || null,
          execution_date: item.execution_date || null,
          deadline: item.deadline || null,
        });
        draft = null;
        items.push(saved);
        draw();
      } catch (err) {
        alert(err.message);
      }
      return;
    }

    try {
      await updateChecklistItem(item.id, { [field]: value });
      if (field === "deadline" || field === "completed") draw();
    } catch (err) {
      alert(err.message);
    }
  }

  function renderRow(item) {
    const tr = document.createElement("tr");
    if (item.completed) tr.classList.add("checklist-row-completed");

    const tdDone = document.createElement("td");
    const doneCb = document.createElement("input");
    doneCb.type = "checkbox";
    doneCb.checked = !!item.completed;
    doneCb.disabled = item.id === null;
    doneCb.title = "Completato";
    doneCb.onchange = () => saveField(item, "completed", doneCb.checked);
    tdDone.appendChild(doneCb);
    tr.appendChild(tdDone);

    const tdDesc = document.createElement("td");
    const descInput = document.createElement("input");
    descInput.type = "text";
    descInput.maxLength = 60;
    descInput.placeholder = "Descrizione";
    descInput.value = item.description || "";
    descInput.onblur = () => saveField(item, "description", descInput.value.trim());
    tdDesc.appendChild(descInput);
    tr.appendChild(tdDesc);

    const tdAssegnato = document.createElement("td");
    const assegnatoInput = document.createElement("input");
    assegnatoInput.type = "text";
    assegnatoInput.maxLength = 20;
    assegnatoInput.placeholder = "Assegnato";
    assegnatoInput.value = item.assegnato || "";
    assegnatoInput.onblur = () => saveField(item, "assegnato", assegnatoInput.value.trim());
    tdAssegnato.appendChild(assegnatoInput);
    tr.appendChild(tdAssegnato);

    const tdExec = document.createElement("td");
    const execInput = document.createElement("input");
    execInput.type = "date";
    execInput.value = item.execution_date || "";
    execInput.onchange = () => saveField(item, "execution_date", execInput.value || null);
    tdExec.appendChild(execInput);
    tr.appendChild(tdExec);

    const tdDeadline = document.createElement("td");
    const deadlineInput = document.createElement("input");
    deadlineInput.type = "date";
    deadlineInput.value = item.deadline || "";
    deadlineInput.onchange = () => saveField(item, "deadline", deadlineInput.value || null);
    tdDeadline.appendChild(deadlineInput);
    tr.appendChild(tdDeadline);

    const tdDelete = document.createElement("td");
    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "checklist-delete-btn";
    deleteBtn.textContent = "×";
    deleteBtn.title = "Elimina riga";
    deleteBtn.onclick = async () => {
      if (item.id === null) {
        draft = null;
        draw();
        return;
      }
      try {
        await deleteChecklistItem(item.id);
        items = items.filter((i) => i.id !== item.id);
        draw();
      } catch (err) {
        alert(err.message);
      }
    };
    tdDelete.appendChild(deleteBtn);
    tr.appendChild(tdDelete);

    return tr;
  }

  function draw() {
    container.innerHTML = "";

    const table = document.createElement("table");
    table.className = "checklist-table";
    const rows = draft ? [...sortItems(items), draft] : sortItems(items);
    rows.forEach((item) => table.appendChild(renderRow(item)));
    container.appendChild(table);

    const actions = document.createElement("div");
    actions.className = "checklist-actions";

    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "checklist-add-btn";
    addBtn.textContent = "+ Aggiungi riga";
    addBtn.disabled = !!draft;
    addBtn.onclick = () => {
      draft = createDraftItem();
      draw();
    };
    actions.appendChild(addBtn);

    const convertAllBtn = document.createElement("button");
    convertAllBtn.type = "button";
    convertAllBtn.className = "checklist-convert-all-btn";
    convertAllBtn.textContent = "Trasforma checklist in foglie";
    convertAllBtn.disabled = items.length === 0;
    convertAllBtn.onclick = async () => {
      const ok = await showConfirmDialog(
        "Trasformare <strong>tutta la checklist</strong> in nodi figli? Questa foglia diventerà un ramo."
      );
      if (!ok) return;
      try {
        await convertAllChecklistItems(taskId);
        await load();
        if (onConverted) onConverted();
      } catch (err) {
        alert(err.message);
      }
    };
    actions.appendChild(convertAllBtn);

    container.appendChild(actions);
  }

  load();
}
