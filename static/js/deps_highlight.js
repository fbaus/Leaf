import { state, rerender } from "./state.js";

// accende (senza toggle) l'evidenziazione in giallo delle dipendenze di `node`: usata sia
// dal toggle sotto sia da chi deve garantire che risulti accesa (es. il badge "dipendenza
// su un ramo" in FOGLIE, prima di saltare nell'albero a mostrarla). `ids`, se passato,
// sovrascrive l'insieme da evidenziare (es. in FOGLIE le foglie aperte espanse
// ricorsivamente da un ramo dipendenza); di default sono gli id grezzi di dependency_ids
// (comportamento storico, usato nell'Albero/Gantt dove anche i rami sono righe visibili)
export function setDependencyHighlight(node, ids) {
  state.highlightedDepsSourceId = node.id;
  state.highlightedDepsIds = new Set(ids || node.dependency_ids || []);
}

// evidenzia in giallo i nodi dipendenza del task il cui bottone "Dipendenze" è stato
// premuto; un secondo click sullo stesso bottone toglie l'evidenziazione, un click su
// un bottone diverso la sposta sulle sue dipendenze. Persiste tra viste e filtri perché
// vive in `state`, non nel DOM.
export function toggleDependencyHighlight(node, ids) {
  if (state.highlightedDepsSourceId === node.id) {
    state.highlightedDepsSourceId = null;
    state.highlightedDepsIds = new Set();
  } else {
    setDependencyHighlight(node, ids);
  }
  rerender();
}
