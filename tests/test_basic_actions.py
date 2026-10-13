"""Basic actions use generated PDFs and isolated local signature storage."""
import base64
from datetime import date
import http.client
from http.server import ThreadingHTTPServer
import json
import math
import os
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

import pymupdf as fitz

import basic_actions
import server
import signatures
from tests.pdf_fixtures import sample_pdf, render, page_text


class BasicActionTests(unittest.TestCase):
    def setUp(self):
        self.original = sample_pdf()

    def test_exact_search_spans_fonts_and_respects_scope_and_case(self):
        with fitz.open() as doc:
            page = doc.new_page()
            page.insert_text((30, 50), 'Alice ', fontsize=12)
            x = 30 + fitz.get_text_length('Alice ', fontsize=12)
            page.insert_text((x, 50), 'Example', fontsize=12, fontname='hebo')
            page.insert_text((30, 90), 'alice example', fontsize=12)
            second = doc.new_page()
            second.insert_text((30, 50), 'Alice Example')
            data = doc.tobytes()
        self.assertEqual(basic_actions.find_text(data, {'query': 'Alice Example'})['count'], 2)
        matches = basic_actions.find_text(data, {'query': 'Alice Example', 'scope': 'page', 'page': 0, 'case_sensitive': False})
        self.assertEqual(matches['count'], 2)
        self.assertEqual([m['text'] for m in matches['matches']], ['Alice Example', 'alice example'])

    def test_search_is_literal_and_does_not_mutate(self):
        query = {'query': 'Original paragraph.', 'scope': 'all'}
        self.assertEqual(basic_actions.find_text(self.original, query)['count'], 1)
        self.assertEqual(basic_actions.find_text(self.original, {'query': 'Original.*'})['count'], 0)
        for invalid in ['', ' ', 'a\nb', 'a' * 501]:
            with self.assertRaises(ValueError):
                basic_actions.find_text(self.original, {'query': invalid})

    def test_replacement_preserves_neighboring_content_and_second_page(self):
        edited, _ = server.edit_pdf(self.original, {'action': 'replace_text', 'query': 'Original', 'replacement': 'New'})
        self.assertIn('New', page_text(edited))
        self.assertNotIn('Original', page_text(edited))
        self.assertIn('paragraph.', page_text(edited))
        self.assertEqual(render(self.original, 1), render(edited, 1))
        self.assertEqual(render(self.original, clip=(0, 130, 360, 480)), render(edited, clip=(0, 130, 360, 480)))

    def test_replacement_rejects_empty_or_oversized_values(self):
        for replacement in ['', 'x' * 500, 'line\nbreak']:
            with self.assertRaises(ValueError):
                server.edit_pdf(self.original, {'action': 'replace_text', 'query': 'Original', 'replacement': replacement})

    def test_replacement_rejects_overlapping_unselected_text(self):
        with fitz.open(stream=self.original, filetype='pdf') as doc:
            doc[0].insert_text((36, 89), 'Neighbor', fontsize=8)
            source = doc.tobytes()
        with self.assertRaisesRegex(ValueError, 'overlaps other text'):
            server.edit_pdf(source, {'action': 'replace_text', 'query': 'Original', 'replacement': 'New'})

    def test_exact_redaction_removes_italic_overhangs_and_accents(self):
        with fitz.open() as doc:
            page = doc.new_page(width=360, height=480)
            page.insert_text((50, 100), 'jÉf()', fontname='tiit', fontsize=40)
            source = doc.tobytes()
        edited, _ = server.edit_pdf(source, {'action': 'redact', 'query': 'jÉf()', 'mode': 'remove'})
        with fitz.open(stream=edited, filetype='pdf') as doc:
            bitmap = doc[0].get_pixmap(alpha=False)
            self.assertEqual(set(bitmap.samples), {255})
        self.assertNotEqual(render(source), render(edited))

    def test_secure_redaction_exports_only_pixels_and_discards_hidden_data(self):
        secret = 'Secret Account 123456'
        with fitz.open(stream=self.original, filetype='pdf') as doc:
            doc.set_metadata({'author': secret, 'subject': secret})
            doc.set_xml_metadata('<private>' + secret + '</private>')
            doc.embfile_add('private.txt', secret.encode())
            doc.set_toc([[1, secret, 1]])
            doc[0].add_text_annot((200, 180), secret)
            doc[0].insert_text((30, 380), secret, render_mode=3)
            doc[0].insert_link({'kind': fitz.LINK_URI, 'from': fitz.Rect(30, 400, 60, 420), 'uri': 'https://example.com/' + secret})
            doc.xref_set_key(doc[0].xref, 'PrivateValue', '(' + secret + ')')
            source = doc.tobytes()
        edited, warning = server.edit_pdf(source, {'action': 'redact', 'query': 'Original', 'mode': 'blackout'})
        self.assertIn('image-based', warning)
        with fitz.open(stream=edited, filetype='pdf') as reopened:
            self.assertEqual(len(reopened), 2)
            self.assertEqual(reopened.embfile_count(), 0)
            self.assertEqual(reopened.get_toc(), [])
            self.assertEqual(reopened.get_xml_metadata(), '')
            self.assertFalse(reopened.metadata['author'])
            for page in reopened:
                self.assertEqual(page.get_text(), '')
                self.assertEqual(list(page.annots() or []), [])
                self.assertEqual(list(page.widgets() or []), [])
                self.assertEqual(page.get_links(), [])
                self.assertEqual(len(page.get_images()), 1)
            for xref in range(1, reopened.xref_length()):
                self.assertNotIn(secret, reopened.xref_object(xref))
                self.assertNotIn('PrivateValue', reopened.xref_object(xref))
                stream = reopened.xref_stream(xref)
                if stream:
                    self.assertNotIn(secret.encode(), stream)
                    self.assertNotIn(b'Original', stream)
        self.assertEqual(render(source, 1), render(edited, 1))
        self.assertEqual(render(source, clip=(0, 130, 180, 170)), render(edited, clip=(0, 130, 180, 170)))

    def test_remove_and_blackout_erase_embedded_pixels_rather_than_cover_them(self):
        for mode, expected in [('remove', (255, 255, 255)), ('blackout', (0, 0, 0))]:
            request = {'action': 'redact', 'page': 0, 'rect': [140, 230, 180, 270], 'mode': mode}
            edited, _ = server.edit_pdf(self.original, request)
            with fitz.open(stream=edited, filetype='pdf') as doc:
                xref = doc[0].get_images()[0][0]
                image = fitz.Pixmap(doc, xref)
                self.assertEqual(image.pixel(300, 500), expected)
                # The sole image contains already-erased pixels; deleting PDF overlays cannot recover them.
                self.assertEqual(len(doc[0].get_drawings()), 0)
            self.assertEqual(render(self.original, clip=(0, 0, 360, 215)), render(edited, clip=(0, 0, 360, 215)))
            self.assertEqual(render(self.original, 1), render(edited, 1))

    def test_blackout_rounds_bounds_outwards(self):
        request = {'action': 'redact', 'page': 0, 'rect': [140.2, 230.2, 179.7, 269.7]}
        edited, _ = server.edit_pdf(self.original, request)
        with fitz.open(stream=edited, filetype='pdf') as doc:
            image = fitz.Pixmap(doc, doc[0].get_images()[0][0])
            self.assertEqual(image.pixel(280, 460), (0, 0, 0))
            self.assertEqual(image.pixel(359, 539), (0, 0, 0))

    def test_redaction_rejects_no_matches_and_invalid_rectangles(self):
        invalid = [{'query': 'absent'}, {'page': 0, 'rect': [0, 0, 0, 0]},
            {'page': 0, 'rect': [-1, 10, 30, 50]}, {'page': 0, 'rect': [0, 0, math.inf, 10]},
            {'page': -1, 'rect': [0, 0, 20, 20]}, {'page': 0, 'rect': [0, 0, 20, 20], 'mode': 'overlay'}]
        for request in invalid:
            with self.assertRaises(ValueError):
                server.edit_pdf(self.original, dict(request, action='redact'))

    def test_form_values_are_found_and_redacted_without_retaining_field_data(self):
        with fitz.open() as doc:
            page = doc.new_page(width=360, height=480)
            field = fitz.Widget()
            field.field_name = 'Personal name'
            field.field_type = fitz.PDF_WIDGET_TYPE_TEXT
            field.field_value = 'Alice Example'
            field.rect = fitz.Rect(30, 30, 250, 60)
            field.text_fontsize = 12
            page.add_widget(field)
            source = doc.tobytes()
        self.assertEqual(basic_actions.find_text(source, {'query': 'Alice Example'})['count'], 1)
        edited, _ = server.edit_pdf(source, {'action': 'redact', 'query': 'Alice Example'})
        with fitz.open(stream=edited, filetype='pdf') as doc:
            self.assertEqual(list(doc[0].widgets() or []), [])
            self.assertNotIn('Alice Example', doc.xref_object(doc.pdf_catalog()))
        self.assertNotEqual(render(source), render(edited))

    def test_date_formats_and_default_today(self):
        for format, expected in [('dmy', '13.10.2026'), ('iso', '2026-10-13'), ('dmy_slash', '13/10/2026'), ('mdy_slash', '10/13/2026')]:
            edited, _ = server.edit_pdf(self.original, {'action': 'date', 'page': 0, 'point': [30, 350], 'date': '2026-10-13', 'format': format})
            self.assertIn(expected, page_text(edited))
            self.assertEqual(render(self.original, 1), render(edited, 1))
        self.assertEqual(basic_actions.date_text({'format': 'iso'}), date.today().isoformat())

    def test_date_rejects_invalid_value_position_and_overlap(self):
        for extra in [{'date': '2026-02-30'}, {'date': '20261013'}, {'format': 'unknown'},
            {'point': [350, 470]}, {'point': [30, math.nan]}, {'point': [36, 90]}, {'page': -1}, {'size': math.inf}]:
            with self.assertRaises(ValueError):
                server.edit_pdf(self.original, {'action': 'date', 'page': 0, 'point': [30, 350], 'date': '2026-10-13', **extra})


class SignatureTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.environment = patch.dict(os.environ, {'PAPERWORK_DATA_DIR': self.folder.name})
        self.environment.start()
        self.addCleanup(self.environment.stop)

    def test_typed_signature_is_persistent_and_can_be_placed_and_reopened(self):
        info = signatures.save_signature({'name': 'Alice Example'})
        self.assertTrue(info['saved'])
        self.assertTrue(signatures.storage_path().is_file())
        self.assertEqual(signatures.signature_info()['image'], info['image'])
        png = base64.b64decode(info['image'])
        self.assertEqual(fitz.Pixmap(png).alpha, 1)
        original = sample_pdf()
        edited, _ = server.edit_pdf(original, {'action': 'signature', 'page': 0, 'rect': [30, 330, 170, 375]})
        self.assertEqual(render(original, 1), render(edited, 1))
        self.assertEqual(render(original, clip=(0, 0, 360, 290)), render(edited, clip=(0, 0, 360, 290)))
        self.assertNotEqual(render(original), render(edited))
        signatures.clear_signature()
        self.assertFalse(signatures.signature_info()['saved'])
        self.assertNotEqual(render(original), render(edited))  # Forgetting the saved asset does not alter placed signatures.

    def test_upload_signature_and_failed_replacement_preserve_saved_asset(self):
        image = fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, 20, 10), False)
        image.clear_with(100)
        info = signatures.save_signature({'image': base64.b64encode(image.tobytes('png')).decode()})
        self.assertEqual((info['width'], info['height']), (20, 10))
        baseline = signatures.load_signature()
        for invalid in [{'name': ''}, {'name': 'name\nsecond'}, {'image': 'invalid!'}, {'image': base64.b64encode(b'not an image').decode()}]:
            with self.assertRaises(ValueError):
                signatures.save_signature(invalid)
            self.assertEqual(signatures.load_signature(), baseline)

    def test_signature_rejects_missing_asset_or_invalid_placement(self):
        request = {'action': 'signature', 'page': 0, 'rect': [30, 330, 170, 375]}
        with self.assertRaises(ValueError):
            server.edit_pdf(sample_pdf(), request)
        signatures.save_signature({'name': 'Alice'})
        with self.assertRaises(ValueError):
            server.edit_pdf(sample_pdf(), dict(request, rect=[-10, 330, 170, 375]))


class BasicHTTPTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.http = ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
        cls.thread = threading.Thread(target=cls.http.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.http.shutdown()
        cls.http.server_close()
        cls.thread.join(timeout=5)

    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        environment = patch.dict(os.environ, {'PAPERWORK_DATA_DIR': self.folder.name})
        environment.start()
        self.addCleanup(environment.stop)
        self.document = self.request('/api/open', sample_pdf())
        self.addCleanup(lambda: self.request('/api/close', {'id': self.document['id']}))

    def request(self, path, body=None, method='POST', status=200, authenticated=True):
        headers = {'X-Editor-Token': server.TOKEN} if authenticated else {}
        if isinstance(body, dict):
            body = json.dumps(body).encode()
        connection = http.client.HTTPConnection('127.0.0.1', self.http.server_port, timeout=10)
        try:
            connection.request(method, path, body=body, headers=headers)
            response = connection.getresponse()
            data = response.read()
            self.assertEqual(response.status, status)
            return json.loads(data) if response.getheader('Content-Type') == 'application/json' else data
        finally:
            connection.close()

    def download(self):
        return self.request('/api/download?id=' + self.document['id'], method='GET')

    def test_find_does_not_change_revision_and_rejects_stale_requests(self):
        original = self.download()
        request = {'id': self.document['id'], 'revision': 0, 'query': 'Original'}
        result = self.request('/api/find', request)
        self.assertEqual((result['count'], result['revision']), (1, 0))
        self.request('/api/find', dict(request, revision=-1), status=400)
        self.request('/api/find', request, status=403, authenticated=False)
        self.assertEqual(original, self.download())

    def test_redaction_undo_redo_export_and_rejected_requests(self):
        original = self.download()
        request = {'id': self.document['id'], 'revision': 0, 'page': 0, 'action': 'redact', 'query': 'Original'}
        for invalid in [dict(request, query='absent'), dict(request, page=99)]:
            self.request('/api/edit', invalid, status=400)
            self.assertEqual(self.download(), original)
        result = self.request('/api/edit', request)
        self.assertEqual((result['revision'], result['changed']), (1, 1))
        edited = self.download()
        self.assertEqual(page_text(edited), '')
        self.request('/api/edit', request, status=400)
        self.assertEqual(self.download(), edited)
        self.request('/api/undo', {'id': result['id'], 'revision': 1, 'page': 0})
        self.assertEqual(self.download(), original)
        self.request('/api/redo', {'id': result['id'], 'revision': 2, 'page': 0})
        self.assertEqual(self.download(), edited)

    def test_signature_endpoints_are_local_authenticated_and_independent_of_sessions(self):
        self.request('/api/signature', method='GET', status=403, authenticated=False)
        self.request('/api/signature', {'name': 'Alice'}, status=403, authenticated=False)
        self.assertFalse(self.request('/api/signature', method='GET')['saved'])
        saved = self.request('/api/signature', {'name': 'Alice'})
        self.assertEqual(self.request('/api/signature', method='GET')['image'], saved['image'])
        result = self.request('/api/edit', {'id': self.document['id'], 'revision': 0, 'page': 0,
            'action': 'signature', 'rect': [30, 330, 170, 380]})
        self.assertEqual(result['revision'], 1)
        self.assertFalse(self.request('/api/signature', {'clear': True})['saved'])
