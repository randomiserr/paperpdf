# Basic document actions

These actions are implemented for the manual editor and programmatic callers.
Automatic personal-information detection, OCR, form filling, and automatic
signature/date location detection are deferred.

## Python entry points

`basic_actions.find_text(pdf_bytes, request)` returns `matches`, `count`, and
`unsearchable_pages` without changing the PDF. Page indexes are zero-based.
Rectangles and points use PDF points in the current page's coordinate system.
The HTTP import normalizes rotated pages; use imported metadata for coordinates.

```python
from basic_actions import find_text
from server import edit_pdf

matches = find_text(pdf_bytes, {
    "query": "Alice Example", "scope": "all", "case_sensitive": True,
})
redacted_bytes, notice = edit_pdf(pdf_bytes, {
    "action": "redact", "query": "Alice Example", "scope": "all",
    "case_sensitive": True, "mode": "blackout",
})
```

`server.edit_pdf(pdf_bytes, request)` returns `(updated_bytes, notice)` or raises
an error. Direct calls do not own session revisions/history; HTTP callers do.
Requests with counted actions receive an internal `_result_count` key for the
HTTP result. Mutation completes on an independent document before session bytes
or history are changed.

| Action | Parameters beyond `action` and current `page` |
| --- | --- |
| `replace_text` | `query`, nonempty `replacement`, `scope` (`all` or `page`), optional `case_sensitive` (default true) |
| `redact` by text | `query`, `scope`, optional `case_sensitive`, `mode` (`blackout` or `remove`) |
| `redact` by area | `rect: [left, top, right, bottom]`, `mode` |
| `date` | `point: [x, baseline]`, `date` (`today` or `YYYY-MM-DD`), `format` (`dmy`, `iso`, `dmy_slash`, `mdy_slash`), optional `size`, `font`, `color` |
| `signature` | `rect`; reads the locally saved signature |

Search is literal and confined to one extracted line, even when the line contains
multiple font spans. It supports at most 1,000 nonoverlapping occurrences and a
500-character query. It can find displayed form values. Replacements only edit
ordinary page text, reject rotated matches and empty replacement strings, fit
within the matched width, and reject results requiring text smaller than 4 pt.
For changing form values, use a future form-filling action. Replacing text is
an ordinary edit, not the secure-removal workflow.

Removal and blackout erase the selected pixels of every affected region and
rebuild **all** pages into a fresh PDF containing only rendered page images.
No original text, image files, optional hidden layers, metadata, attachments,
links, comments, field values, or document structures are copied. Visible text
outside the selected regions remains visible as pixels. Existing content loses
text search/editability, form interactivity, and high-zoom vector quality.
Rendering is up to 144 DPI with a 4,096-pixel long-edge cap; operations above
120 million rendered pixels are rejected without changing the session. Remove
uses white pixels; blackout uses black pixels. Exact search cannot recognize
pictured text, text split across lines, or every item of personal information:
use area redaction and inspect every visible occurrence. The source file and
in-memory undo snapshots retain their original content.

Date defaults to the server computer's local calendar day for direct Python/HTTP
calls. The UI sends an explicit date based on the browser's local calendar day;
it never derives today from UTC. Explicit ISO dates make agent calls deterministic.
A date must fit inside the page without overlapping extracted text. A signature
is a placed image, without certificate signing or automatic placement.

## Local signature asset

`signatures.save_signature({"name": "Alice Example"})` generates and saves a
transparent PNG. Windows uses an available local script font; other installations
use an available italic font. Upload instead with `{"image": "BASE64_PNG_OR_JPEG"}`.
Only one saved signature is supported. Uploads are limited to 2 MB and 4 million
pixels and converted to a PNG without original-file metadata. Writes are atomic.
`load_signature()` returns PNG bytes or `None`; `signature_info()` returns
`saved` and, when saved, `image` (base64), `width`, and `height`.
`clear_signature()` deletes the reusable asset without altering placed copies.

Storage is `%LOCALAPPDATA%/Paperwork/signature.png` on Windows; without
`LOCALAPPDATA`, it is `~/.local/share/Paperwork/signature.png`. The optional
`PAPERWORK_DATA_DIR` environment variable sets the directory (not the filename).
Tests isolate this storage in temporary directories and do not read user assets.

## Local HTTP API

The existing loopback, Host, and `X-Editor-Token` protections apply. Requests and
tokens are not logged. Do not put tokens or document contents in logs or tracked
configuration. JSON POSTs should set `Content-Type: application/json`.

- `POST /api/find`: `{id, revision, page, query, scope, case_sensitive}`. Returns
  `{revision, count, matches, unsearchable_pages}`. Matches include zero-based
  `page`, `rect`, displayed `text`, and font/origin details. Inspection does not
  advance the revision or history.
- `POST /api/edit`: `{id, revision, page, ...action_parameters}`. Returns existing
  document metadata plus `warning`, `changed`, and `selection`. A whole-document
  action is one undo step. Missing matches, invalid placement, unsupported values,
  and stale revisions fail before changing bytes, revision, or history.
- `GET /api/signature`: returns `signature_info()` without needing a document ID.
- `POST /api/signature`: `{name}`, `{image}`, or `{clear: true}`. Returns signature
  info. Does not change document sessions or history.

For example, add a date to an open document:

```json
{
  "id": "CURRENT_DOCUMENT_ID",
  "revision": 4,
  "page": 0,
  "action": "date",
  "point": [72, 650],
  "date": "2026-10-13",
  "format": "dmy"
}
```

The current revision must come from session metadata. Re-inspect after edits;
search rectangles and extracted IDs are not durable across revisions. Edits are
not deduplicated: repeated signature/date calls insert another item. Clients
must use the returned revision and inspect the result before retrying a request
whose response was lost. No new dependency, cloud service, or agent runtime was
added. Run the existing `python verify.py` command for verification.
