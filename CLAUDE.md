# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Leaf is a personal task-tree manager: tasks form a tree (project → sub-tasks → ...), only leaf nodes (no children) are "workable" and carry a `status`, and each node can have dated notes. Single-user, local Flask + vanilla JS app, no build step, no test suite.

## Commands

- Run the dev server: `python app.py` (Flask debug/reloader, http://127.0.0.1:5000)
- (Re)initialize the database: `python init_db.py` — **destructive**: drops and recreates `tasks` and `notes` from scratch. Never run this against a database with real data without confirming with the user first.
- No linter, formatter, package manager, or test suite is configured. The only dependency is Flask, installed directly in the system Python (no `requirements.txt`/`venv`).

## Architecture

**Backend** (`app.py`, single file, no ORM): plain Flask routes, raw SQL via the helpers in `database/db.py` (`query_db`, `query_one`, `execute_db`, `execute_transaction`). `config.py` is the single source of truth for the SQLite file path (`DB_PATH`), overridable with the `LEAF_DB_PATH` env var (e.g. to move the `.db` file to a synced cloud folder) — both `app.py`'s DB layer and `init_db.py` import it from there.

**Frontend** (`static/js/`): no framework, no bundler — native ES modules loaded via `<script type="module">` in `templates/index.html`. Key modules:
- `state.js` — single mutable `state` object plus `onRender`/`rerender`/`reload` (reload refetches `/tasks` then rerenders).
- `api.js` — thin fetch wrappers, all HTTP calls to the Flask backend live here.
- `utils.js` — pure helpers shared by every view: tree building from the flat task list, sorting, `STATUS_META` (symbol/color/**display label** per status), badge DOM builders.
- `render_tree.js` — the ALBERO view (hierarchical tree: expand/collapse, per-branch expand-all, focus toggle, note button, vertical hierarchy guide lines).
- `render_notes.js` — the notes side panel (compose box + one editable box per day), rendered inside the Albero view. There is no separate "Note" view/tab.
- `render_leaves.js` — the FOGLIE view: a flat, sortable, filterable table of leaf nodes only, with fixed percentage-based column widths (`table-layout: fixed`, no text wrapping — see gotchas).
- `modal.js` — the single create/edit modal shared by every view.
- `main.js` — wires up the toolbar and dispatches rendering based on `state.currentView` (only `"albero"` and `"foglie"` exist; a Nodi view and a standalone Note view existed earlier and were removed/merged).

## Domain rules (enforced in `app.py`, must stay consistent with the frontend)

- Only leaves (`children_count == 0`) may have `status` or `focus` set; branch nodes cannot.
- `status` is the literal value stored in the DB and used everywhere in backend logic (`ALLOWED_STATUSES`, `BLOCKING_STATUSES`, `FOCUS_INCOMPATIBLE_STATUSES`) — there is no separate internal-key/display-label split in the backend. The frontend's `STATUS_META[status].label` is purely a display override; renaming what the user sees only requires editing that one field in `utils.js`.
- Creating a child under a leaf clears that leaf's `status` and `focus` (it becomes a branch node).
- A leaf can only gain a child if its status is not in `BLOCKING_STATUSES` (`BLOCCATO`, `DELEGATO`, `COMPLETATO`, `INTERROTTO`).
- Only one task in the whole DB can have `focus = 1` at a time — enforced both by a partial unique index (`idx_tasks_focus_unique`) and by application logic that clears the old focus before setting a new one.
- Setting a status in `FOCUS_INCOMPATIBLE_STATUSES` clears `focus` if it was set.
- `reminder`/`expired` are never stored — always computed on read via `REMINDER_EXPIRED_SQL` (see gotcha below).
- Notes are stored one row per `(task_id, note_date)`: adding a note on a day that already has one appends to it (`INSERT ... ON CONFLICT DO UPDATE`) rather than creating a new row.

## Gotchas

- **Never make `reminder`/`expired` SQLite `GENERATED` columns.** SQLite rejects non-deterministic functions like `date('now')` in generated-column expressions at write time (`sqlite3.OperationalError: non-deterministic use of date()`) — this was tried and reverted. They must be computed per-query, as done in `REMINDER_EXPIRED_SQL`.
- **`ALTER TABLE ... RENAME TO`** causes SQLite to silently rewrite foreign-key references in *other* tables' stored schema to point at the new name. A migration that rebuilds `tasks` (rename → create → copy → drop) without also rebuilding `notes` leaves `notes.task_id` referencing a table that no longer exists, silently breaking every insert. Any future schema migration touching a table that others reference by FK must rebuild all of them together.
- The FOGLIE table relies on `table-layout: fixed` with percentage `<col>` widths (see `render_leaves.js`/`style.css`) so columns stay identical regardless of the active project filter and cells never wrap (`white-space: nowrap` + ellipsis). Don't reintroduce content-based column sizing there.
