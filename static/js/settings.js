// Impostazioni globali (per ora solo il tema): un'unica preferenza per-browser, salvata in
// localStorage — non è un dato dell'account (niente sul server), coerente col fatto che è
// una preferenza del dispositivo/browser, non della persona che potrebbe usarne altri.
// L'applicazione VERA del tema (data-theme su <html>) avviene già, il prima possibile,
// nello script inline in <head> di index.html (per evitare un lampo col tema sbagliato
// prima che questo modulo — caricato in fondo al body — venga eseguito): qui si aggiungono
// solo l'apertura/chiusura del pannello e il cambio a caldo quando l'utente sceglie un tema.
const THEME_KEY = "leaf-theme";

const overlay = document.getElementById("settings-overlay");
const closeBtn = document.getElementById("settings-close");
const themeRadios = document.querySelectorAll('input[name="theme"]');

function currentTheme() {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    if (stored === "light" || stored === "dark") return stored;
  } catch (e) {
    /* localStorage non disponibile: resta il tema automatico */
  }
  return "auto";
}

function applyTheme(theme) {
  if (theme === "light" || theme === "dark") {
    document.documentElement.dataset.theme = theme;
  } else {
    delete document.documentElement.dataset.theme;
  }
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch (e) {
    /* preferenza non salvata in questa sessione, ma resta applicata finché la pagina è aperta */
  }
}

function openSettings() {
  const theme = currentTheme();
  themeRadios.forEach((radio) => {
    radio.checked = radio.value === theme;
  });
  overlay.classList.remove("hidden");
}

function closeSettings() {
  overlay.classList.add("hidden");
}

export function initSettings() {
  document.getElementById("settings-btn").addEventListener("click", openSettings);
  closeBtn.addEventListener("click", closeSettings);

  // stesso accorgimento del modale: chiude solo se mousedown e click sono entrambi partiti
  // dallo sfondo, altrimenti selezionare del testo trascinando fuori dal box lo chiuderebbe
  let mouseDownOnBackdrop = false;
  overlay.addEventListener("mousedown", (e) => {
    mouseDownOnBackdrop = e.target === overlay;
  });
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay && mouseDownOnBackdrop) closeSettings();
  });

  themeRadios.forEach((radio) => {
    radio.addEventListener("change", () => {
      if (radio.checked) applyTheme(radio.value);
    });
  });
}
