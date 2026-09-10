import { createTask, updateTask, setFocus, recomputeRollup } from "./api.js";
import { STATUS_META, CLOSED_STATUSES, isLeaf, buildTree } from "./utils.js";
import { state, reload } from "./state.js";
import { renderChecklist } from "./checklist.js";

const overlay = document.getElementById("modal-overlay");
const form = document.getElementById("node-form");
const titleEl = document.getElementById("modal-title");
const fieldTitle = document.getElementById("field-title");
const fieldDescription = document.getElementById("field-description");
const fieldDeadline = document.getElementById("field-deadline");
const fieldDeadlineLabel = document.getElementById("field-deadline-label");
const fieldExecutionDate = document.getElementById("field-execution-date");
const fieldDatesEditableRow = document.getElementById("field-dates-editable-row");
const fieldDatesComputedWrapper = document.getElementById("field-dates-computed-wrapper");
const fieldDatesComputed = document.getElementById("field-dates-computed");
const fieldLabelWrapper = document.getElementById("field-label-wrapper");
const fieldLabel = document.getElementById("field-label");
const fieldStatusOpenWrapper = document.getElementById("field-status-open-wrapper");
const fieldStatusComputed = document.getElementById("field-status-computed");
const fieldStatusClosedWrapper = document.getElementById("field-status-closed-wrapper");
const fieldStatus = document.getElementById("field-status");
const fieldAssegnato = document.getElementById("field-assegnato");
const dependenciesSummary = document.getElementById("dependencies-summary");
const dependenciesPickerBtn = document.getElementById("dependencies-picker-btn");
const fieldFocusWrapper = document.getElementById("field-focus-wrapper");
const fieldFocus = document.getElementById("field-focus");
const cancelBtn = document.getElementById("modal-cancel");
const modalSubmit = document.getElementById("modal-submit");
const checklistWrapper = document.getElementById("checklist-wrapper");
const checklistContainer = document.getElementById("checklist-container");

const pickerOverlay = document.getElementById("dependency-picker-overlay");
const pickerTreeEl = document.getElementById("dependency-picker-tree");
const pickerConfirmBtn = document.getElementById("dependency-picker-confirm");
const pickerCancelBtn = document.getElementById("dependency-picker-cancel");

let mode = "create";
let editingId = null;
let creatingParentId = null;
let afterSaveCallback = () => {};
let selectedDependencyIds = new Set();
let editingIsLeaf = true; // un nodo nuovo è sempre una foglia

function populateStatusOptions() {
  fieldStatus.innerHTML = "";
  [...CLOSED_STATUSES].sort((a, b) => a - b).forEach((status) => {
    const opt = document.createElement("option");
    opt.value = status;
    opt.textContent = `${STATUS_META[status].symbol} ${STATUS_META[status].label}`;
    fieldStatus.appendChild(opt);
  });
}
populateStatusOptions();

function getDescendantIds(nodeId) {
  const ids = [];
  const stack = [nodeId];
  while (stack.length) {
    const current = stack.pop();
    state.tasks.forEach((t) => {
      if (t.parent_id === current) {
        ids.push(t.id);
        stack.push(t.id);
      }
    });
  }
  return ids;
}

function updateDependenciesSummary() {
  if (selectedDependencyIds.size === 0) {
    dependenciesSummary.textContent = "Nessuna";
    return;
  }
  const titles = [...selectedDependencyIds].map((id) => {
    const t = state.tasks.find((x) => x.id === id);
    return t ? t.title : `#${id}`;
  });
  dependenciesSummary.textContent = titles.join(", ");
}

// ---------------------------------------------------------------------------
// Validazione / visibilità campi per LABEL=APERTO (regole 1-5)
// ---------------------------------------------------------------------------

function applyOpenTaskRules() {
  const dl = fieldDeadline.value;
  const ex = fieldExecutionDate.value;

  let invalid = false;
  if (ex && !dl) invalid = true;
  if (ex && dl && dl < ex) invalid = true;

  fieldDeadlineLabel.classList.toggle("field-warning", invalid);
  modalSubmit.disabled = invalid;

  const canAssign = !!(ex && dl);
  fieldAssegnato.disabled = !canAssign;
  if (!canAssign) fieldAssegnato.value = "";
}

fieldDeadline.addEventListener("change", () => {
  if (fieldDeadline.value && !fieldExecutionDate.value) {
    fieldExecutionDate.value = new Date().toISOString().slice(0, 10);
  }
  applyOpenTaskRules();
});
fieldExecutionDate.addEventListener("change", applyOpenTaskRules);

fieldAssegnato.addEventListener("input", applyOpenTaskRules);

// il focus ha effetto immediato (come dal menu contestuale dell'albero), non è
// parte del payload salvato con "Salva": un solo task alla volta può averlo
fieldFocus.addEventListener("change", async () => {
  if (editingId === null) return;
  const desired = fieldFocus.checked;
  try {
    await setFocus(editingId, desired);
    await reload();
  } catch (err) {
    fieldFocus.checked = !desired;
    alert(err.message);
  }
});

function updateLabelVisibility(node) {
  const label = fieldLabel.value;
  const openMode = label === "APERTO";

  fieldStatusOpenWrapper.style.display = openMode ? "block" : "none";
  fieldStatusClosedWrapper.style.display = openMode ? "none" : "block";

  if (openMode && node && node.status) {
    const meta = STATUS_META[node.status];
    fieldStatusComputed.textContent = `${meta.symbol} ${meta.label}`;
  } else if (openMode) {
    fieldStatusComputed.textContent = "(calcolato al salvataggio)";
  }

  if (!openMode) {
    modalSubmit.disabled = false;
    fieldDeadlineLabel.classList.remove("field-warning");
  } else {
    applyOpenTaskRules();
  }
}
fieldLabel.addEventListener("change", () => updateLabelVisibility(null));

// ---------------------------------------------------------------------------
// Selettore dipendenze (ad albero, foglie e rami selezionabili, espandibile/collassabile)
// ---------------------------------------------------------------------------

function getAncestorIds(nodeId) {
  const ids = [];
  let current = state.tasks.find((t) => t.id === nodeId);
  while (current && current.parent_id !== null) {
    ids.push(current.parent_id);
    current = state.tasks.find((t) => t.id === current.parent_id);
  }
  return ids;
}

function collectAllBranchIds(nodes, ids = new Set()) {
  nodes.forEach((n) => {
    if (n.children.length > 0) {
      ids.add(n.id);
      collectAllBranchIds(n.children, ids);
    }
  });
  return ids;
}

let currentPickerExcludedIds = new Set();
let pickerExpandedIds = new Set();

function renderPickerNode(node, excludedIds, container) {
  const li = document.createElement("li");
  const row = document.createElement("div");
  row.className = "picker-row";

  const hasChildren = node.children.length > 0;
  if (hasChildren) {
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "picker-toggle-btn";
    const expanded = pickerExpandedIds.has(node.id);
    toggle.textContent = expanded ? "▼" : "▶";
    toggle.onclick = () => {
      if (pickerExpandedIds.has(node.id)) pickerExpandedIds.delete(node.id);
      else pickerExpandedIds.add(node.id);
      renderPickerTree();
    };
    row.appendChild(toggle);
  } else {
    const spacer = document.createElement("span");
    spacer.className = "picker-toggle-spacer";
    row.appendChild(spacer);
  }

  const label = document.createElement("label");
  if (hasChildren) label.classList.add("picker-branch-label");
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.disabled = excludedIds.has(node.id);
  checkbox.checked = selectedDependencyIds.has(node.id);
  checkbox.onchange = () => {
    if (checkbox.checked) selectedDependencyIds.add(node.id);
    else selectedDependencyIds.delete(node.id);
  };
  label.appendChild(checkbox);
  label.appendChild(document.createTextNode(" " + node.title));
  row.appendChild(label);

  li.appendChild(row);

  if (hasChildren && pickerExpandedIds.has(node.id)) {
    const ul = document.createElement("ul");
    node.children.forEach((c) => renderPickerNode(c, excludedIds, ul));
    li.appendChild(ul);
  }
  container.appendChild(li);
}

function renderPickerTree() {
  pickerTreeEl.innerHTML = "";
  const ul = document.createElement("ul");
  ul.className = "picker-tree-root";
  buildTree(state.tasks).forEach((n) => renderPickerNode(n, currentPickerExcludedIds, ul));
  pickerTreeEl.appendChild(ul);
}

function openDependencyPicker() {
  currentPickerExcludedIds = new Set(
    editingId === null ? [] : [editingId, ...getDescendantIds(editingId), ...getAncestorIds(editingId)]
  );
  // tutto espanso di default (stessa visibilità di prima), collassabile a piacere
  pickerExpandedIds = collectAllBranchIds(buildTree(state.tasks));

  renderPickerTree();
  pickerOverlay.classList.remove("hidden");
}

dependenciesPickerBtn.addEventListener("click", openDependencyPicker);
pickerConfirmBtn.addEventListener("click", () => {
  pickerOverlay.classList.add("hidden");
  updateDependenciesSummary();
  applyOpenTaskRules();
});
pickerCancelBtn.addEventListener("click", () => {
  pickerOverlay.classList.add("hidden");
});

// ---------------------------------------------------------------------------
// Apertura / chiusura / submit
// ---------------------------------------------------------------------------

export function initModal(onSaved) {
  afterSaveCallback = onSaved;

  cancelBtn.addEventListener("click", closeModal);
  // chiude solo se sia il mousedown che il click sono partiti sullo sfondo:
  // altrimenti selezionare del testo trascinando il mouse fuori dal box
  // (es. dalla descrizione) chiuderebbe la finestra a metà modifica
  let mouseDownOnBackdrop = false;
  overlay.addEventListener("mousedown", (e) => {
    mouseDownOnBackdrop = e.target === overlay;
  });
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay && mouseDownOnBackdrop) closeModal();
  });
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    submitForm();
  });
}

export function openCreateModal(parentId) {
  mode = "create";
  creatingParentId = parentId;
  editingId = null;
  editingIsLeaf = true; // un nodo nuovo è sempre una foglia
  selectedDependencyIds = new Set();

  titleEl.textContent = parentId === null ? "Nuovo progetto" : "Nuova sotto-attività";
  form.reset();
  fieldLabelWrapper.style.display = "block";
  fieldLabel.value = "APERTO";
  fieldLabel.disabled = false;
  updateDependenciesSummary();
  updateLabelVisibility(null);
  fieldDatesEditableRow.style.display = "flex";
  fieldDatesComputedWrapper.style.display = "none";
  checklistWrapper.classList.add("hidden"); // serve un nodo già esistente
  fieldFocusWrapper.classList.add("hidden"); // idem: il focus si attiva solo su un nodo esistente

  overlay.classList.remove("hidden");
  fieldTitle.focus();
}

// campi la cui visibilità/valore dipendono dal tipo di nodo (foglia o ramo): vanno
// ri-applicati non solo all'apertura ma anche se il tipo cambia a modale già aperto
// (es. trasformando una voce della checklist, la foglia diventa ramo)
function applyNodeTypeFields(node) {
  const leaf = isLeaf(node);
  editingIsLeaf = leaf;
  fieldAssegnato.value = node.assegnato || "";
  fieldLabelWrapper.style.display = leaf ? "block" : "none";
  fieldLabel.disabled = !leaf;
  fieldLabel.value = leaf ? node.label || "APERTO" : "APERTO";
  fieldStatus.value = leaf && node.label === "CHIUSO" ? node.status || "" : "";
  updateLabelVisibility(node);

  // le date di un ramo sono il rollup automatico dei figli: non modificabili a mano
  fieldDatesEditableRow.style.display = leaf ? "flex" : "none";
  fieldDatesComputedWrapper.style.display = leaf ? "none" : "flex";
  if (!leaf) {
    fieldDatesComputed.textContent =
      node.execution_date && node.deadline ? `${node.execution_date} → ${node.deadline}` : "—";
  }

  // il focus è consentito solo su una foglia APERTA, come nel menu contestuale dell'albero
  fieldFocus.checked = !!node.focus;
  fieldFocus.disabled = !leaf || node.label === "CHIUSO";
}

// la checklist esiste solo sulle foglie: se una trasformazione in-modale fa
// diventare il nodo un ramo, la sezione va nascosta senza dover richiudere il modale
function updateChecklistVisibility(node) {
  if (isLeaf(node)) {
    checklistWrapper.classList.remove("hidden");
    renderChecklist(checklistContainer, node.id, async () => {
      await afterSaveCallback();
      const fresh = state.tasks.find((t) => t.id === node.id);
      if (fresh) {
        applyNodeTypeFields(fresh);
        updateChecklistVisibility(fresh);
      }
    });
  } else {
    checklistWrapper.classList.add("hidden");
    checklistContainer.innerHTML = "";
  }
}

export async function openEditModal(node) {
  mode = "edit";
  editingId = node.id;

  // per un ramo, ricalcola dal basso il rollup di tutto il sottoalbero prima di mostrare
  // "Date (calcolate automaticamente dai figli)": auto-guarigione contro eventuali derive,
  // non solo l'aggiornamento incrementale già garantito a ogni singola modifica. Per una
  // foglia non serve (le sue date sono sue, non un rollup) e si evita il giro di rete
  let fresh = node;
  if (node.children_count > 0) {
    try {
      await recomputeRollup(node.id);
      await reload();
      fresh = state.tasks.find((t) => t.id === node.id) || node;
    } catch (err) {
      alert(err.message);
    }
  }

  selectedDependencyIds = new Set(fresh.dependency_ids || []);

  titleEl.textContent = "Configura nodo";
  fieldTitle.value = fresh.title || "";
  fieldDescription.value = fresh.description || "";
  fieldDeadline.value = fresh.deadline || "";
  fieldExecutionDate.value = fresh.execution_date || "";
  updateDependenciesSummary();
  fieldFocusWrapper.classList.remove("hidden");

  applyNodeTypeFields(fresh);
  updateChecklistVisibility(fresh);

  overlay.classList.remove("hidden");
  fieldTitle.focus();
}

function closeModal() {
  overlay.classList.add("hidden");
  form.reset();
}

async function submitForm() {
  const payload = {
    title: fieldTitle.value.trim(),
    description: fieldDescription.value.trim() || null,
  };

  // le date di un ramo sono calcolate automaticamente dai figli: non fanno parte del
  // payload (il backend le rifiuterebbe comunque se un nodo con figli provasse a impostarle)
  if (editingIsLeaf) {
    payload.deadline = fieldDeadline.value || null;
    payload.execution_date = fieldExecutionDate.value || null;
  }

  if (fieldLabelWrapper.style.display === "block") {
    payload.label = fieldLabel.value;
    if (fieldLabel.value === "APERTO") {
      payload.assegnato = fieldAssegnato.value.trim() || null;
      payload.dependency_ids = [...selectedDependencyIds];
    } else {
      // chiudendo un task manteniamo assegnato/dipendenze così com'erano
      // (tornano operativi se il task viene riaperto in seguito)
      payload.status = fieldStatus.value ? Number(fieldStatus.value) : null;
    }
  }

  try {
    if (mode === "create") {
      payload.parent_id = creatingParentId;
      await createTask(payload);
    } else {
      await updateTask(editingId, payload);
    }
    closeModal();
    afterSaveCallback();
  } catch (err) {
    alert(err.message);
  }
}
