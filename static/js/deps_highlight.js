import { state, rerender } from "./state.js";

// accende (senza toggle) l'evidenziazione in giallo delle dipendenze di `node`: usata sia
// dal toggle sotto sia da chi deve garantire che risulti accesa (es. il badge "dipendenza
// su un ramo" in FOGLIE, prima di saltare nell'albero a mostrarla)
export function setDependencyHighlight(node) {
  state.highlightedDepsSourceId = node.id;
  state.highlightedDepsIds = new Set(node.dependency_ids || []);
}

// evidenzia in giallo i nodi dipendenza del task il cui bottone "Dipendenze" è stato
// premuto; un secondo click sullo stesso bottone toglie l'evidenziazione, un click su
// un bottone diverso la sposta sulle sue dipendenze. Persiste tra viste e filtri perché
// vive in `state`, non nel DOM.
export function toggleDependencyHighlight(node) {
  if (state.highlightedDepsSourceId === node.id) {
    state.highlightedDepsSourceId = null;
    state.highlightedDepsIds = new Set();
  } else {
    setDependencyHighlight(node);
  }
  rerender();
}
