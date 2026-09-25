import { state, reload, rerender } from "./state.js";
import {
  isTicketOfMine,
  STATUS_META,
  makeBadge,
  escapeHtml,
  delegationCellText,
  formatEstimatedDays,
} from "./utils.js";
import { deleteTask } from "./api.js";
import { openEditModal } from "./modal.js";
import { renderNotesSidePanel } from "./render_notes.js";
import { showContextMenu } from "./context_menu.js";
import { showConfirmDialog } from "./confirm_dialog.js";

// stesso doppio-conferma di render_tree.js (nessuna eliminazione, di ticket o altro, con un
// solo click)
async function confirmDeletion(node) {
  const name = `<strong>${escapeHtml(node.title)}</strong>`;
  const first = await showConfirmDialog(`Eliminare la banana ${name}?`);
  if (!first) return false;
  return showConfirmDialog(`Confermi in modo definitivo l'eliminazione di ${name}?`);
}

// stessa condizione di render_leaves.js/render_tree.js: il badge segnala solo le due fasi
// di attesa-decisione (accettazione, conferma completamento), non "questo è un ticket"
function ticketBadge(node, isOwner) {
  if (node.executor_user_id == null) return null;
  if (node.delegation_status !== "in_attesa" && !node.completion_pending) return null;
  const tooltip = node.completion_pending
    ? (isOwner ? "Completamento in attesa di conferma del committente" : "Completamento da confermare")
    : (isOwner ? `Delegato da: ${node.committente_username} (in attesa)` : `Delegato a: ${node.executor_username} (in attesa)`);
  return makeBadge("🤝", tooltip, null, "delegation-badge");
}

function renderTable(mainPanel, tickets) {
  // .leaves-table (riusata da FOGLIE) fissa l'header con `top: var(--filter-bar-height,
  // 38px)`: qui non c'è nessuna barra filtri sopra la tabella, quindi senza azzerare questa
  // variabile l'header si "incollerebbe" 38px più in basso della sua posizione naturale fin
  // dal primo render, coprendo la prima riga sotto di sé
  mainPanel.style.setProperty("--filter-bar-height", "0px");

  const table = document.createElement("table");
  table.className = "leaves-table";

  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  ["Titolo", "Stato", "Esecutore", "Data esecuzione", "Deadline", "Tempo stimato", "Codice progetto"].forEach((label) => {
    const th = document.createElement("th");
    th.textContent = label;
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  tickets.forEach((node) => {
    const isOwner = node.owner_id === state.currentUser?.id;
    const tr = document.createElement("tr");
    tr.dataset.taskId = node.id;
    tr.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      const items = [{ label: "Configurazione", onClick: () => openEditModal(node) }];
      // stessa regola di delete_task in app.py: eliminabile dal committente solo finché non è
      // (più) delegato E non è mai stato chiuso (un ticket completato resta nel log); un
      // superuser può sempre eliminare
      const canDelete = state.currentUser?.is_superuser
        || (isOwner && node.executor_user_id == null && node.label !== "CHIUSO");
      if (canDelete) {
        items.push({
          label: "Elimina",
          onClick: async () => {
            const ok = await confirmDeletion(node);
            if (!ok) return;
            try {
              await deleteTask(node.id);
              await reload();
            } catch (err) {
              alert(err.message);
            }
          },
        });
      }
      showContextMenu(e.clientX, e.clientY, items);
    });

    const tdTitle = document.createElement("td");
    tdTitle.className = "leaf-title-cell";
    const titleRow = document.createElement("div");
    titleRow.className = "leaf-title-row";
    const titleText = document.createElement("span");
    titleText.className = "leaf-title-text";
    if (state.selectedNoteNodeId === node.id) titleText.classList.add("selected-node");
    titleText.textContent = node.title;
    titleText.title = "Clic: leggi/scrivi le note di questa banana";
    // niente jumpToTree qui: un ticket non ha antenati visibili al committente, non c'è
    // un posto nell'Albero dove "saltare" — si apre invece il pannello note di questa vista
    titleText.onclick = () => {
      state.selectedNoteNodeId = node.id;
      rerender();
    };
    titleRow.appendChild(titleText);

    const badge = ticketBadge(node, isOwner);
    if (badge) titleRow.appendChild(badge);
    tdTitle.appendChild(titleRow);
    tr.appendChild(tdTitle);

    const tdStatus = document.createElement("td");
    if (node.status) {
      const meta = STATUS_META[node.status];
      tdStatus.textContent = `${meta.symbol} ${meta.label}`;
      tdStatus.style.color = meta.color;
    } else {
      tdStatus.textContent = "—";
    }
    tr.appendChild(tdStatus);

    const tdExecutor = document.createElement("td");
    tdExecutor.textContent = delegationCellText(node, state.currentUser?.id) || "—";
    tr.appendChild(tdExecutor);

    const tdExecutionDate = document.createElement("td");
    tdExecutionDate.textContent = node.execution_date || "—";
    tr.appendChild(tdExecutionDate);

    const tdDeadline = document.createElement("td");
    tdDeadline.textContent = node.deadline || "—";
    tr.appendChild(tdDeadline);

    const tdEstimated = document.createElement("td");
    tdEstimated.textContent = formatEstimatedDays(node.estimated_days);
    tr.appendChild(tdEstimated);

    const tdProjectCode = document.createElement("td");
    tdProjectCode.textContent = node.ticket_project_code || "—";
    tr.appendChild(tdProjectCode);

    tbody.appendChild(tr);
  });
  table.appendChild(tbody);

  if (tickets.length === 0) {
    const empty = document.createElement("p");
    empty.className = "note-history-empty";
    empty.textContent = "Nessuna banana lanciata.";
    mainPanel.appendChild(empty);
    return;
  }
  mainPanel.appendChild(table);
}

export function renderTicket(mainPanel, sidePanel, sideFocus) {
  const tickets = state.tasks
    .filter((t) => isTicketOfMine(t, state.currentUser?.id))
    .sort((a, b) => b.id - a.id);

  renderTable(mainPanel, tickets);
  renderNotesSidePanel(sidePanel, sideFocus);
}
