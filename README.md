# Paperwork

A PDF editor that runs on your computer. Edit text and artwork, find and replace exact text, securely remove sensitive information, add a reusable signature or today's date, and save an edited copy. The same document actions are callable from Python and the local HTTP API.

## Start on Windows

Double-click `start.bat` (Python 3.11+ required by the pinned dependencies). The first run creates a virtual environment and installs the dependencies. Open http://127.0.0.1:8765 in your browser. Keep the terminal open while using the editor.

Alternatively:

```powershell
python -m pip install -r requirements.txt
python server.py
```

## Common document actions

| Task | Tool | How it works |
| --- | --- | --- |
| Replace a name, address, or account number | Find & redact | Enter the exact text, preview matches, choose Replace text, and apply. |
| Remove or blackout sensitive text | Find & redact | Preview exact matches, then choose Remove or Blackout. |
| Redact a scan or pictured information | Find & redact | Choose Draw an area, drag over the information, and apply. |
| Sign a document | Signature | Upload an image or type your name, save it locally, then click to place it. |
| Add today's date | Date | Choose the format and click an empty place on the page. |

**Secure removal makes every page image-based.** The exported PDF contains the
redacted page pixels without original text, hidden data, or attachments. Existing
text loses search/editability and form fields become static. The original file
and in-memory undo history still retain the previous content. Save the redacted
copy for sharing, and inspect that every visible sensitive occurrence is removed.

This version uses exact text matching and manual signature/date placement.
Automatic personal-information detection, OCR, and automatic field placement
are not implemented. After updating a running copy, save your work and restart
the server to load the new tools.

## Use

- **Select (default):** click text, an image, or vector artwork directly on the page. Text opens inline editing and font controls; images/artwork show position, resize, layer order, and delete controls automatically. Select stays active as you switch between content types. Click empty space or press Escape to deselect. Clicking another object commits a pending text draft. Added images are automatically selected.
- **Edit text:** click a paragraph and type directly on the PDF. Text wraps within the selected block. Enter adds a new line. Drag a corner handle to resize the box or the grip above it to move it; focused handles also respond to arrow keys (Shift for larger steps). Click Done or press Ctrl+Enter to apply; Escape cancels. Clicking another block, changing tools/pages, or saving also applies the draft. Use Delete text box to remove the whole selected paragraph, or clear it and click Done.
- **Text styling:** select words inside a paragraph to change their font, size, color, bold, italic, or underline. With no words selected, formatting applies to the whole paragraph. Ctrl+B / Ctrl+I / Ctrl+U also work. Alignment and line spacing apply to the paragraph. Fonts include the original PDF font, Arial, Georgia, Times New Roman, Courier New, and Segoe UI (these additional fonts require Windows fonts installed locally).
- **Add text:** click an empty place on the page and type directly into a multiline text area. The click sets the first baseline. Adjust formatting in the sidebar.
- **Appearance:** choose the whole document or the current page. Enable the changes you want: solid page background, text color, and document font. Click Apply appearance. Document font changes retain heading sizes and bold/italic styles; wider text is fitted within its existing space. Background presets include white, ivory, sage, blue, and dark. For dark backgrounds, also choose a light text color. All appearance changes can be undone.
- **Image:** set a preferred width in PDF points and upload a PNG or JPEG. It is placed automatically in the visible part of the current page and scaled to stay within the page with its proportions intact. The new image is selected immediately; drag it to move it or use its corner handles to resize it.
- **Objects:** select an existing or added image, a vector path, or grouped artwork on the page or in the layer list. Click to select, or press and drag to move in one gesture; drag any corner handle to resize. Selection stays active after releasing the mouse. Keep proportions is enabled by default. You can also set left, top, width, and height numerically. Alignment guides snap to other objects and text blocks (hold Alt while moving to bypass snapping). Shift-click selects multiple objects to move, resize, recolor, or delete together. Vector fill/stroke colors can be changed. Bring to front and Send to back arrange the selection relative to page content. Delete removes the selected occurrence; shared copies elsewhere stay untouched. Edited objects remain selectable after export and reopening.
- **Highlight:** drag a rectangle over the page. Exports as a native PDF highlight annotation.
- **Note:** click a position and enter a comment. Open the exported file in a PDF reader to read the comment.
- **Find & redact:** find literal text on the current page or throughout the document, with optional case-insensitive matching. Preview the matches, then replace all matches, remove them, or black them out. Search is limited to a single extracted line; it includes displayed form values, but does not recognize pictured text. Choose Draw an area to select scanned or pictured information, then apply removal or blackout. Replacements fit within the original width and may use a smaller font; use the manual text editor for larger changes. Replacement edits page text, not interactive form values.
- **Secure removal:** Remove and Blackout rebuild **every page as an image**, erasing selected pixels before embedding the images in a fresh PDF. Original text, objects, form data, comments, metadata, links, bookmarks, and attachments are not copied. Page dimensions and visible appearance outside selected areas are retained at up to 144 DPI (long edges capped at 4,096 pixels). Existing text is no longer selectable or editable as text, and high-zoom quality/file size can change. Draw an area for scans; exact search does not automatically detect personal information. Verify that you selected every visible occurrence. Undo history and the original file retain prior content; save a separate redacted copy to share.
- **Signature:** upload a PNG/JPEG signature (up to 2 MB) or type your name to create one. One reusable signature is saved locally, separately from document sessions. Click the page to place it; the placed image supports the existing move/resize/delete controls. Forget saved signature removes the reusable asset without removing copies already placed in PDFs. This inserts a visual signature, not certificate-based digital signing.
- **Date:** select a date (defaults to today in your browser's local timezone), choose its format, size, and color, then click an empty place on the page. Use today's date resets a manually selected date. Dates and signatures use manual placement; automatic field detection is deferred.
- **Undo/redo:** labeled toolbar buttons or Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y. Up to 20 recent edits, subject to a 200 MB history cap. Includes images, objects, appearance, text, and annotations.
- **Save PDF…:** opens a Save as dialog to choose the folder and filename, suggesting `-edited.pdf`. Cancelling keeps your edits in the editor. Choosing an existing file asks before replacing it. The local native dialog uses Python's Tkinter, included with standard Windows Python installations. On Linux, install your distribution's Tkinter package if needed; a desktop session is required.

## Scope and limitations

This is a first working editor, not a full Acrobat replacement. Text reflows within a detected paragraph, with explicit newlines, mixed formatting, and adjustable wrapping width. Surrounding blocks do not move automatically, text does not flow across pages or around images. Rotated text is not editable and retains its original style during document-wide typography changes. There is no OCR. Scanned pages can receive text, images, highlights, and notes. Existing annotations are not selectable as objects. Underline created by the editor is a native PDF annotation and can be turned off on re-edit.

Objects exposes separate PDF painting operations: image occurrences, vector paths, and Form XObjects as grouped artwork. Native forms retain their internal paths, images, and text as one group; there is no ungrouping or vector-node editor. Flat scans cannot be separated into their pictured elements. Direct shadings are not exposed as individual objects. Curves use conservative selection bounds. Clipping masks and transparency are preserved; movement can remain constrained by an original enclosing clip. Paths that change coordinate systems mid-drawing or also define a clipping mask are listed as unavailable rather than modified. Objects do not automatically rearrange neighboring text, and annotations remain above page content.

Background changes replace ordinary page-covering rectangle fills or add a background behind an unfilled page. Smaller panels, accents, graphics, and images are preserved. An image background or complex artwork covering the page cannot be recolored by the solid background control; the app reports this rather than covering content. Background fills inside Form XObjects are not currently rewritten.

Original embedded fonts are reused when they can render the new characters; otherwise a compatible font is used and the app shows a notice. Unsupported characters are rejected. Font-size controls update live in one-point steps and expand the selected text box. The editor adjusts that box near page edges and permits overlap with nearby content, so you can finish the layout by moving or resizing it. It does not move surrounding blocks or create extra pages for oversized text. PDFs with complex overlapping text, unusual font encodings, or unusual graphics need visual review after editing. Text replacement removes the old characters and inserts new text; it is not a general-purpose secure-redaction workflow. Editing a digitally signed document invalidates its signature.

Password-protected PDFs must be unlocked before import. The upload limit is 50 MB. Documents and undo history live in server memory; restarting the server clears them. Save before refreshing or closing. Nothing is sent to an external service. The server listens only on loopback and checks a session token for document operations.

## Development and verification

The saved signature lives at `%LOCALAPPDATA%/Paperwork/signature.png` on Windows,
or `~/.local/share/Paperwork/signature.png` when `LOCALAPPDATA` is absent.
Set `PAPERWORK_DATA_DIR` to choose a different local data directory. No document
or signature is uploaded to an external service. See [basic action contracts](docs/basic-actions.md)
for direct Python calls and the authenticated local HTTP API.

Install the pinned dependencies from `requirements.txt` in a Python 3.11+ virtual environment
and install Node.js 22+ for JavaScript checks. Node.js is not required to run the
editor itself. From the repository root, run:

```powershell
python verify.py
```

The command uses the local `.venv` when invoked with a system Python. It checks
dependency versions/consistency, Python and JavaScript syntax, PDF editing and
HTTP regressions, and the existing page-refresh tests. A failed check returns a
nonzero exit code. It never installs dependencies or edits your documents.

The [Verify workflow](.github/workflows/verify.yml) runs the same command on every
push and pull request, on Windows and Linux with Python 3.11 and 3.12. Local
verification does not confirm a hosted CI run.

Tests generate synthetic two-page PDFs using built-in fonts, text, vector art,
and a shared image. They check export/reopen, formatting, object movement,
annotations, unchanged rendered regions, undo/redo, rejected edits and stale
revisions. Basic-action regressions also check erased image pixels, discarded
hidden data and form values, signature persistence in temporary directories,
date formats, and search-preview invalidation. They use an isolated HTTP server
and no private PDFs, saved user signatures, or live sessions.

See [AGENTS.md](AGENTS.md) for working guidance and
[docs/architecture.md](docs/architecture.md) for the module map and editing path.

## For agents

Use `basic_actions.find_text(pdf_bytes, request)` for read-only matching and
`server.edit_pdf(pdf_bytes, request)` for PDF changes. Supported actions include
`replace_text`, `redact`, `signature`, and `date`. The local HTTP API adds document
revision checks and shared undo/redo history; stale requests fail before editing.
Signature management uses a separate authenticated local endpoint and persists
one reusable image on this computer.

See [basic action contracts](docs/basic-actions.md) for parameters, examples,
storage, and retry behavior. No model provider or agent runtime is required.

## Implementation

Vanilla HTML/CSS/JavaScript, Python's standard HTTP server, PyMuPDF, and pikepdf for precise background content-stream changes. No database, AI service, cloud upload, or frontend build step. The app is intended for a single user on a local computer, not internet hosting.

PyMuPDF has its own AGPL/commercial licensing terms. Review them before distributing this app under a proprietary license.
