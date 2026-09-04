// preserva focus/cursore di un input attraverso un rerender che ricostruisce il DOM da zero
// (altrimenti digitare in un campo che triggera rerender ad ogni tasto perderebbe il focus)

export function captureFocus(root) {
  const active = document.activeElement;
  if (active && active.dataset && active.dataset.preserveFocusKey && root.contains(active)) {
    return { key: active.dataset.preserveFocusKey, selStart: active.selectionStart, selEnd: active.selectionEnd };
  }
  return null;
}

export function restoreFocus(root, captured) {
  if (!captured) return;
  const el = root.querySelector(`[data-preserve-focus-key="${captured.key}"]`);
  if (!el) return;
  el.focus();
  if (typeof el.setSelectionRange === "function" && captured.selStart != null) {
    el.setSelectionRange(captured.selStart, captured.selEnd);
  }
}
