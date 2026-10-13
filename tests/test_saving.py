"""Save only to the chosen destination; keep existing files on failed writes."""
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import saving
from tests.pdf_fixtures import sample_pdf


class SavingTests(unittest.TestCase):
    def test_cancel_does_not_write(self):
        with patch('saving.choose_save_path', return_value=''), patch('saving.tempfile.NamedTemporaryFile') as output:
            self.assertEqual(saving.save_snapshot(sample_pdf(), 'fixture-edited.pdf'), {'saved': False})
            output.assert_not_called()

    def test_chosen_name_and_folder_receive_exact_snapshot(self):
        data = sample_pdf()
        with tempfile.TemporaryDirectory() as folder:
            destination = Path(folder) / 'Chosen name.pdf'
            with patch('saving.choose_save_path', return_value=str(destination)):
                result = saving.save_snapshot(data, 'fixture-edited.pdf')
            self.assertEqual(result, {'saved': True, 'name': 'Chosen name.pdf'})
            self.assertEqual(destination.read_bytes(), data)
            self.assertEqual(list(Path(folder).iterdir()), [destination])

    def test_failed_replacement_preserves_existing_file_and_cleans_temporary(self):
        with tempfile.TemporaryDirectory() as folder:
            destination = Path(folder) / 'existing.pdf'
            destination.write_bytes(b'existing data')
            with patch('saving.choose_save_path', return_value=str(destination)), patch('saving.os.replace', side_effect=PermissionError):
                with self.assertRaises(PermissionError):
                    saving.save_snapshot(sample_pdf(), 'fixture-edited.pdf')
            self.assertEqual(destination.read_bytes(), b'existing data')
            self.assertEqual(list(Path(folder).iterdir()), [destination])
