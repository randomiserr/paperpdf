"""Persist one reusable signature on this computer, separately from PDF sessions."""
import base64
import os
from pathlib import Path
import tempfile

import pymupdf as fitz

LIMIT = 2 * 1024 * 1024


def storage_path():
    configured = os.environ.get('PAPERWORK_DATA_DIR')
    directory = Path(configured) if configured else Path(os.environ.get('LOCALAPPDATA', Path.home() / '.local' / 'share')) / 'Paperwork'
    return directory / 'signature.png'


def load_signature():
    path = storage_path()
    return path.read_bytes() if path.is_file() else None


def signature_info():
    image = load_signature()
    if image is None:
        return {'saved': False}
    bitmap = fitz.Pixmap(image)
    return {'saved': True, 'image': base64.b64encode(image).decode('ascii'), 'width': bitmap.width, 'height': bitmap.height}


def typed_signature(name):
    if not isinstance(name, str) or not name.strip() or len(name) > 100 or any(ord(c) < 32 for c in name):
        raise ValueError('Enter your name on one line (up to 100 characters).')
    name = name.strip()
    font = fitz.Font('tiit')
    fonts = Path(os.environ.get('WINDIR', 'C:/Windows')) / 'Fonts'
    for path in [fonts / 'segoesc.ttf', fonts / 'ariali.ttf', Path('/usr/share/fonts/truetype/dejavu/DejaVuSans-Oblique.ttf')]:
        if path.is_file():
            candidate = fitz.Font(fontfile=str(path))
            if all(candidate.has_glyph(ord(c)) for c in name):
                font = candidate
                break
    if not all(font.has_glyph(ord(c)) for c in name):
        raise ValueError('The available signature font cannot display this name. Upload an image instead.')
    size = 36
    width = font.text_length(name, fontsize=size) + 24
    height = (font.ascender - font.descender) * size + 24
    if width > 2000:
        raise ValueError('Use a shorter signature name.')
    with fitz.open() as doc:
        page = doc.new_page(width=width, height=height)
        page.insert_font(fontname='Signature', fontbuffer=font.buffer)
        page.insert_text((12, 12 + font.ascender * size), name, fontname='Signature', fontsize=size, color=(.07, .12, .2))
        return page.get_pixmap(matrix=fitz.Matrix(2, 2), alpha=True).tobytes('png')


def save_signature(request):
    if 'name' in request:
        image = typed_signature(request['name'])
    else:
        try:
            image = base64.b64decode(request.get('image', ''), validate=True)
        except (TypeError, ValueError):
            raise ValueError('Choose a valid PNG or JPEG signature.') from None
        if not image or len(image) > LIMIT or not image.startswith((b'\x89PNG\r\n\x1a\n', b'\xff\xd8\xff')):
            raise ValueError('Choose a PNG or JPEG signature smaller than 2 MB.')
        bitmap = fitz.Pixmap(image)
        if bitmap.width * bitmap.height > 4_000_000:
            raise ValueError('Choose a signature image with fewer than 4 million pixels.')
        if bitmap.colorspace and bitmap.colorspace.n != 3:
            bitmap = fitz.Pixmap(fitz.csRGB, bitmap)
        # Canonical PNG strips uploaded EXIF and other original-file metadata.
        image = bitmap.tobytes('png')
    if len(image) > LIMIT:
        raise ValueError('Choose a smaller signature image.')
    path = storage_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=path.parent, suffix='.tmp', delete=False) as stream:
            temporary = Path(stream.name)
            stream.write(image)
        os.replace(temporary, path)
    finally:
        if temporary and temporary.exists():
            temporary.unlink()
    return signature_info()


def clear_signature():
    storage_path().unlink(missing_ok=True)
    return {'saved': False}
