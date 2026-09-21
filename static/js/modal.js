import {
  createTask, updateTask, setFocus, recomputeRollup,
  fetchUsers, delegateTask, acceptDelegation, declineDelegation, ackDelegationNotice, ackEscalation,
} from "./api.js";
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
const fieldEstimatedEditableRow = document.getElementById("field-estimated-editable-row");
const fieldEstimatedComputedWrapper = document.getElementById("field-estimated-computed-wrapper");
const fieldEstimatedComputed = document.getElementById("field-estimated-computed");
const fieldEstimatedDaysPart = document.getElementById("field-estimated-days-part");
const fieldEstimatedHoursPart = document.getElementById("field-estimated-hours-part");
const fieldCaricoLavoro = document.getElementById("field-carico-lavoro");
const fieldCaricoLavoroBranch = document.getElementById("field-carico-lavoro-branch");
// 1 giornata lavorativa = 8 ore: solo una convenzione per convertire il campo "ore" (più
// comodo per stime brevi) nel valore in giorni che il backend salva e usa per il carico di
// lavoro — non c'entra con CAPACITA_PRODUTTIVA_MEDIA (quella è quanto di una giornata è
// davvero disponibile in media, questa è solo l'unità di misura dell'input)
const ORE_PER_GIORNO = 8;
const fieldProjectCodeRow = document.getElementById("field-project-code-row");
const fieldProjectCodeEditableWrapper = document.getElementById("field-project-code-editable-wrapper");
const fieldProjectCodeReadonlyWrapper = document.getElementById("field-project-code-readonly-wrapper");
const fieldProjectCodeReadonly = document.getElementById("field-project-code-readonly");
const fieldProjectCodeNumber = document.getElementById("field-project-code-number");
const fieldProjectCodeYear = document.getElementById("field-project-code-year");
const fieldLabelWrapper = document.getElementById("field-label-wrapper");
const fieldLabel = document.getElementById("field-label");
const fieldStatusOpenWrapper = document.getElementById("field-status-open-wrapper");
const fieldStatusComputed = document.getElementById("field-status-computed");
const fieldStatusClosedWrapper = document.getElementById("field-status-closed-wrapper");
const fieldStatus = document.getElementById("field-status");
const fieldAssegnato = document.getElementById("field-assegnato");
const fieldAssegnazioneEditableWrapper = document.getElementById("field-assegnazione-editable-wrapper");
const fieldAssegnazioneInternaControls = document.getElementById("field-assegnazione-interna-controls");
const fieldAssegnatoInterna = document.getElementById("field-assegnato-interna");
const delegaBtn = document.getElementById("delega-btn");
const fieldAssegnazioneExecutorWrapper = document.getElementById("field-assegnazione-executor-wrapper");
const fieldAssegnazioneExecutorInfo = document.getElementById("field-assegnazione-executor-info");
const fieldAssegnazioneExecutorActions = document.getElementById("field-assegnazione-executor-actions");
const acceptDelegationBtn = document.getElementById("accept-delegation-btn");
const declineDelegationBtn = document.getElementById("decline-delegation-btn");
const fieldAssegnazioneCommittenteWrapper = document.getElementById("field-assegnazione-committente-wrapper");
const fieldAssegnazioneCommittenteInfo = document.getElementById("field-assegnazione-committente-info");
const dependenciesSummary = document.getElementById("dependencies-summary");
const dependenciesPickerBtn = document.getElementById("dependencies-picker-btn");
const fieldFocusWrapper = document.getElementById("field-focus-wrapper");
const fieldFocus = document.getElementById("field-focus");
const nodeFieldset = document.getElementById("node-fieldset");
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

// scompone un estimated_days (unico valore, quello salvato/usato dal backend per il carico
// di lavoro) nei due campi "giorni"/"ore" del form — solo per la UI, arrotonda alla mezz'ora
// più vicina per evitare differenze illeggibili dovute ai decimali
function splitEstimatedDays(value) {
  if (value == null) return { days: 0, hours: 0 };
  const totalHours = Math.round(value * ORE_PER_GIORNO * 2) / 2;
  const days = Math.floor(totalHours / ORE_PER_GIORNO);
  const hours = Math.round((totalHours - days * ORE_PER_GIORNO) * 10) / 10;
  return { days, hours };
}

// inverso di splitEstimatedDays: dai due campi del form al valore unico che il backend si
// aspetta — null se entrambi vuoti/zero (nessuna stima), come il vecchio campo singolo
function combineEstimatedDays(daysValue, hoursValue) {
  const days = daysValue ? Number(daysValue) : 0;
  const hours = hoursValue ? Number(hoursValue) : 0;
  if (!days && !hours) return null;
  return days + hours / ORE_PER_GIORNO;
}

function formatEstimatedDays(value) {
  if (value == null) return "—";
  const { days, hours } = splitEstimatedDays(value);
  const parts = [];
  if (days) parts.push(`${days}g`);
  if (hours) parts.push(`${hours}h`);
  return parts.length ? parts.join(" ") : "0g";
}

// stesso formato di fmtPercent in render_workload.js (carico_lavoro è già arrotondato lato
// server): "—" solo in creazione, quando il nodo non esiste ancora e non c'è nulla da
// calcolare finché non viene salvato
function formatCaricoLavoro(value) {
  return value == null ? "—" : `${value}%`;
}

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
  dependenciesSummary.innerHTML = "";
  if (selectedDependencyIds.size === 0) {
    dependenciesSummary.textContent = "Nessuna";
    return;
  }
  // una riga per dipendenza (non un elenco separato da virgole): il riquadro cresce verso
  // il basso e oltre la sua altezza massima scorre, invece di troncare con l'ellissi
  [...selectedDependencyIds].forEach((id) => {
    const t = state.tasks.find((x) => x.id === id);
    const line = document.createElement("div");
    line.textContent = t ? t.title : `#${id}`;
    dependenciesSummary.appendChild(line);
  });
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
  fieldAssegnatoInterna.disabled = !canAssign;
  // il bottone Delega resta inattivo finché non è indicato un esecutore, interno o esterno
  const hasExecutor = !!fieldAssegnatoInterna.value || !!fieldAssegnato.value.trim();
  delegaBtn.disabled = !canAssign || !hasExecutor;
}

fieldDeadline.addEventListener("change", () => {
  if (fieldDeadline.value && !fieldExecutionDate.value) {
    fieldExecutionDate.value = new Date().toISOString().slice(0, 10);
  }
  applyOpenTaskRules();
});
fieldExecutionDate.addEventListener("change", applyOpenTaskRules);

fieldAssegnato.addEventListener("input", applyOpenTaskRules);
fieldAssegnatoInterna.addEventListener("change", applyOpenTaskRules);

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

  // un ramo non ha mai uno status proprio (solo le foglie ce l'hanno, vedi isLeaf/label nel
  // backend): nessuno dei due riquadri Status ha senso per lui — senza questo, un ramo
  // mostrava comunque "Status (calcolato automaticamente)" con "(calcolato al salvataggio)",
  // fuorviante perché per un ramo non verrà mai calcolato nulla
  if (!editingIsLeaf) {
    fieldStatusOpenWrapper.classList.add("hidden");
    fieldStatusClosedWrapper.classList.add("hidden");
    modalSubmit.disabled = false;
    fieldDeadlineLabel.classList.remove("field-warning");
    return;
  }

  fieldStatusOpenWrapper.classList.toggle("hidden", !openMode);
  fieldStatusClosedWrapper.classList.toggle("hidden", openMode);

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
// Assegnazione: Interna (utente registrato) / Esterna (nome libero), a 3 stati —
// editabile (owner, non delegato), sola lettura per l'esecutore (delegato interno,
// con eventuali Accetta/Rifiuta), sola lettura per il committente
// ---------------------------------------------------------------------------

async function populateInternaSelect() {
  try {
    const users = await fetchUsers();
    const current = fieldAssegnatoInterna.value;
    fieldAssegnatoInterna.innerHTML = '<option value="">—</option>';
    users.forEach((u) => {
      const opt = document.createElement("option");
      opt.value = u.username;
      opt.textContent = u.username;
      fieldAssegnatoInterna.appendChild(opt);
    });
    fieldAssegnatoInterna.value = current;
  } catch (err) {
    // silenzioso: se la lista utenti non arriva resta solo l'opzione vuota,
    // non deve bloccare l'apertura del resto del modale
  }
}

function applyAssegnazioneCreateMode() {
  fieldAssegnazioneEditableWrapper.classList.remove("hidden");
  fieldAssegnazioneInternaControls.classList.add("hidden");
  delegaBtn.classList.add("hidden");
  fieldAssegnazioneExecutorWrapper.classList.add("hidden");
  fieldAssegnazioneCommittenteWrapper.classList.add("hidden");
}

// nodo esistente: 3 stati mutuamente esclusivi in base a chi guarda e se è già delegato
// internamente (la delega esterna, che non tocca owner_id, resta nel ramo "editabile")
function applyAssegnazioneSection(node, isOwner) {
  fieldAssegnazioneEditableWrapper.classList.add("hidden");
  fieldAssegnazioneExecutorWrapper.classList.add("hidden");
  fieldAssegnazioneCommittenteWrapper.classList.add("hidden");

  const delegatedInternally = node.executor_user_id != null;
  // per il committente il nodo resta "quella foglia delegata" anche se l'esecutore l'ha
  // trasformato in un ramo (i figli reali, di un altro owner, non gli sono comunque mai
  // visibili — vedi isLeafForViewer): solo per lui la sezione resta valida anche su un ramo
  if (!isLeaf(node) && !(!isOwner && delegatedInternally)) return; // ramo vero, mai delegato
  const stato = node.delegation_status === "accettata" ? "accettata" : "in attesa";

  if (!isOwner) {
    fieldAssegnazioneCommittenteWrapper.classList.remove("hidden");
    fieldAssegnazioneCommittenteInfo.textContent = delegatedInternally
      ? `Delegato a: ${node.executor_username} (${stato})`
      : "—";
    return;
  }

  if (delegatedInternally) {
    fieldAssegnazioneExecutorWrapper.classList.remove("hidden");
    fieldAssegnazioneExecutorInfo.textContent = `Delegato da: ${node.committente_username} (${stato})`;
    // in attesa: Accetta + Rifiuta. Già accettata: solo un bottone per restituire il task,
    // rietichettato — stessa azione di backend (decline-delegation), significato diverso
    const pending = node.delegation_status !== "accettata";
    fieldAssegnazioneExecutorActions.classList.remove("hidden");
    acceptDelegationBtn.classList.toggle("hidden", !pending);
    declineDelegationBtn.textContent = pending ? "Rifiuta" : "Interrompi delega";
  } else {
    fieldAssegnazioneEditableWrapper.classList.remove("hidden");
    fieldAssegnazioneInternaControls.classList.remove("hidden");
    delegaBtn.classList.remove("hidden");
    fieldAssegnato.value = node.assegnato || "";
    fieldAssegnatoInterna.value = "";
    populateInternaSelect();
    // i valori dei campi sono appena stati ripopolati: il disabled del bottone Delega
    // (che dipende anche da loro, non solo da EX/DL) va ricalcolato di conseguenza
    applyOpenTaskRules();
  }
}

delegaBtn.addEventListener("click", async () => {
  if (editingId === null) return;
  const executorUsername = fieldAssegnatoInterna.value || null;
  const externalName = fieldAssegnato.value.trim() || null;
  if (executorUsername && externalName) {
    alert("Compila solo uno dei due campi (Interna o Esterna)");
    return;
  }
  try {
    await delegateTask(editingId, { executor_username: executorUsername, external_name: externalName });
    closeModal();
    afterSaveCallback();
  } catch (err) {
    alert(err.message);
  }
});

acceptDelegationBtn.addEventListener("click", async () => {
  if (editingId === null) return;
  try {
    await acceptDelegation(editingId);
    closeModal();
    afterSaveCallback();
  } catch (err) {
    alert(err.message);
  }
});

declineDelegationBtn.addEventListener("click", async () => {
  if (editingId === null) return;
  try {
    await declineDelegation(editingId);
    closeModal();
    afterSaveCallback();
  } catch (err) {
    alert(err.message);
  }
});

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

// nodo stesso + tutti i discendenti che a loro volta hanno figli (stessa logica del
// bottone ⊕/⊖ "espandi/collassa tutti i discendenti" già in vista Albero)
function collectSubtreeBranchIds(node) {
  if (node.children.length === 0) return [];
  const ids = [node.id];
  node.children.forEach((child) => {
    ids.push(...collectSubtreeBranchIds(child));
  });
  return ids;
}

function pickerBranchToggleAllButton(node) {
  const branchIds = collectSubtreeBranchIds(node);
  const allExpanded = branchIds.every((id) => pickerExpandedIds.has(id));

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "branch-toggle-btn";
  btn.textContent = allExpanded ? "⊖" : "⊕";
  btn.title = allExpanded ? "Collassa tutti i discendenti" : "Espandi tutti i discendenti";
  btn.onclick = () => {
    if (allExpanded) branchIds.forEach((id) => pickerExpandedIds.delete(id));
    else branchIds.forEach((id) => pickerExpandedIds.add(id));
    renderPickerTree();
  };
  return btn;
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
    row.appendChild(pickerBranchToggleAllButton(node));
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
  // tutto collassato all'apertura, espandibile a piacere (anche tutto insieme, per
  // ramo, col bottone ⊕/⊖)
  pickerExpandedIds = new Set();

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
  nodeFieldset.disabled = false;
  modalSubmit.classList.remove("hidden");
  applyAssegnazioneCreateMode();
  fieldLabelWrapper.classList.remove("hidden");
  fieldLabel.value = "APERTO";
  fieldLabel.disabled = false;
  updateDependenciesSummary();
  updateLabelVisibility(null);
  fieldDatesEditableRow.classList.remove("hidden");
  fieldDatesComputedWrapper.classList.add("hidden");
  fieldEstimatedEditableRow.classList.remove("hidden");
  fieldEstimatedComputedWrapper.classList.add("hidden");
  // come lo Status appena sotto (updateLabelVisibility): un nodo non ancora salvato non ha
  // ancora un carico di lavoro calcolato, non semplicemente "assente" come "—" implicherebbe
  fieldCaricoLavoro.textContent = "(calcolato al salvataggio)";
  updateProjectCodeVisibility(null, parentId === null);
  checklistWrapper.classList.add("hidden"); // serve un nodo già esistente
  fieldFocusWrapper.classList.add("hidden"); // idem: il focus si attiva solo su un nodo esistente

  overlay.classList.remove("hidden");
  fieldTitle.focus();
}

function parseProjectCode(code) {
  const match = code ? /^(\d{3})-20(\d{2})$/.exec(code) : null;
  return { number: match ? match[1] : "", year: match ? match[2] : "" };
}

// il codice progetto esiste solo sui nodi radice (parent_id nullo): per chiunque altro la
// riga resta nascosta. Su una radice, solo gli utenti autorizzati (state.currentUser.
// can_set_project_code, arrivato da /login o /me) vedono i due campi editabili — gli altri
// vedono il valore in sola lettura, stesso trattamento "computed-status" già usato per
// date/tempo stimato di un ramo
function updateProjectCodeVisibility(node, isRoot) {
  fieldProjectCodeRow.classList.toggle("hidden", !isRoot);
  if (!isRoot) {
    // senza questo, la visibilità lasciata da un nodo radice aperto in precedenza resta
    // scritta sull'elemento (solo il contenitore .form-row viene nascosto): submitForm
    // controlla proprio questa classe per decidere se includere project_code nel payload,
    // e lo farebbe anche per un task non radice, causando il 409 "solo su un progetto radice"
    fieldProjectCodeEditableWrapper.classList.add("hidden");
    fieldProjectCodeReadonlyWrapper.classList.add("hidden");
    return;
  }

  const authorized = !!(state.currentUser && state.currentUser.can_set_project_code);
  fieldProjectCodeEditableWrapper.classList.toggle("hidden", !authorized);
  fieldProjectCodeReadonlyWrapper.classList.toggle("hidden", authorized);

  const code = node ? node.project_code || null : null;
  if (authorized) {
    const { number, year } = parseProjectCode(code);
    fieldProjectCodeNumber.value = number;
    fieldProjectCodeYear.value = year;
  } else {
    fieldProjectCodeReadonly.textContent = code || "—";
  }
}

// campi la cui visibilità/valore dipendono dal tipo di nodo (foglia o ramo): vanno
// ri-applicati non solo all'apertura ma anche se il tipo cambia a modale già aperto
// (es. trasformando una voce della checklist, la foglia diventa ramo)
function applyNodeTypeFields(node) {
  const leaf = isLeaf(node);
  editingIsLeaf = leaf;
  fieldLabelWrapper.classList.toggle("hidden", !leaf);
  fieldLabel.disabled = !leaf;
  fieldLabel.value = leaf ? node.label || "APERTO" : "APERTO";
  fieldStatus.value = leaf && node.label === "CHIUSO" ? node.status || "" : "";
  updateLabelVisibility(node);

  // le date di un ramo sono il rollup automatico dei figli: non modificabili a mano
  fieldDatesEditableRow.classList.toggle("hidden", !leaf);
  fieldDatesComputedWrapper.classList.toggle("hidden", leaf);
  if (!leaf) {
    fieldDatesComputed.textContent =
      node.execution_date && node.deadline ? `${node.execution_date} → ${node.deadline}` : "—";
  }

  // il tempo stimato di un ramo è la somma (calcolata lato server) delle foglie
  // discendenti attive: mai memorizzato su un ramo, non modificabile a mano
  fieldEstimatedEditableRow.classList.toggle("hidden", !leaf);
  fieldEstimatedComputedWrapper.classList.toggle("hidden", leaf);
  if (leaf) {
    const { days, hours } = splitEstimatedDays(node.estimated_days);
    fieldEstimatedDaysPart.value = days || "";
    fieldEstimatedHoursPart.value = hours || "";
    fieldCaricoLavoro.textContent = formatCaricoLavoro(node.carico_lavoro);
  } else {
    fieldEstimatedComputed.textContent = formatEstimatedDays(node.estimated_days);
    fieldCaricoLavoroBranch.textContent = formatCaricoLavoro(node.carico_lavoro);
  }

  updateProjectCodeVisibility(node, node.parent_id === null);

  // il focus è consentito solo su una foglia APERTA, come nel menu contestuale dell'albero
  fieldFocus.checked = !!node.focus;
  fieldFocus.disabled = !leaf || node.label === "CHIUSO";
}

// la checklist esiste solo sulle foglie: se una trasformazione in-modale fa
// diventare il nodo un ramo, la sezione va nascosta senza dover richiudere il modale
function updateChecklistVisibility(node, isOwner = true) {
  if (isLeaf(node) && isOwner) {
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
  const isOwner = node.owner_id === state.currentUser?.id;

  // per un ramo, ricalcola dal basso il rollup di tutto il sottoalbero prima di mostrare
  // "Date (calcolate automaticamente dai figli)": auto-guarigione contro eventuali derive,
  // non solo l'aggiornamento incrementale già garantito a ogni singola modifica. Per una
  // foglia non serve (le sue date sono sue, non un rollup) e si evita il giro di rete.
  // Solo l'owner può richiamarla (route owner-gated): per il committente in sola lettura
  // si salterebbe comunque con un errore silenzioso, quindi va condizionata qui.
  let fresh = node;
  if (node.children_count > 0 && isOwner) {
    try {
      await recomputeRollup(node.id);
      await reload();
      fresh = state.tasks.find((t) => t.id === node.id) || node;
    } catch (err) {
      alert(err.message);
    }
  }

  // il committente apre la configurazione: è il trigger che spegne la notifica temporanea
  // di cambio deadline/accettazione (non il salvataggio, che per lui non esiste)
  if (!isOwner && fresh.delegation_notice) {
    try {
      await ackDelegationNotice(fresh.id);
      await reload();
      fresh = state.tasks.find((t) => t.id === fresh.id) || fresh;
    } catch (err) {
      // silenzioso: non deve impedire l'apertura in sola lettura
    }
  }

  // stesso principio per l'escalation (badge 📅 + riga gialla): si spegne alla semplice
  // apertura della configurazione, come le altre notifiche temporanee, non serve più salvare
  if (isOwner && fresh.escalation) {
    try {
      await ackEscalation(fresh.id);
      await reload();
      fresh = state.tasks.find((t) => t.id === fresh.id) || fresh;
    } catch (err) {
      // silenzioso: non deve impedire l'apertura del modale
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
  applyAssegnazioneSection(fresh, isOwner);
  updateChecklistVisibility(fresh, isOwner);

  nodeFieldset.disabled = !isOwner;
  modalSubmit.classList.toggle("hidden", !isOwner);

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

  // le date e il tempo stimato di un ramo sono calcolati automaticamente dai figli: non
  // fanno parte del payload (il backend li rifiuterebbe comunque se un nodo con figli
  // provasse a impostarli)
  if (editingIsLeaf) {
    payload.deadline = fieldDeadline.value || null;
    payload.execution_date = fieldExecutionDate.value || null;
    payload.estimated_days = combineEstimatedDays(fieldEstimatedDaysPart.value, fieldEstimatedHoursPart.value);
  }

  // solo su un nodo radice e solo per un utente autorizzato il campo è editabile (vedi
  // updateProjectCodeVisibility) — altrimenti non fa parte del payload, il valore esistente
  // resta invariato
  if (!fieldProjectCodeEditableWrapper.classList.contains("hidden")) {
    const number = fieldProjectCodeNumber.value.trim();
    const year = fieldProjectCodeYear.value.trim();
    payload.project_code = number || year ? `${number}-20${year}` : null;
  }

  if (!fieldLabelWrapper.classList.contains("hidden")) {
    payload.label = fieldLabel.value;
    if (fieldLabel.value === "APERTO") {
      // in modifica, l'assegnazione (interna o esterna) passa dal bottone "Delega"
      // dedicato, non dal Salva generale — qui resta solo per la creazione
      if (mode === "create") {
        payload.assegnato = fieldAssegnato.value.trim() || null;
      }
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
