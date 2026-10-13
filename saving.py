"""Save a PDF snapshot through a local native dialog, isolated from server threads."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile


def choose_save_path(name):
    import tkinter as tk
    from tkinter import filedialog

    root = tk.Tk()
    root.withdraw()
    root.attributes('-topmost', True)
    try:
        return filedialog.asksaveasfilename(parent=root, title='Save PDF as',
            initialfile=name, defaultextension='.pdf',
            filetypes=[('PDF document', '*.pdf')], confirmoverwrite=True)
    finally:
        root.destroy()


def save_snapshot(data, name):
    selected = choose_save_path(name)
    if not selected:
        return {'saved': False}
    destination = Path(selected)
    # Replace only after a complete write; a failed save leaves any existing file intact.
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=destination.parent, prefix='.paperwork-', delete=False) as output:
            temporary = Path(output.name)
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, destination)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
    return {'saved': True, 'name': destination.name}


def show_save_dialog(data, name):
    result = subprocess.run([sys.executable, str(Path(__file__).resolve()), name],
        input=data, capture_output=True,
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
    if result.returncode:
        raise ValueError('Could not open the Save as dialog or write the PDF. Check the folder permissions and try again.')
    return json.loads(result.stdout)


if __name__ == '__main__':
    try:
        print(json.dumps(save_snapshot(sys.stdin.buffer.read(), sys.argv[1])))
    except Exception:
        # File paths and document contents stay local to the dialog process.
        sys.exit(1)
