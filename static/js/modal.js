import { createTask, updateTask } from "./api.js";
import { STATUS_META, isLeaf } from "./utils.js";

const overlay = document.getElementById("modal-overlay");
const form = document.getElementById("node-form");
const titleEl = document.getElementById("modal-title");
const fieldTitle = document.getElementById("field-title");
const fieldDescription = document.getElementById("field-description");
const fieldDeadline = document.getElementById("field-deadline");
const fieldExecutionDate = document.getElementById("field-execution-date");
const fieldStatus = document.getElementById("field-status");
const fieldStatusWrapper = document.getElementById("field-status-wrapper");
const fieldUrgent = document.getElementById("field-urgent");
const cancelBtn = document.getElementById("modal-cancel");

let mode = "create";
let editingId = null;
let creatingParentId = null;
let afterSaveCallback = () => {};

function populateStatusOptions() {
  fieldStatus.innerHTML = '<option value="">(nessuno)</option>';
  Object.keys(STATUS_META).forEach((status) => {
    const opt = document.createElement("option");
    opt.value = status;
    opt.textContent = `${STATUS_META[status].symbol} ${STATUS_META[status].label}`;
    fieldStatus.appendChild(opt);
  });
}
populateStatusOptions();

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

  titleEl.textContent = parentId === null ? "Nuovo progetto" : "Nuova sotto-attività";
  form.reset();
  fieldStatusWrapper.style.display = "block";
  fieldStatus.disabled = false;

  overlay.classList.remove("hidden");
  fieldTitle.focus();
}

export function openEditModal(node) {
  mode = "edit";
  editingId = node.id;

  titleEl.textContent = "Configura nodo";
  fieldTitle.value = node.title || "";
  fieldDescription.value = node.description || "";
  fieldDeadline.value = node.deadline || "";
  fieldExecutionDate.value = node.execution_date || "";
  fieldUrgent.checked = !!node.urgent;

  const leaf = isLeaf(node);
  fieldStatusWrapper.style.display = leaf ? "block" : "none";
  fieldStatus.disabled = !leaf;
  fieldStatus.value = leaf ? node.status || "" : "";

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
    deadline: fieldDeadline.value || null,
    execution_date: fieldExecutionDate.value || null,
    urgent: fieldUrgent.checked,
  };

  if (!fieldStatus.disabled) {
    payload.status = fieldStatus.value || null;
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
