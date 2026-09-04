async function handle(resp) {
  if (!resp.ok) {
    let message = `Errore HTTP ${resp.status}`;
    try {
      const data = await resp.json();
      if (data && data.error) message = data.error;
    } catch (e) {
      /* risposta senza corpo JSON */
    }
    throw new Error(message);
  }
  if (resp.status === 204) return null;
  const text = await resp.text();
  return text ? JSON.parse(text) : null;
}

function postJson(url, method, body) {
  return fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).then(handle);
}

export function fetchTasks() {
  return fetch("/tasks").then(handle);
}

export function createTask(payload) {
  return postJson("/tasks", "POST", payload);
}

export function updateTask(id, payload) {
  return postJson(`/tasks/${id}`, "PUT", payload);
}

export function setFocus(id, focus) {
  return postJson(`/tasks/${id}/focus`, "PATCH", { focus });
}

export function moveTask(id, parentId) {
  return postJson(`/tasks/${id}/parent`, "PATCH", { parent_id: parentId });
}

export function deleteTask(id) {
  return fetch(`/tasks/${id}`, { method: "DELETE" }).then(handle);
}

export function fetchAncestors(id) {
  return fetch(`/tasks/${id}/ancestors`).then(handle);
}

export function fetchNotes(taskId) {
  return fetch(`/notes/${taskId}`).then(handle);
}

export function addNote(taskId, text) {
  return postJson(`/notes/${taskId}`, "POST", { text });
}

export function updateNote(noteId, text) {
  return postJson(`/notes/${noteId}`, "PUT", { text });
}

export function fetchNotesSubtree(taskId) {
  return fetch(`/tasks/${taskId}/notes-subtree`).then(handle);
}
