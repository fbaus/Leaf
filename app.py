from flask import Flask, jsonify, request, render_template
from database import query_db, execute_db

app = Flask(__name__)


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/tasks", methods=["GET"])
def get_tasks():
    tasks = query_db(
        "SELECT id, parent_id, title FROM tasks ORDER BY id"
    )
    return jsonify(tasks)


@app.route("/tasks", methods=["POST"])
def create_task():
    data = request.get_json()

    title = data.get("title")
    parent_id = data.get("parent_id")

    if not title:
        return {"error": "Titolo mancante"}, 400

    execute_db(
        "INSERT INTO tasks (title, parent_id) VALUES (?, ?)",
        (title, parent_id)
    )

    return "", 201



# Recursive deletion of a task and its subtasks

@app.route("/tasks/<int:task_id>", methods=["DELETE"])
def delete_task(task_id):
    delete_task_recursive(task_id)
    return {"status": "ok"}

def delete_task_recursive(task_id):
    # trova figli
    children = query_db(
        "SELECT id FROM tasks WHERE parent_id = ?",
        [task_id]
    )

    # cancella ricorsivamente i figli
    for c in children:
        delete_task_recursive(c["id"])

    # cancella il nodo
    execute_db(
        "DELETE FROM tasks WHERE id = ?",
        [task_id]
    )


if __name__ == "__main__":
    app.run(debug=True)


