"""Small, transport-independent actions for imported PDFs."""
from datetime import date
import math
import re

import pymupdf as fitz


def page_indexes(doc, request):
    scope = request.get('scope', 'all')
    if scope not in ('all', 'page'):
        raise ValueError('Choose the current page or the whole document.')
    indexes = list(range(len(doc))) if scope == 'all' else [request.get('page', 0)]
    for index in indexes:
        if type(index) is not int or not 0 <= index < len(doc):
            raise ValueError('Choose a valid page.')
    return indexes


def text_matches(doc, request):
    query = request.get('query')
    if not isinstance(query, str) or not query.strip() or len(query) > 500 or '\n' in query or '\r' in query:
        raise ValueError('Enter exact text on one line (up to 500 characters).')
    sensitive = request.get('case_sensitive', True)
    if type(sensitive) is not bool:
        raise ValueError('Case sensitive must be true or false.')
    pattern = re.compile(re.escape(query), 0 if sensitive else re.IGNORECASE)
    matches = []
    for index in page_indexes(doc, request):
        page = doc[index]
        for block_index, block in enumerate(page.get_text('rawdict')['blocks']):
            for line_index, line in enumerate(block.get('lines', [])):
                chars = [(char, span) for span in line['spans'] for char in span['chars']]
                text = ''.join(char['c'] for char, _ in chars)
                for match in pattern.finditer(text):
                    selected = chars[match.start():match.end()]
                    rect = fitz.Rect(selected[0][0]['bbox'])
                    for char, _ in selected[1:]:
                        rect |= fitz.Rect(char['bbox'])
                    char, style = selected[0]
                    matches.append({'page': index, 'rect': list(rect), 'text': match.group(),
                        'origin': list(char['origin']), 'size': style['size'], 'font': style['font'],
                        'color': style['color'], 'editable': tuple(line['dir']) == (1, 0),
                        '_source': (block_index, line_index, match.start(), match.end())})
                    if len(matches) > 1000:
                        raise ValueError('More than 1,000 matches. Narrow the search to one page or a longer value.')
    return matches


def find_text(data, request):
    with fitz.open(stream=data, filetype='pdf') as doc:
        # Field appearances become searchable without changing the current document.
        doc.bake(annots=False, widgets=True)
        matches = text_matches(doc, request)
        return {'matches': [{k: v for k, v in match.items() if not k.startswith('_')} for match in matches], 'count': len(matches),
            'unsearchable_pages': [i for i in page_indexes(doc, request) if not doc[i].get_text().strip()]}


def replace_text(data, request, pick_font):
    replacement = request.get('replacement', '')
    if not isinstance(replacement, str) or len(replacement) > 500 or '\n' in replacement or '\r' in replacement:
        raise ValueError('Use one line of replacement text (up to 500 characters).')
    if not replacement:
        raise ValueError('Use Remove sensitive text to remove a value securely.')
    with fitz.open(stream=data, filetype='pdf') as doc:
        # This first version edits page text, not interactive form fields.
        matches = text_matches(doc, request)
        if not matches:
            raise ValueError('No matching page text found. Scanned text requires an area redaction.')
        for index in sorted({match['page'] for match in matches}):
            page_matches = [match for match in matches if match['page'] == index]
            selected = set()
            for match in page_matches:
                block, line, start, end = match['_source']
                selected.update((block, line, position) for position in range(start, end))
            for block_index, block in enumerate(doc[index].get_text('rawdict')['blocks']):
                for line_index, line in enumerate(block.get('lines', [])):
                    chars = [char for span in line['spans'] for char in span['chars']]
                    for position, char in enumerate(chars):
                        if (block_index, line_index, position) in selected:
                            continue
                        if any((fitz.Rect(char['bbox']) & fitz.Rect(match['rect'])).get_area() > .01 for match in page_matches):
                            raise ValueError('A match overlaps other text. Use the manual editor for this replacement.')
        prepared = []
        for match in matches:
            if not match['editable']:
                raise ValueError('Rotated matches cannot be replaced in this version.')
            page = doc[match['page']]
            alias, font, fallback = pick_font(doc, page, match['font'], replacement)
            rect = fitz.Rect(match['rect'])
            size = min(match['size'], rect.width / max(font.text_length(replacement, fontsize=1), .001))
            if size < 4:
                raise ValueError('The replacement is too long for a match. Use shorter text.')
            origin = fitz.Point(match['origin'])
            prepared.append((match, alias, font, size, origin, fallback))
        for index in sorted({m['page'] for m in matches}):
            page = doc[index]
            for match in matches:
                if match['page'] == index:
                    page.add_redact_annot(match['rect'], fill=False, cross_out=False)
            page.apply_redactions(images=0, graphics=0)
            for match, alias, font, size, origin, _ in prepared:
                if match['page'] != index:
                    continue
                if alias.startswith('EditFont'):
                    page.insert_font(fontname=alias, fontbuffer=font.buffer)
                rgb = tuple(((match['color'] >> shift) & 255) / 255 for shift in (16, 8, 0))
                page.insert_text(origin, replacement, fontname=alias, fontsize=size, color=rgb)
        request['_result_count'] = len(matches)
        return doc.tobytes(garbage=4, deflate=True), f"Replaced {len(matches)} match(es)."


def checked_rect(page, value):
    if not isinstance(value, (list, tuple)) or len(value) != 4 or any(type(n) not in (int, float) or not math.isfinite(n) for n in value):
        raise ValueError('Provide a finite rectangle [left, top, right, bottom].')
    rect = fitz.Rect(value)
    if rect.is_empty or not page.rect.contains(rect):
        raise ValueError('Place the entire area inside the page.')
    return rect


def redact_pdf(data, request):
    """Export only rendered pixels: no original objects or hidden data survive."""
    mode = request.get('mode', 'blackout')
    if mode not in ('blackout', 'remove'):
        raise ValueError('Choose blackout or remove.')
    with fitz.open(stream=data, filetype='pdf') as source, fitz.open() as result:
        if 'rect' in request:
            index = request.get('page')
            if type(index) is not int or not 0 <= index < len(source):
                raise ValueError('Choose a valid page.')
            areas = [{'page': index, 'rect': list(checked_rect(source[index], request['rect']))}]
        else:
            source.bake(annots=False, widgets=True)
            areas = text_matches(source, request)
            if not areas:
                raise ValueError('No matches found. Drag an area over scanned or pictured information.')
            # Remove complete matching glyphs before rendering: an italic overhang or
            # accent can extend beyond the extraction rectangle. The pixel mask below
            # also removes pictured information underneath the selected rectangles.
            for index in sorted({area['page'] for area in areas}):
                page = source[index]
                for area in areas:
                    if area['page'] == index:
                        page.add_redact_annot(area['rect'], fill=False, cross_out=False)
                page.apply_redactions(images=0, graphics=0)
        # Render into a new document, then erase selected pixels before embedding them.
        # Drawing an overlay into the source would retain recoverable original data.
        total_pixels = 0
        for index, page in enumerate(source):
            scale = min(2, 4096 / max(page.rect.width, page.rect.height))
            if scale <= 0:
                raise ValueError('This page has invalid dimensions.')
            total_pixels += math.ceil(page.rect.width * scale) * math.ceil(page.rect.height * scale)
            if total_pixels > 120_000_000:
                raise ValueError('This document is too large for secure removal in one operation. Split it first.')
            bitmap = page.get_pixmap(matrix=fitz.Matrix(scale, scale), colorspace=fitz.csRGB, alpha=False)
            for area in areas:
                if area['page'] != index:
                    continue
                rect = fitz.Rect(area['rect']) * page.rotation_matrix * fitz.Matrix(scale, scale)
                # Round outwards so antialiased edge pixels cannot retain a glyph fragment.
                pixels = fitz.IRect(math.floor(rect.x0), math.floor(rect.y0), math.ceil(rect.x1), math.ceil(rect.y1)) & bitmap.irect
                bitmap.set_rect(pixels, (0, 0, 0) if mode == 'blackout' else (255, 255, 255))
            output = result.new_page(width=page.rect.width, height=page.rect.height)
            output.insert_image(output.rect, stream=bitmap.tobytes('png'))
        request['_result_count'] = len(areas)
        return result.tobytes(garbage=4, deflate=True), (
            f"Removed {len(areas)} area(s). All pages are now image-based; original text and hidden data are absent from this PDF. "
            "Undo and the original file still retain the previous content.")


def date_text(request):
    value = request.get('date', 'today')
    if value != 'today' and (not isinstance(value, str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}', value)):
        raise ValueError('Provide today or a date in YYYY-MM-DD format.')
    try:
        day = date.today() if value == 'today' else date.fromisoformat(value)
    except (TypeError, ValueError):
        raise ValueError('Provide today or a date in YYYY-MM-DD format.') from None
    formats = {'iso': '%Y-%m-%d', 'dmy': '%d.%m.%Y', 'dmy_slash': '%d/%m/%Y', 'mdy_slash': '%m/%d/%Y'}
    if request.get('format', 'dmy') not in formats:
        raise ValueError('Choose a supported date format.')
    return day.strftime(formats[request.get('format', 'dmy')])


def add_date(data, request, pick_font, color):
    with fitz.open(stream=data, filetype='pdf') as doc:
        page = doc[page_indexes(doc, dict(request, scope='page'))[0]]
        point = request.get('point')
        if not isinstance(point, (list, tuple)) or len(point) != 2 or any(type(n) not in (int, float) or not math.isfinite(n) for n in point):
            raise ValueError('Provide a finite date position [x, baseline].')
        text = date_text(request)
        size = float(request.get('size', 12))
        if not math.isfinite(size) or not 4 <= size <= 144:
            raise ValueError('Choose a date size between 4 and 144 points.')
        alias, font, _ = pick_font(doc, page, request.get('font', 'Helvetica'), text)
        origin = fitz.Point(point)
        rect = fitz.Rect(origin.x, origin.y - font.ascender * size,
            origin.x + font.text_length(text, fontsize=size), origin.y - font.descender * size)
        if not page.rect.contains(rect):
            raise ValueError('Place the date fully inside the page.')
        for block in page.get_text('dict')['blocks']:
            for line in block.get('lines', []):
                for span in line['spans']:
                    overlap = rect & fitz.Rect(span['bbox'])
                    if overlap.width > 1 and overlap.height > 1:
                        raise ValueError('The date overlaps existing text. Choose an empty space.')
        page.insert_text(origin, text, fontsize=size, fontname=alias, color=color(request.get('color', '#242a28')))
        return doc.tobytes(garbage=4, deflate=True), ''


def add_signature(data, request, image):
    if not image:
        raise ValueError('Save a signature first.')
    with fitz.open(stream=data, filetype='pdf') as doc:
        page = doc[page_indexes(doc, dict(request, scope='page'))[0]]
        rect = checked_rect(page, request.get('rect'))
        page.insert_image(rect, stream=image, keep_proportion=True)
        return doc.tobytes(garbage=4, deflate=True), ''
