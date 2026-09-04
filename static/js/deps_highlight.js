import { state, rerender } from "./state.js";

// evidenzia in giallo i nodi dipendenza del task il cui bottone "Dipendenze" è stato
// premuto; un secondo click sullo stesso bottone toglie l'evidenziazione, un click su
// un bottone diverso la sposta sulle sue dipendenze. Persiste tra viste e filtri perché
// vive in `state`, non nel DOM.
export function toggleDependencyHighlight(node) {
  if (state.highlightedDepsSourceId === node.id) {
    state.highlightedDepsSourceId = null;
    state.highlightedDepsIds = new Set();
  } else {
    state.highlightedDepsSourceId = node.id;
    state.highlightedDepsIds = new Set(node.dependency_ids || []);
  }
  rerender();
}
