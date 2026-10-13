"""Synthetic PDFs only: no private documents, binary baselines, or system fonts."""
import hashlib

import pymupdf as fitz

VECTOR_RECT = (36, 230, 96, 270)
IMAGE_RECT = (140, 230, 180, 270)


def sample_pdf():
    image = fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, 8, 8), False)
    image.clear_with(136)
    with fitz.open() as doc:
        page = doc.new_page(width=360, height=480)
        page.draw_rect(page.rect, color=None, fill=(0.95, 0.94, 0.90))
        page.insert_text((36, 50), "Fixture heading", fontname="hebo", fontsize=18)
        page.insert_text((36, 90), "Original paragraph.", fontsize=12)
        page.insert_text((36, 150), "Protected text.", fontsize=12)
        page.draw_rect(VECTOR_RECT, color=None, fill=(0.2, 0.5, 0.8))
        shared_image = page.insert_image(IMAGE_RECT, stream=image.tobytes("png"))
        second = doc.new_page(width=360, height=480)
        second.insert_text((36, 50), "Untouched second page.", fontsize=16)
        # Moving one occurrence must not move the shared copy on another page.
        second.insert_image(IMAGE_RECT, xref=shared_image)
        return doc.tobytes(garbage=4, deflate=True)


def render(data, page=0, clip=None):
    with fitz.open(stream=data, filetype="pdf") as doc:
        bitmap = doc[page].get_pixmap(matrix=fitz.Matrix(2, 2), clip=clip, alpha=False)
        return raster_signature(bitmap)


def raster_signature(bitmap):
    # Exact pixel comparisons with concise diagnostics instead of megabytes of bytes.
    return bitmap.width, bitmap.height, hashlib.sha256(bitmap.samples).hexdigest()


def page_text(data, page=0):
    with fitz.open(stream=data, filetype="pdf") as doc:
        return doc[page].get_text()
