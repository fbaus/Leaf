// Overlay di login — stesso pattern di modal.js (riferimenti DOM presi una volta al
// caricamento del modulo, un init...(callback) esportato e richiamato da main.js).

import { login, logout } from "./api.js";

const overlay = document.getElementById("login-overlay");
const form = document.getElementById("login-form");
const fieldUsername = document.getElementById("login-username");
const fieldPassword = document.getElementById("login-password");
const errorEl = document.getElementById("login-error");
const logoutBtn = document.getElementById("logout-btn");

export function showLoginOverlay() {
  overlay.classList.remove("hidden");
  fieldUsername.focus();
}

export function hideLoginOverlay() {
  overlay.classList.add("hidden");
  errorEl.classList.add("hidden");
  form.reset();
}

export function initLogin(onLoginSuccess) {
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    errorEl.classList.add("hidden");
    try {
      const user = await login(fieldUsername.value, fieldPassword.value);
      hideLoginOverlay();
      await onLoginSuccess(user);
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.classList.remove("hidden");
    }
  });

  logoutBtn.addEventListener("click", async () => {
    try {
      await logout();
    } finally {
      // reload completo invece di resettare a mano tutto lo state: più robusto,
      // e riparte esattamente dal punto in cui main.js mostra di nuovo il login
      window.location.reload();
    }
  });
}
