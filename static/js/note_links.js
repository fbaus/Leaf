import { openNotePath, notePreviewUrl } from "./api.js";

// sintassi esplicita in stile markdown: [testo](percorso) — non è markdown vero, solo i link
const LINK_PATTERN = /\[([^\]]+)\]\(([^)]+)\)/g;

// rilevamento automatico di percorsi locali/di rete e URL incollati come testo semplice
// (senza la sintassi [testo](percorso)): un percorso Windows può contenere spazi, quindi
// il match si ferma al primo ".estensione" plausibile seguito da uno spazio/fine riga/
// punteggiatura — non da un carattere di percorso come "\" (così "v1.2\file.pdf" non si
// spezza a metà). Il terminatore include anche " perché "Copia come percorso" di Windows
// racchiude il percorso fra virgolette: le virgolette restano testo normale attorno al
// link, non ne fanno parte.
const AUTO_LINK_PATTERN =
  /(https?:\/\/[^\s<>"]+)|((?:[A-Za-z]:[\\/]|\\\\)[^\r\n<>"]*?\.[A-Za-z0-9]{1,6})(?=[\s.,;:!?)\]"]|$)/g;

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".svg"]);

function isImagePath(path) {
  const dot = path.lastIndexOf(".");
  if (dot === -1) return false;
  return IMAGE_EXTENSIONS.has(path.slice(dot).toLowerCase());
}

function openImagePreview(path) {
  const overlay = document.createElement("div");
  overlay.className = "confirm-overlay";

  const box = document.createElement("div");
  box.className = "confirm-box image-preview-box";

  const img = document.createElement("img");
  img.src = notePreviewUrl(path);
  img.alt = path;
  box.appendChild(img);

  const actions = document.createElement("div");
  actions.className = "confirm-actions";
  const closeBtn = document.createElement("button");
  closeBtn.textContent = "Chiudi";
  closeBtn.onclick = () => overlay.remove();
  actions.appendChild(closeBtn);
  box.appendChild(actions);

  let mouseDownOnBackdrop = false;
  overlay.addEventListener("mousedown", (e) => {
    mouseDownOnBackdrop = e.target === overlay;
  });
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay && mouseDownOnBackdrop) overlay.remove();
  });

  overlay.appendChild(box);
  document.body.appendChild(overlay);
}

async function openLocalFile(path) {
  try {
    await openNotePath(path);
  } catch (err) {
    alert(err.message);
  }
}

// aggiunge testo semplice a `container`, evidenziando le occorrenze di `needle` (se presente)
// con <mark> — niente innerHTML, quindi zero rischio di escaping/XSS
function appendHighlighted(container, text, needle) {
  if (!needle) {
    container.appendChild(document.createTextNode(text));
    return;
  }
  const lowerText = text.toLowerCase();
  let idx = 0;
  let pos;
  while ((pos = lowerText.indexOf(needle, idx)) !== -1) {
    if (pos > idx) container.appendChild(document.createTextNode(text.slice(idx, pos)));
    const mark = document.createElement("mark");
    mark.className = "note-search-highlight";
    mark.textContent = text.slice(pos, pos + needle.length);
    container.appendChild(mark);
    idx = pos + needle.length;
  }
  if (idx < text.length) container.appendChild(document.createTextNode(text.slice(idx)));
}

function makeLinkSpan(label, target, needle, isUrl) {
  const link = document.createElement("span");
  link.className = "note-link";
  link.title = target;
  appendHighlighted(link, label, needle);
  link.onclick = () => {
    if (isUrl) window.open(target, "_blank");
    else if (isImagePath(target)) openImagePreview(target);
    else openLocalFile(target);
  };
  return link;
}

// aggiunge testo semplice a `container`, riconoscendo al suo interno URL e percorsi
// locali/di rete incollati senza la sintassi [testo](percorso) e trasformandoli in link
function appendWithAutoLinks(container, text, needle) {
  let lastIndex = 0;
  AUTO_LINK_PATTERN.lastIndex = 0;
  let match;
  while ((match = AUTO_LINK_PATTERN.exec(text)) !== null) {
    if (match.index > lastIndex) {
      appendHighlighted(container, text.slice(lastIndex, match.index), needle);
    }
    const [, url, path] = match;
    const target = url || path;
    container.appendChild(makeLinkSpan(target, target, needle, !!url));
    lastIndex = AUTO_LINK_PATTERN.lastIndex;
  }
  if (lastIndex < text.length) {
    appendHighlighted(container, text.slice(lastIndex), needle);
  }
}

// riempie `container` col testo della nota: riconosce sia i link espliciti [testo](percorso)
// sia URL/percorsi incollati come testo semplice, ed evidenzia `highlightTerm` se fornito
// (ricerca note) — niente innerHTML, quindi zero rischio di escaping/XSS
export function renderNoteText(container, text, highlightTerm = "") {
  const needle = highlightTerm.toLowerCase();
  let lastIndex = 0;
  LINK_PATTERN.lastIndex = 0;
  let match;
  while ((match = LINK_PATTERN.exec(text)) !== null) {
    if (match.index > lastIndex) {
      appendWithAutoLinks(container, text.slice(lastIndex, match.index), needle);
    }
    const [, label, path] = match;
    container.appendChild(makeLinkSpan(label, path, needle, /^https?:\/\//i.test(path)));
    lastIndex = LINK_PATTERN.lastIndex;
  }
  if (lastIndex < text.length) {
    appendWithAutoLinks(container, text.slice(lastIndex), needle);
  }
}
