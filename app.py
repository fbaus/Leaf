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


if __name__ == "__main__":
    app.run(debug=True)
