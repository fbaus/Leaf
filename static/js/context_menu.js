// menu contestuale generico (tasto destro), condiviso fra vista ALBERO e FOGLIE

let closeOpenMenu = null;

function closeContextMenu() {
  if (closeOpenMenu) {
    closeOpenMenu();
    closeOpenMenu = null;
  }
}

export function showContextMenu(x, y, items) {
  closeContextMenu();

  const menu = document.createElement("div");
  menu.className = "context-menu";

  items.forEach((item) => {
    const btn = document.createElement("button");
    btn.textContent = item.label;
    btn.disabled = !!item.disabled;
    btn.onclick = () => {
      closeContextMenu();
      item.onClick();
    };
    menu.appendChild(btn);
  });

  document.body.appendChild(menu);

  // posiziona dopo l'inserimento per poter correggere se sfora la finestra
  const rect = menu.getBoundingClientRect();
  const left = Math.min(x, window.innerWidth - rect.width - 4);
  const top = Math.min(y, window.innerHeight - rect.height - 4);
  menu.style.left = `${Math.max(4, left)}px`;
  menu.style.top = `${Math.max(4, top)}px`;

  const onDocClick = (e) => {
    if (!menu.contains(e.target)) closeContextMenu();
  };
  const onKeyDown = (e) => {
    if (e.key === "Escape") closeContextMenu();
  };
  // registrato al giro successivo: evita che il click destro che ha aperto
  // il menu lo richiuda subito tramite lo stesso evento
  setTimeout(() => {
    document.addEventListener("click", onDocClick);
    document.addEventListener("contextmenu", onDocClick);
    document.addEventListener("keydown", onKeyDown);
  }, 0);

  closeOpenMenu = () => {
    menu.remove();
    document.removeEventListener("click", onDocClick);
    document.removeEventListener("contextmenu", onDocClick);
    document.removeEventListener("keydown", onKeyDown);
  };
}
