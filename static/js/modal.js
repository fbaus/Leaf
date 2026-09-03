import { createTask, updateTask, acknowledgeEscalation } from "./api.js";
import { STATUS_META, CLOSED_STATUSES, isLeaf, buildTree } from "./utils.js";
import { state } from "./state.js";

const overlay = document.getElementById("modal-overlay");
const form = document.getElementById("node-form");
const titleEl = document.getElementById("modal-title");
const fieldTitle = document.getElementById("field-title");
const fieldDescription = document.getElementById("field-description");
const fieldDeadline = document.getElementById("field-deadline");
const fieldDeadlineLabel = document.getElementById("field-deadline-label");
const fieldExecutionDate = document.getElementById("field-execution-date");
const fieldLabelWrapper = document.getElementById("field-label-wrapper");
const fieldLabel = document.getElementById("field-label");
const fieldStatusOpenWrapper = document.getElementById("field-status-open-wrapper");
const fieldStatusComputed = document.getElementById("field-status-computed");
const fieldStatusClosedWrapper = document.getElementById("field-status-closed-wrapper");
const fieldStatus = document.getElementById("field-status");
const fieldAssegnato = document.getElementById("field-assegnato");
const dependenciesSummary = document.getElementById("dependencies-summary");
const dependenciesPickerBtn = document.getElementById("dependencies-picker-btn");
const fieldUrgent = document.getElementById("field-urgent");
const cancelBtn = document.getElementById("modal-cancel");
const modalSubmit = document.getElementById("modal-submit");

const pickerOverlay = document.getElementById("dependency-picker-overlay");
const pickerTreeEl = document.getElementById("dependency-picker-tree");
const pickerConfirmBtn = document.getElementById("dependency-picker-confirm");
const pickerCancelBtn = document.getElementById("dependency-picker-cancel");

let mode = "create";
let editingId = null;
let creatingParentId = null;
let afterSaveCallback = () => {};
let selectedDependencyIds = new Set();

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
  if (ex && dl && dl <= ex) invalid = true;

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

// assegnato e dipendenze sono mutualmente esclusivi: impostare l'uno svuota l'altro
fieldAssegnato.addEventListener("input", () => {
  if (fieldAssegnato.value.trim() !== "" && selectedDependencyIds.size > 0) {
    selectedDependencyIds.clear();
    updateDependenciesSummary();
  }
  applyOpenTaskRules();
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
// Selettore dipendenze (ad albero, solo foglie selezionabili)
// ---------------------------------------------------------------------------

function renderPickerNode(node, excludedIds, container) {
  const li = document.createElement("li");

  if (isLeaf(node)) {
    const label = document.createElement("label");
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
    li.appendChild(label);
  } else {
    const span = document.createElement("span");
    span.className = "picker-branch";
    span.textContent = node.title;
    li.appendChild(span);
  }

  if (node.children.length > 0) {
    const ul = document.createElement("ul");
    node.children.forEach((c) => renderPickerNode(c, excludedIds, ul));
    li.appendChild(ul);
  }
  container.appendChild(li);
}

function openDependencyPicker() {
  const excludedIds = new Set(editingId === null ? [] : [editingId, ...getDescendantIds(editingId)]);

  pickerTreeEl.innerHTML = "";
  const ul = document.createElement("ul");
  ul.className = "picker-tree-root";
  buildTree(state.tasks).forEach((n) => renderPickerNode(n, excludedIds, ul));
  pickerTreeEl.appendChild(ul);

  pickerOverlay.classList.remove("hidden");
}

dependenciesPickerBtn.addEventListener("click", openDependencyPicker);
pickerConfirmBtn.addEventListener("click", () => {
  pickerOverlay.classList.add("hidden");
  if (selectedDependencyIds.size > 0) fieldAssegnato.value = "";
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
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeModal();
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
  selectedDependencyIds = new Set();

  titleEl.textContent = parentId === null ? "Nuovo progetto" : "Nuova sotto-attività";
  form.reset();
  fieldLabelWrapper.style.display = "block";
  fieldLabel.value = "APERTO";
  fieldLabel.disabled = false;
  updateDependenciesSummary();
  updateLabelVisibility(null);

  overlay.classList.remove("hidden");
  fieldTitle.focus();
}

export function openEditModal(node) {
  mode = "edit";
  editingId = node.id;
  selectedDependencyIds = new Set(node.dependency_ids || []);

  titleEl.textContent = "Configura nodo";
  fieldTitle.value = node.title || "";
  fieldDescription.value = node.description || "";
  fieldDeadline.value = node.deadline || "";
  fieldExecutionDate.value = node.execution_date || "";
  fieldAssegnato.value = node.assegnato || "";
  fieldUrgent.checked = !!node.urgent;
  updateDependenciesSummary();

  const leaf = isLeaf(node);
  fieldLabelWrapper.style.display = leaf ? "block" : "none";
  fieldLabel.disabled = !leaf;
  fieldLabel.value = leaf ? node.label || "APERTO" : "APERTO";
  fieldStatus.value = leaf && node.label === "CHIUSO" ? node.status || "" : "";

  updateLabelVisibility(node);

  overlay.classList.remove("hidden");
  fieldTitle.focus();

  if (leaf && node.escalation) {
    acknowledgeEscalation(node.id).catch(() => {});
  }
}

function closeModal() {
  overlay.classList.add("hidden");
  form.reset();
}

async function submitForm() {
  const payload = {
    title: fieldTitle.value.trim(),
    description: fieldDescription.value.trim() || null,
    deadline: fieldDeadline.value || null,
    execution_date: fieldExecutionDate.value || null,
    urgent: fieldUrgent.checked,
  };

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
