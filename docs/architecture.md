# Paperwork architecture

Paperwork edits existing PDFs locally. The PDF bytes remain the document's
source of truth; there is no authored-document source format or agent runtime.
Manual editing remains available without a model provider.

## Module map

| File | Responsibility |
| --- | --- |
| `server.py` | Loopback HTTP server, PDF inspection, edit dispatch, document sessions and history |
| `styling.py` | Font selection, rich paragraph layout, typography and solid backgrounds |
| `objects.py` | PDF painting inspection, selected-object transforms, styles and preview isolation |
| `saving.py` | Native Save as dialog in a separate process and atomic writes to the chosen file |
| `basic_actions.py` | Literal text search/replacement, secure image-based redaction, signature and date placement |
| `signatures.py` | Generation, validation, atomic persistence, and removal of one local reusable signature |
| `static/basic-tools.js` | Basic action controls, revision-bound search previews, and click/area placement |
| `static/app.js` | Manual text editing, tools, HTTP requests, page rendering and refresh lifecycle |
| `static/objects.js` | Object selection, dragging, resizing, snapping and controls; shares app.js state |
| `static/index.html`, `static/style.css` | Editor markup and visual presentation |
| `verify.py` | Shared local/CI verification entry point |
| `tests/pdf_fixtures.py`, `tests/test_pdf.py` | Synthetic PDF fixtures, PDF/rendering regressions and HTTP workflows |
| `tests/refresh.test.cjs` | Existing refresh and pending-edit/drag regressions |
| `tests/controls.test.cjs` | Image placement, text-handle geometry and font-control regressions |

## Editing path

1. The frontend uploads PDF bytes to `/api/open` and receives document/page metadata.
2. Inspection exposes text blocks, spans and selectable PDF painting objects.
3. A manual edit posts its document ID, current revision, page and action to
   `/api/edit`. `server.edit_pdf(data, request)` dispatches the PDF mutation and
   returns new PDF bytes plus a warning, if applicable.
4. The HTTP layer rejects stale revisions before mutation. A successful edit
   stores the previous bytes for undo, clears redo and increments the revision.
5. The frontend refreshes metadata and renders the result. Its tile renderer
   preserves the visible bitmap while loading and repaints changed tiles.
6. Save PDF commits the draft, then `/api/save` opens a local native dialog. It snapshots the requested
   revision, releases the document lock while the dialog is open, and serializes
   native dialogs. Cancellation and saving do not change history or revisions.
   Files are written only to the user-chosen destination, with replacement after a
   complete write. `/api/download` remains available as a byte export endpoint.
   `/api/undo` and `/api/redo` restore
   stored byte snapshots using the same revision protection.

Document sessions and history live in process memory. Server restarts discard
them. Refresh can reconnect to an existing session, but is not durable saving.
History retains up to 20 undo snapshots within a 200 MB undo-history cap.

Basic actions use the same `/api/edit` path and history as manual editing.
`/api/find` checks the revision but does not mutate it. Search previews are
discarded after document/revision changes and when moving away from a page-scoped
search or area selection. Search supports literal text within one extracted line;
automatic entity detection and OCR are deferred. Secure redaction builds a fresh
PDF from rendered page pixels, clearing the selected pixels before embedding
them. No original PDF resources or hidden structures are copied. This deliberately
makes all existing pages image-based at up to 144 DPI, with a 4,096-pixel long-edge
cap and a 120-million-pixel budget per operation. Undo retains the pre-redaction
snapshot in memory. Date placement rejects text overlaps; signatures remain
ordinary editable image occurrences. See [basic-actions.md](basic-actions.md).

Reusable signature storage is the sole new persistent app data. The authenticated
`/api/signature` endpoint manages one local PNG independently of document sessions.
It accepts PNG/JPEG uploads or a typed name, strips uploaded image metadata, and
writes atomically. `PAPERWORK_DATA_DIR` overrides the normal user-local directory.
No external service or agent runtime is required. Request logging is disabled
because render URLs include session tokens.

Text IDs are extraction indexes, not permanent identifiers. Object IDs can refer
to painting positions or editor-tagged forms. Always use current metadata and
revision rather than retaining selections across unrelated edits.

The visual text editor sends `auto_layout: true` for flexible paragraph edits.
It expands the text frame with font changes, keeps the requested type size,
adjusts the selected paragraph near page edges, and permits overlaps without
moving neighboring content. Rich-text callers without that flag retain strict
page/overlap validation. Geometric text removal preserves intersecting unselected
glyphs before replacing the selected paragraph. Layout beyond one page does not
create pagination; the user controls the final arrangement with the text handles.

## Verification and scope

`python verify.py` checks pinned dependencies, Python and JavaScript syntax,
PDF/HTTP regressions, and the existing Node.js refresh suite. It does not launch
or modify an existing editor session. HTTP tests start an isolated server on an
ephemeral loopback port and close their document sessions afterward.

PDF fixtures use built-in fonts and generated graphics, including an image
shared across pages. Rendering assertions compare changed and protected regions
within one run; they do not use platform-specific screenshot baselines. They
cover a representative subset, not every PDF encoding, font, or clipping case.
Frontend changes still require browser inspection.

CI runs the same verification on Windows and Linux with Python 3.11 and 3.12,
and Node.js 22. No extra test packages or frontend build tools are required.
