import { state, rerender } from "./state.js";
import { fetchAncestors } from "./api.js";

// apre la vista ALBERO (se non già attiva), espande gli antenati del nodo e lo evidenzia
export async function jumpToTree(nodeId) {
  const ancestorIds = await fetchAncestors(nodeId);
  ancestorIds.forEach((id) => state.expandedIds.add(id));
  state.currentView = "albero";
  state.scrollToNodeId = nodeId;
  rerender();
}
