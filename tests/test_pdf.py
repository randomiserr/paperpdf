"""Exercise real PDF mutations and the HTTP workflow used by the manual editor."""
import http.client
from http.server import ThreadingHTTPServer
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

import pymupdf as fitz

import server
from objects import list_objects
from tests.pdf_fixtures import IMAGE_RECT, VECTOR_RECT, page_text, raster_signature, render, sample_pdf


def paragraph_id(data, text="Original paragraph."):
    with fitz.open(stream=data, filetype="pdf") as doc:
        return next(block["id"] for block in server.text_blocks(doc[0]) if block["text"] == text)


class PDFEditingTests(unittest.TestCase):
    def setUp(self):
        self.original = sample_pdf()

    def replace(self, **extra):
        request = {"action": "replace_block", "page": 0,
            "block": paragraph_id(self.original), "text": "Updated paragraph.",
            "size": 12, "width": 280, "color": "#000000"}
        request.update(extra)
        return server.edit_pdf(self.original, request)[0]

    def assert_surroundings_unchanged(self, edited):
        self.assertEqual(render(self.original, 1), render(edited, 1))
        for clip in [(0, 0, 360, 65), (0, 130, 360, 200), (0, 215, 360, 290)]:
            self.assertEqual(render(self.original, clip=clip), render(edited, clip=clip))

    def test_replace_export_and_reopen_preserves_surrounding_content(self):
        edited = self.replace()
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "exported.pdf"
            path.write_bytes(edited)
            with fitz.open(path) as reopened:
                self.assertEqual(len(reopened), 2)
                self.assertIn("Updated paragraph.", reopened[0].get_text())
                self.assertNotIn("Original paragraph.", reopened[0].get_text())
                self.assertEqual(list(reopened[0].rect), [0, 0, 360, 480])
        self.assertNotEqual(render(self.original), render(edited))
        self.assert_surroundings_unchanged(edited)

    def test_mixed_formatting_survives_reopening(self):
        edited = self.replace(runs=[
            {"text": "Mixed ", "font": "Helvetica", "size": 12, "color": "#000000"},
            {"text": "bold", "font": "Helvetica", "size": 12, "color": "#b02030",
             "bold": True, "underline": True}])
        with fitz.open(stream=edited, filetype="pdf") as doc:
            bold = next(span for span in server.spans(doc[0]) if span["text"] == "bold")
            self.assertTrue(bold["bold"])
            self.assertTrue(bold["underline"])
            self.assertEqual(bold["color"], 0xB02030)
            self.assertEqual(bold["size"], 12)
        self.assert_surroundings_unchanged(edited)

    def test_explicit_line_breaks_preserve_the_rest_of_the_page(self):
        edited = self.replace(text="First line.\nSecond line.")
        self.assertIn("First line.\nSecond line.", page_text(edited))
        with fitz.open(stream=edited, filetype="pdf") as doc:
            lines = [span for span in server.spans(doc[0]) if span["text"] in ("First line.", "Second line.")]
            self.assertEqual(len(lines), 2)
            self.assertGreater(lines[1]["origin"][1], lines[0]["origin"][1])
        self.assert_surroundings_unchanged(edited)

    def test_delete_paragraph_preserves_graphics_and_neighboring_text(self):
        edited = self.replace(text="")
        self.assertNotIn("Original paragraph.", page_text(edited))
        self.assertIn("Protected text.", page_text(edited))
        self.assert_surroundings_unchanged(edited)

    def test_add_text_without_replacing_existing_content(self):
        edited, _ = server.edit_pdf(self.original, {"action": "text_block", "page": 0,
            "point": [36, 190], "text": "Added text.", "font": "Helvetica",
            "size": 12, "width": 200})
        self.assertIn("Added text.", page_text(edited))
        self.assertIn("Original paragraph.", page_text(edited))
        self.assertEqual(render(self.original, 1), render(edited, 1))

    def test_moving_vector_or_shared_image_changes_only_selected_occurrence(self):
        for kind, source, target in [("vector", VECTOR_RECT, [36, 310, 96, 350]),
                                     ("image", IMAGE_RECT, [240, 230, 280, 270])]:
            with self.subTest(kind=kind):
                selected = next(item for item in list_objects(self.original, 0)
                    if item["kind"] == kind and all(abs(a-b) < 0.1 for a, b in zip(item["bbox"], source)))
                request = {"action": "objects", "page": 0, "objects": [selected["id"]],
                    "operation": "transform", "rect": target}
                edited, _ = server.edit_pdf(self.original, request)
                moved = next(item for item in list_objects(edited, 0)
                    if item["id"] == request["_result_objects"][0])
                for actual, expected in zip(moved["bbox"], target):
                    self.assertAlmostEqual(actual, expected, places=2)
                self.assertNotEqual(render(self.original, clip=source), render(edited, clip=source))
                self.assertNotEqual(render(self.original, clip=target), render(edited, clip=target))
                self.assertEqual(render(self.original, clip=(0, 0, 360, 200)),
                                 render(edited, clip=(0, 0, 360, 200)))
                self.assertEqual(render(self.original, 1), render(edited, 1))
                self.assertEqual(page_text(self.original), page_text(edited))

    def test_page_background_changes_without_recoloring_artwork(self):
        edited, _ = server.edit_pdf(self.original, {"action": "document_style",
            "page": 0, "scope": "page", "background": "#ddeeff"})
        with fitz.open(stream=edited, filetype="pdf") as doc:
            pixel = doc[0].get_pixmap(alpha=False).pixel(5, 5)
            # PDF float colors can quantize by one level during rasterization.
            for actual, expected in zip(pixel, (221, 238, 255)):
                self.assertLessEqual(abs(actual - expected), 1)
        for clip in [VECTOR_RECT, IMAGE_RECT]:
            self.assertEqual(render(self.original, clip=clip), render(edited, clip=clip))
        self.assertEqual(page_text(self.original), page_text(edited))
        self.assertEqual(render(self.original, 1), render(edited, 1))

    def test_page_typography_keeps_heading_hierarchy_and_other_pages(self):
        edited, _ = server.edit_pdf(self.original, {"action": "document_style",
            "page": 0, "scope": "page", "font": "Helvetica", "text_color": "#204060"})
        with fitz.open(stream=edited, filetype="pdf") as doc:
            spans = server.spans(doc[0])
            heading = next(span for span in spans if span["text"] == "Fixture heading")
            self.assertTrue(heading["bold"])
            self.assertAlmostEqual(heading["size"], 18)
            self.assertTrue(all(span["color"] == 0x204060 for span in spans))
        self.assertEqual(page_text(self.original), page_text(edited))
        self.assertEqual(render(self.original, 1), render(edited, 1))

    def test_highlight_and_note_export_as_native_annotations(self):
        highlighted, _ = server.edit_pdf(self.original, {"action": "highlight", "page": 0,
            "rect": [30, 135, 140, 155], "color": "#f4c84b"})
        edited, _ = server.edit_pdf(highlighted, {"action": "note", "page": 0,
            "point": [280, 150], "text": "Review this paragraph."})
        with fitz.open(stream=edited, filetype="pdf") as doc:
            page = doc[0]  # Annotations must retain their owning Page object.
            annotations = list(page.annots())
            self.assertEqual({item.type[1] for item in annotations}, {"Highlight", "Text"})
            note = next(item for item in annotations if item.type[1] == "Text")
            self.assertEqual(note.info["content"], "Review this paragraph.")
        self.assertEqual(page_text(self.original), page_text(edited))
        self.assertEqual(render(self.original, 1), render(edited, 1))

    def test_text_outside_page_or_overlapping_other_text_is_rejected(self):
        for point, message in [([350, 470], "page edge"), ([36, 150], "another text block")]:
            with self.subTest(point=point), self.assertRaisesRegex(ValueError, message):
                server.edit_pdf(self.original, {"action": "text_block", "page": 0,
                    "point": point, "text": "Invalid placement.", "font": "Helvetica",
                    "size": 12, "width": 200})

    def test_flexible_text_keeps_requested_size_and_fits_page_edges(self):
        edited=self.replace(size=40,width=10,point=[350,470],auto_layout=True)
        with fitz.open(stream=edited,filetype="pdf") as doc:
            changed=[span for span in server.spans(doc[0]) if span['size']>39]
            self.assertTrue(changed)
            self.assertTrue(all(abs(span['size']-40)<.01 for span in changed))
            self.assertTrue(all(doc[0].rect.contains(fitz.Rect(span['bbox'])) for span in changed))
            self.assertIn('Updated',doc[0].get_text())
            self.assertIn('paragraph.',doc[0].get_text())
            self.assertIn('Protected text.',doc[0].get_text())
        self.assertEqual(render(self.original,1),render(edited,1))

    def test_flexible_text_can_overlap_without_deleting_neighbors_on_reedit(self):
        enlarged=self.replace(size=48,width=280,point=[36,150],auto_layout=True)
        self.assertIn('Protected text.',page_text(enlarged))
        edited,_=server.edit_pdf(enlarged,{'action':'replace_block','page':0,
            'block':paragraph_id(enlarged,'Updated paragraph.'),'point':[36,90],
            'text':'Repositioned text.','font':'Helvetica','size':12,'width':280,'auto_layout':True})
        self.assertIn('Protected text.',page_text(edited))
        self.assertIn('Repositioned text.',page_text(edited))
        self.assertEqual(render(self.original,clip=(0,130,360,200)),render(edited,clip=(0,130,360,200)))
        self.assertEqual(render(self.original,1),render(edited,1))

    def test_text_box_position_moves_only_selected_text(self):
        edited=self.replace(text='Moved paragraph.',point=[48,110],auto_layout=True)
        with fitz.open(stream=edited,filetype='pdf') as doc:
            span=next(span for span in server.spans(doc[0]) if span['text']=='Moved paragraph.')
            self.assertAlmostEqual(span['origin'][0],48)
            self.assertAlmostEqual(span['origin'][1],110)
        self.assertEqual(render(self.original,clip=(0,130,360,200)),render(edited,clip=(0,130,360,200)))
        self.assertEqual(render(self.original,1),render(edited,1))

    def test_reediting_large_text_preserves_overlapped_rotated_text_and_underline(self):
        with fitz.open(stream=self.original,filetype='pdf') as doc:
            page=doc[0]
            page.insert_text((50,175),'Side',fontsize=12,rotate=90)
            neighbor=next(span for span in server.spans(page) if span['text']=='Protected text.')
            page.add_underline_annot(fitz.Rect(neighbor['bbox']))
            self.original=doc.tobytes()
        enlarged=self.replace(size=48,width=280,point=[36,150],auto_layout=True)
        edited,_=server.edit_pdf(enlarged,{'action':'replace_block','page':0,
            'block':paragraph_id(enlarged,'Updated paragraph.'),'point':[36,90],
            'text':'Adjusted text.','font':'Helvetica','size':12,'width':280,'auto_layout':True})
        self.assertIn('Side',page_text(edited))
        self.assertEqual(render(self.original,clip=(0,130,360,200)),render(edited,clip=(0,130,360,200)))


class QuietHandler(server.Handler):
    def log_message(self, format, *args):
        pass


class HTTPWorkflowTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.http = ThreadingHTTPServer(("127.0.0.1", 0), QuietHandler)
        cls.thread = threading.Thread(target=cls.http.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.http.shutdown()
        cls.http.server_close()
        cls.thread.join(timeout=5)

    def setUp(self):
        self.documents = []
        self.addCleanup(self.close_documents)
        self.document = self.open_pdf(sample_pdf())

    def request(self, method, path, body=None, status=200, authenticated=True):
        headers = {"X-Editor-Token": server.TOKEN} if authenticated else {}
        if isinstance(body, dict):
            body = json.dumps(body).encode()
            headers["Content-Type"] = "application/json"
        elif body is not None:
            headers.update({"Content-Type": "application/pdf", "X-Filename": "fixture.pdf"})
        connection = http.client.HTTPConnection("127.0.0.1", self.http.server_port, timeout=5)
        try:
            connection.request(method, path, body=body, headers=headers)
            response = connection.getresponse()
            data = response.read()
            self.assertEqual(response.status, status, data.decode(errors="replace") if response.status != status else "")
            return json.loads(data) if response.getheader("Content-Type") == "application/json" else data
        finally:
            connection.close()

    def open_pdf(self, data):
        document = self.request("POST", "/api/open", data)
        self.documents.append(document["id"])
        return document

    def close_documents(self):
        for identity in self.documents:
            self.request("POST", "/api/close", {"id": identity})

    def download(self, document=None):
        return self.request("GET", "/api/download?id=" + (document or self.document)["id"])

    def test_save_dialog_uses_current_snapshot_without_changing_history(self):
        self.document = self.request('POST', '/api/edit', self.edit_request())
        baseline = self.download()
        request = {'id': self.document['id'], 'revision': self.document['revision']}
        with patch('server.show_save_dialog', return_value={'saved': True, 'name': 'chosen.pdf'}) as dialog:
            result = self.request('POST', '/api/save', request)
            dialog.assert_called_once_with(baseline, 'fixture-edited.pdf')
        self.assertEqual(result, {'saved': True, 'name': 'chosen.pdf', 'revision': 1})
        self.assertEqual(self.download(), baseline)
        page = self.request('GET', '/api/page?id=' + self.document['id'] + '&page=0')
        self.assertEqual((page['revision'], page['undo'], page['redo']), (1, True, False))

    def test_cancel_failed_and_stale_save_do_not_change_document(self):
        baseline = self.download()
        request = {'id': self.document['id'], 'revision': self.document['revision']}
        with patch('server.show_save_dialog', return_value={'saved': False}) as dialog:
            self.assertEqual(self.request('POST', '/api/save', request), {'saved': False, 'revision': 0})
            self.request('POST', '/api/save', dict(request, revision=-1), status=400)
            self.request('POST', '/api/save', request, status=403, authenticated=False)
            self.assertEqual(dialog.call_count, 1)
        with patch('server.show_save_dialog', side_effect=ValueError('Save failed')):
            self.request('POST', '/api/save', request, status=400)
        self.assertFalse(server.SAVE_LOCK.locked())
        self.assertEqual(self.download(), baseline)

    def test_native_dialog_does_not_block_document_reads(self):
        def dialog(data, name):
            # A separate HTTP thread must be able to render/read while choosing a file.
            self.assertEqual(self.download(), data)
            self.request('POST', '/api/save', {'id': self.document['id'], 'revision': 0}, status=400)
            return {'saved': False}
        with patch('server.show_save_dialog', side_effect=dialog):
            self.request('POST', '/api/save', {'id': self.document['id'], 'revision': 0})

    def edit_request(self, document=None, **extra):
        document = document or self.document
        block = next(item for item in document["blocks"] if item["text"] in
            ("Original paragraph.", "Updated paragraph."))
        return {"id": document["id"], "revision": document["revision"], "page": 0,
            "action": "replace_block", "block": block["id"], "text": "Updated paragraph.",
            "width": 280, "size": 12, "color": "#000000", **extra}

    def test_manual_edit_download_undo_redo_and_stale_revision(self):
        baseline = self.download()
        edit = self.edit_request()
        updated = self.request("POST", "/api/edit", edit)
        exported = self.download()
        self.assertEqual(updated["revision"], 1)
        self.assertTrue(updated["undo"])
        self.assertIn("Updated paragraph.", page_text(exported))
        self.assertEqual(render(baseline, 1), render(exported, 1))
        undo = self.request("POST", "/api/undo", {"id": updated["id"], "revision": 1, "page": 0})
        self.assertEqual(undo["revision"], 2)
        self.assertTrue(undo["redo"])
        self.assertEqual(self.download(), baseline)
        redo = self.request("POST", "/api/redo", {"id": updated["id"], "revision": 2, "page": 0})
        self.assertEqual(redo["revision"], 3)
        self.assertEqual(self.download(), exported)
        stale = self.request("POST", "/api/edit", edit, status=400)
        self.assertIn("document changed", stale["error"].lower())
        self.assertEqual(self.download(), exported)

    def test_reopened_export_remains_manually_editable(self):
        self.request("POST", "/api/edit", self.edit_request())
        reopened = self.open_pdf(self.download())
        self.request("POST", "/api/edit", self.edit_request(reopened, text="Edited after reopening."))
        text = page_text(self.download(reopened))
        self.assertIn("Edited after reopening.", text)
        self.assertNotIn("Updated paragraph.", text)

    def test_failed_edit_does_not_change_document_revision_or_history(self):
        baseline = self.download()
        invalid = {"id": self.document["id"], "revision": 0, "page": 0,
            "action": "text_block", "point": [350, 470], "text": "Outside page.",
            "font": "Helvetica", "width": 200, "size": 12}
        error = self.request("POST", "/api/edit", invalid, status=400)
        self.assertIn("page edge", error["error"])
        current = self.request("GET", f"/api/page?id={self.document['id']}&page=0")
        self.assertEqual(current["revision"], 0)
        self.assertFalse(current["undo"])
        self.assertFalse(current["redo"])
        self.assertEqual(self.download(), baseline)

    def test_document_operations_require_the_session_token(self):
        baseline = self.download()
        self.request("POST", "/api/edit", self.edit_request(), status=403, authenticated=False)
        self.request("GET", "/api/download?id=" + self.document["id"], status=403, authenticated=False)
        self.assertEqual(self.download(), baseline)

    def test_page_inspection_and_render_endpoint_match_exported_pdf(self):
        current = self.request("GET", f"/api/page?id={self.document['id']}&page=0")
        self.assertEqual(current["width"], 360)
        self.assertEqual(current["height"], 480)
        self.assertTrue(any(block["text"] == "Original paragraph." for block in current["blocks"]))
        self.assertTrue(any(item["kind"] == "image" for item in current["objects"]))
        png = self.request("GET", f"/api/render?id={self.document['id']}&page=0&scale=2")
        self.assertTrue(png.startswith(b"\x89PNG\r\n\x1a\n"))
        bitmap = fitz.Pixmap(png)
        self.assertEqual(raster_signature(bitmap), render(self.download()))

    def test_inline_preview_keeps_text_underneath_an_enlarged_paragraph(self):
        original=self.download()
        updated=self.request('POST','/api/edit',self.edit_request(
            text='Updated paragraph.',size=48,width=280,point=[36,150],auto_layout=True))
        block=next(item for item in updated['blocks'] if item['text']=='Updated paragraph.')
        png=self.request('GET',f"/api/render?id={updated['id']}&page=0&scale=2&exclude={block['id']}")
        removed,_=server.edit_pdf(original,{'action':'replace_block','page':0,
            'block':paragraph_id(original),'text':'','size':12,'width':280})
        self.assertEqual(raster_signature(fitz.Pixmap(png)),render(removed))
        self.assertIn('Protected text.',page_text(self.download()))


if __name__ == "__main__":
    unittest.main()
