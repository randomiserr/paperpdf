# Working on Paperwork

## Setup and verification

- This checkout contains the existing manual PDF editor. Read README.md and
  docs/architecture.md before changing it; preserve existing user changes.
- Runtime: Python 3.11+, with pinned dependencies in requirements.txt.
  Node.js 22+ is needed for verification only, not for running the editor.
- Windows setup/start: `start.bat`. For explicit setup: `python -m venv .venv`,
  then `.venv\Scripts\python.exe -m pip install -r requirements.txt`.
- Run `python verify.py` before delivering changes. It prefers the local .venv
  when invoked with a system Python. CI runs the same command.
- Launch separately with `.venv\Scripts\python.exe server.py`; the default
  address is http://127.0.0.1:8765. An optional argument selects another port.

## Editing invariants

- Preserve manual editing. Do not introduce a frontend framework or agent
  runtime just to make the repository agent-ready.
- PDF mutation belongs behind `server.edit_pdf(data, request)` and the existing
  objects/styling functions, not in transport or frontend code.
- The HTTP layer owns document revisions and undo/redo. Failed or stale edits
  must not change PDF bytes, the revision, or history.
- Text block/span IDs are local to the current extraction and revision; do not
  assume they persist after editing or reopening. Re-read metadata when needed.
- Preserve unselected content, shared image occurrences, clipping, and page
  geometry. Imported PDFs do not promise document-wide text reflow.
- Keep local-only binding, Host checks, and session-token checks intact. Do not
  log tokens, document contents, or credentials.
- Do not add private PDFs to Git. Regression fixtures are generated in memory
  with built-in fonts; use that approach for portable tests.

## Delivery

- Add regression coverage for changed editing behavior. Check PDF content and
  rendering, including untouched regions and pages.
- For frontend behavior changes, also inspect the running manual editor.
- Update setup/architecture documentation when commands or responsibilities
  change. Keep additional abstractions tied to a concrete need.
- Review the diff and report checks actually run and any limitations.
- Leave changes uncommitted unless the user requests a commit, push, or release.
