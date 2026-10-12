# Paperwork

A manual PDF editor that runs on your computer. Open a PDF, click existing text to change it, add text and images, highlight areas, leave notes, undo/redo, and download an edited copy.

## Start on Windows

Double-click `start.bat` (Python 3.10+ required). The first run creates a virtual environment and installs the dependencies. Open http://127.0.0.1:8765 in your browser. Keep the terminal open while using the editor.

Alternatively:

```powershell
python -m pip install -r requirements.txt
python server.py
```

## Use

- **Select (default):** click text, an image, or vector artwork directly on the page. Text opens inline editing and font controls; images/artwork show position, resize, layer order, and delete controls automatically. Select stays active as you switch between content types. Click empty space or press Escape to deselect. Clicking another object commits a pending text draft. Added images are automatically selected.
- **Edit text:** click a paragraph and type directly on the PDF. Text wraps within the selected block. Enter adds a new line; drag the bottom-right corner to change the width. Click Done or press Ctrl+Enter to apply; Escape cancels. Clicking another block, changing tools/pages, or downloading also applies the draft. Use Delete text box to remove the whole selected paragraph, or clear it and click Done.
- **Text styling:** select words inside a paragraph to change their font, size, color, bold, italic, or underline. With no words selected, formatting applies to the whole paragraph. Ctrl+B / Ctrl+I / Ctrl+U also work. Alignment and line spacing apply to the paragraph. Fonts include the original PDF font, Arial, Georgia, Times New Roman, Courier New, and Segoe UI (these additional fonts require Windows fonts installed locally).
- **Add text:** click an empty place on the page and type directly into a multiline text area. The click sets the first baseline. Adjust formatting in the sidebar.
- **Appearance:** choose the whole document or the current page. Enable the changes you want: solid page background, text color, and document font. Click Apply appearance. Document font changes retain heading sizes and bold/italic styles; wider text is fitted within its existing space. Background presets include white, ivory, sage, blue, and dark. For dark backgrounds, also choose a light text color. All appearance changes can be undone.
- **Image:** choose a PNG or JPEG, set its width in PDF points, then click its top-left position. The new image is automatically selected in Objects and can be edited afterward.
- **Objects:** select an existing or added image, a vector path, or grouped artwork on the page or in the layer list. Click to select, or press and drag to move in one gesture; drag any corner handle to resize. Selection stays active after releasing the mouse. Keep proportions is enabled by default. You can also set left, top, width, and height numerically. Alignment guides snap to other objects and text blocks (hold Alt while moving to bypass snapping). Shift-click selects multiple objects to move, resize, recolor, or delete together. Vector fill/stroke colors can be changed. Bring to front and Send to back arrange the selection relative to page content. Delete removes the selected occurrence; shared copies elsewhere stay untouched. Edited objects remain selectable after export and reopening.
- **Highlight:** drag a rectangle over the page. Exports as a native PDF highlight annotation.
- **Note:** click a position and enter a comment. Open the exported file in a PDF reader to read the comment.
- **Undo/redo:** labeled toolbar buttons or Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y. Up to 20 recent edits, subject to a 200 MB history cap. Includes images, objects, appearance, text, and annotations.
- **Download PDF:** saves a new file ending in `-edited.pdf`. The input file is never overwritten.

## Scope and limitations

This is a first working editor, not a full Acrobat replacement. Text reflows within a detected paragraph, with explicit newlines, mixed formatting, and adjustable wrapping width. Surrounding blocks do not move automatically, text does not flow across pages or around images. Rotated text is not editable and retains its original style during document-wide typography changes. There is no OCR. Scanned pages can receive text, images, highlights, and notes. Existing annotations are not selectable as objects. Underline created by the editor is a native PDF annotation and can be turned off on re-edit.

Objects exposes separate PDF painting operations: image occurrences, vector paths, and Form XObjects as grouped artwork. Native forms retain their internal paths, images, and text as one group; there is no ungrouping or vector-node editor. Flat scans cannot be separated into their pictured elements. Direct shadings are not exposed as individual objects. Curves use conservative selection bounds. Clipping masks and transparency are preserved; movement can remain constrained by an original enclosing clip. Paths that change coordinate systems mid-drawing or also define a clipping mask are listed as unavailable rather than modified. Objects do not automatically rearrange neighboring text, and annotations remain above page content.

Background changes replace ordinary page-covering rectangle fills or add a background behind an unfilled page. Smaller panels, accents, graphics, and images are preserved. An image background or complex artwork covering the page cannot be recolored by the solid background control; the app reports this rather than covering content. Background fills inside Form XObjects are not currently rewritten.

Original embedded fonts are reused when they can render the new characters; otherwise a compatible font is used and the app shows a notice. Unsupported characters are rejected. New text is checked for page boundaries and overlap with nearby text. PDFs with complex overlapping text, unusual font encodings, or unusual graphics need visual review after editing. Text replacement removes the old characters and inserts new text; it is not a general-purpose secure-redaction workflow. Editing a digitally signed document invalidates its signature.

Password-protected PDFs must be unlocked before import. The upload limit is 50 MB. Documents and undo history live in server memory; restarting the server clears them. Download before refreshing or closing. Nothing is sent to an external service. The server listens only on loopback and checks a session token for document operations.

## Implementation

Vanilla HTML/CSS/JavaScript, Python's standard HTTP server, PyMuPDF, and pikepdf for precise background content-stream changes. No database, AI service, cloud upload, or frontend build step. The app is intended for a single user on a local computer, not internet hosting.

PyMuPDF has its own AGPL/commercial licensing terms. Review them before distributing this app under a proprietary license.
