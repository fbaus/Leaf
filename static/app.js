console.log("APP.JS CARICATO");


/*********************************
 * CONFIG
 *********************************/
const API_TASKS_URL = "/tasks";

/*********************************
 * API CALLS
 *********************************/
function fetchTasks() {
  return fetch(API_TASKS_URL)
    .then(r => r.json());
}

function createTask(title, parentId = null) {
  return fetch(API_TASKS_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: title,
      parent_id: parentId
    })
  });
}

/*********************************
 * TREE LOGIC
 *********************************/
function buildTree(tasks) {
  const map = {};
  const roots = [];

  tasks.forEach(t => {
    map[t.id] = { ...t, children: [] };
  });

  tasks.forEach(t => {
    if (t.parent_id !== null) {
      map[t.parent_id].children.push(map[t.id]);
    } else {
      roots.push(map[t.id]);
    }
  });

  return roots;
}

/*********************************
 * RENDERING
 *********************************/
function renderNode(node) {
  const li = document.createElement("li");

  // riga del nodo
  const row = document.createElement("div");
  row.style.display = "inline-flex";
  row.style.alignItems = "center";

  let childrenUl = null;

  // toggle o spacer
  if (node.children.length > 0) {
    const toggle = document.createElement("button");
    toggle.textContent = "▶";
    toggle.style.marginRight = "4px";

    childrenUl = document.createElement("ul");
    childrenUl.style.display = "none";

    toggle.onclick = () => {
      const isHidden = childrenUl.style.display === "none";
      childrenUl.style.display = isHidden ? "block" : "none";
      toggle.textContent = isHidden ? "▼" : "▶";
    };

    row.appendChild(toggle);
  } else {
    const spacer = document.createElement("span");
    spacer.style.display = "inline-block";
    spacer.style.width = "24px";
    row.appendChild(spacer);
  }

  // titolo
  const title = document.createElement("span");
  title.textContent = node.title;
  row.appendChild(title);

  // bottone +
  const addBtn = document.createElement("button");
  addBtn.textContent = "+";
  addBtn.onclick = () => addSubtask(node.id);
  row.appendChild(addBtn);


  // delete button
  const delBtn = document.createElement("button");
  delBtn.textContent = "🗑";
  delBtn.onclick = () => {
    const ok = confirm("Eliminare questo task e tutte le sotto-attività?");
    if (!ok) return;

    fetch(`/tasks/${node.id}`, { method: "DELETE" })
      .then(loadTasks);
  };
  row.appendChild(delBtn);



  // 👉 prima la riga
  li.appendChild(row);

  // 👉 poi i figli
  if (childrenUl) {
    node.children.forEach(c => childrenUl.appendChild(renderNode(c)));
    li.appendChild(childrenUl);
  }

  return li;
}


/*********************************
 * UI ACTIONS
 *********************************/
function addRootTask() {
  const title = prompt("Titolo task:");
  if (!title) return;

  createTask(title)
    .then(loadTasks);
}

function addSubtask(parentId) {
  const title = prompt("Titolo sotto-attività:");
  if (!title) return;

  createTask(title, parentId)
    .then(loadTasks);
}

/*********************************
 * LOAD
 *********************************/
function loadTasks() {
  fetchTasks().then(tasks => {
    const tree = buildTree(tasks);
    const container = document.getElementById("task-tree");
    container.innerHTML = "";

    const ul = document.createElement("ul");
    tree.forEach(n => ul.appendChild(renderNode(n)));
    container.appendChild(ul);
  });
}

document.addEventListener("DOMContentLoaded", () => {
  document
    .getElementById("add-root-task")
    .onclick = addRootTask;

  loadTasks();
});
