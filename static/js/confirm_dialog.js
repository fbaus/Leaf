// dialog di conferma generico (a differenza di confirm() nativo supporta HTML,
// es. per mostrare il nome di un nodo in grassetto), condiviso fra più viste

export function showConfirmDialog(messageHtml) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "confirm-overlay";

    const box = document.createElement("div");
    box.className = "confirm-box";

    const msg = document.createElement("div");
    msg.innerHTML = messageHtml;
    box.appendChild(msg);

    const actions = document.createElement("div");
    actions.className = "confirm-actions";

    const settle = (result) => {
      overlay.remove();
      resolve(result);
    };

    const okBtn = document.createElement("button");
    okBtn.textContent = "OK";
    okBtn.onclick = () => settle(true);
    const cancelBtn = document.createElement("button");
    cancelBtn.textContent = "Annulla";
    cancelBtn.onclick = () => settle(false);
    actions.appendChild(cancelBtn);
    actions.appendChild(okBtn);
    box.appendChild(actions);

    let mouseDownOnBackdrop = false;
    overlay.addEventListener("mousedown", (e) => {
      mouseDownOnBackdrop = e.target === overlay;
    });
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay && mouseDownOnBackdrop) settle(false);
    });

    overlay.appendChild(box);
    document.body.appendChild(overlay);
  });
}
