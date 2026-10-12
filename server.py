"""Paperwork: a loopback-only, in-memory PDF editor."""
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlparse, parse_qs, quote
import base64
import json
import secrets
import threading
import time
import sys
import os
import statistics
import math
from styling import flags, styled_font, write_rich, document_style
from objects import list_objects, edit_objects, render_objects

try:
    import pymupdf as fitz
except ImportError:
    print('Install the dependency first: python -m pip install -r requirements.txt')
    raise SystemExit(1)

ROOT = Path(__file__).parent
TOKEN = secrets.token_urlsafe(32)
DOCS = {}
LOCK = threading.RLock()
LIMIT = 50 * 1024 * 1024
fitz.TOOLS.set_small_glyph_heights(True)


def color(value):
    value = str(value).lstrip('#')
    if len(value) != 6:
        raise ValueError('Choose a valid color.')
    return tuple(int(value[i:i+2], 16) / 255 for i in (0, 2, 4))


def spans(page):
    result = []
    underlines = [fitz.Rect(a.rect) for a in page.annots() or [] if a.type[1]=='Underline']
    for block in page.get_text('dict')['blocks']:
        for line in block.get('lines', []):
            for span in line['spans']:
                if span['text'].strip():
                    result.append({k: span[k] for k in ('text', 'bbox', 'origin', 'size', 'font', 'color')} | {
                        'id': len(result), 'bold':bool(span['flags']&16), 'italic':bool(span['flags']&2),
                        'underline':any((r & fitz.Rect(span['bbox'])).get_area()>fitz.Rect(span['bbox']).get_area()*.7 for r in underlines),
                        'editable': abs(line['dir'][0]-1) < .001 and abs(line['dir'][1]) < .001
                    })
    return result


def text_blocks(page):
    """Group neighboring lines, keeping columns and different-size headings separate."""
    result = []
    underlines = [fitz.Rect(a.rect) for a in page.annots() or [] if a.type[1]=='Underline']
    for raw in page.get_text('dict')['blocks']:
        groups = []
        for line in raw.get('lines', []):
            ss = [s for s in line['spans'] if s['text'].strip()]
            if not ss:
                continue
            dominant = max(ss, key=lambda s: len(s['text']))
            bbox = fitz.Rect(line['bbox'])
            previous = groups[-1][-1] if groups else None
            same = previous and abs(dominant['size'] - previous['size']) < .6 and abs(bbox.x0 - previous['bbox'][0]) < dominant['size']*2 and 0 < dominant['origin'][1]-previous['origin'][1] < dominant['size']*1.9
            item = {**dominant, 'text': ''.join(s['text'] for s in line['spans']), 'bbox': list(bbox), 'spans': ss, 'editable': abs(line['dir'][0]-1)<.001 and abs(line['dir'][1])<.001}
            if same:
                groups[-1].append(item)
            else:
                groups.append([item])
        for lines in groups:
            ss = [s for line in lines for s in line['spans']]
            dominant = max(ss, key=lambda s: len(s['text']))
            rect = fitz.Rect(lines[0]['bbox'])
            for line in lines[1:]:
                rect |= fitz.Rect(line['bbox'])
            heights = [b['origin'][1]-a['origin'][1] for a,b in zip(lines,lines[1:])]
            runs=[]
            for line_index,line in enumerate(lines):
                if line_index and runs:
                    runs.append({**runs[-1],'text':' '})
                for s in line['spans']:
                    runs.append({'text':s['text'],'font':s['font'],'size':s['size'],'color':'#'+format(s['color'],'06x'),
                                 'bold':bool(s['flags']&16),'italic':bool(s['flags']&2),
                                 'underline':any((r & fitz.Rect(s['bbox'])).get_area()>fitz.Rect(s['bbox']).get_area()*.7 for r in underlines)})
            result.append({'id': len(result), 'text': ' '.join(line['text'].strip() for line in lines),
                'bbox': list(rect), 'origin': [rect.x0,lines[0]['origin'][1]], 'size': dominant['size'],
                'font': dominant['font'], 'color': dominant['color'], 'lineheight': statistics.median(heights) if heights else dominant['size']*1.35,
                'editable': all(line['editable'] for line in lines), 'rects': [s['bbox'] for s in ss],
                'mixed': len({(s['font'],round(s['size'],1),s['color']) for s in ss})>1, 'runs':runs,
                'bold':bool(dominant['flags']&16),'italic':bool(dominant['flags']&2)})
    return result


def wrap_text(text, font, size, width):
    lines = []
    for paragraph in text.replace('\r\n','\n').replace('\r','\n').split('\n'):
        current = ''
        for word in paragraph.split():
            candidate = current+' '+word if current else word
            if font.text_length(candidate, fontsize=size) <= width:
                current = candidate
                continue
            if current:
                lines.append(current)
                current = ''
            for char in word:
                if font.text_length(current+char, fontsize=size)>width:
                    if not current:
                        raise ValueError('The text area is too narrow for this font size.')
                    lines.append(current)
                    current = ''
                current += char
        lines.append(current)
    return lines


def page_info(doc, index):
    page = doc[index]
    return {'page': index, 'width': page.rect.width, 'height': page.rect.height, 'spans': spans(page), 'blocks': text_blocks(page)}


def metadata(record, index=0):
    with fitz.open(stream=record['data'], filetype='pdf') as doc:
        return {'id': record['id'], 'name': record['name'], 'count': len(doc),
                'revision': record['revision'], 'undo': bool(record['undo']), 'redo': bool(record['redo']),
                **page_info(doc, index), 'objects': list_objects(record['data'], index)}


def pick_font(doc, page, name, text):
    # Reuse an embedded font when it has all requested glyphs.
    def normalize(value):
        return value.split('+')[-1].lower().replace('-','').replace(' ','').removesuffix('regular').removesuffix('book')
    clean = normalize(name)
    candidates = [item for item in page.get_fonts(full=True) if normalize(item[3])==clean]
    candidates.sort(key=lambda item: len(doc.extract_font(item[0])[3]),reverse=True)
    for item in candidates:
        if normalize(item[3]) == clean:
            try:
                data = doc.extract_font(item[0])[3]
                if data:
                    font = fitz.Font(fontbuffer=data)
                    if all(font.has_glyph(ord(c)) for c in text if not c.isspace()):
                        alias = 'EditFont' + secrets.token_hex(4)
                        page.insert_font(fontname=alias, fontbuffer=data)
                        return alias, font, False
            except Exception:
                pass
    bold = 'bold' in clean
    italic = 'italic' in clean or 'oblique' in clean
    family = 'cour' if any(x in clean for x in ['courier', 'mono', 'consolas']) else 'times' if any(x in clean for x in ['times', 'serif', 'georgia']) else 'helv'
    names = {'helv': ['helv','hebo','heit','hebi'], 'times': ['tiro','tibo','tiit','tibi'], 'cour': ['cour','cobo','coit','cobi']}
    alias = names[family][int(bold) + 2*int(italic)]
    font = fitz.Font(alias)
    if all(ord(c) < 256 and font.has_glyph(ord(c)) for c in text if not c.isspace()):
        return alias, font, clean not in ['helvetica','timesroman','courier']
    fonts = Path(os.environ.get('WINDIR', 'C:/Windows')) / 'Fonts'
    variant=int(bold)+2*int(italic)
    for candidate in [fonts/['arial.ttf','arialbd.ttf','ariali.ttf','arialbi.ttf'][variant], fonts/['segoeui.ttf','segoeuib.ttf','segoeuii.ttf','segoeuiz.ttf'][variant], Path('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf')]:
        if candidate.exists():
            font = fitz.Font(fontfile=str(candidate))
            if all(font.has_glyph(ord(c)) for c in text if not c.isspace()):
                alias = 'EditFont' + secrets.token_hex(4)
                page.insert_font(fontname=alias, fontfile=str(candidate))
                return alias, font, True
    raise ValueError('The available fonts cannot display these characters. Try a different font or text.')


def edit_pdf(data, request):
    if request.get('action')=='objects':
        return edit_objects(data,request,color)
    if request.get('action')=='document_style':
        return document_style(data,request,pick_font,color,spans)
    with fitz.open(stream=data, filetype='pdf') as doc:
        page = doc[int(request['page'])]
        action = request['action']
        warning = ''
        if action in ('replace_block', 'text_block'):
            block = text_blocks(page)[int(request['block'])] if action=='replace_block' else None
            if block and not block['editable']:
                raise ValueError('Rotated text cannot be edited in this version.')
            warning = write_rich(doc,page,block,request,pick_font,color,spans)
        elif action in ('replace', 'text'):
            text = str(request.get('text', ''))
            if '\n' in text or '\r' in text:
                raise ValueError('Use one line per text box.')
            if len(text) > 2000:
                raise ValueError('This text box is too long.')
            size = max(4, min(144, float(request.get('size', 14))))
            rgb = color(request.get('color', '#242a28'))
            source = None
            if action == 'replace':
                source = spans(page)[int(request['span'])]
                if not source['editable']:
                    raise ValueError('Rotated text cannot be edited in this version.')
                origin = fitz.Point(source['origin'])
                fontname = source['font']
            else:
                origin = fitz.Point(request['point'])
                fontname = request.get('font', 'Helvetica')
            alias, font, fallback = pick_font(doc, page, fontname, text)
            width = font.text_length(text, fontsize=size)
            if text:
                target = fitz.Rect(origin.x, origin.y - font.ascender*size, origin.x+width, origin.y-font.descender*size)
                if not page.rect.contains(target):
                    raise ValueError('The text extends beyond the page. Use a smaller size or shorter text.')
                for other in spans(page):
                    if source and other['id'] == source['id']:
                        continue
                    intersection = target & fitz.Rect(other['bbox'])
                    if not intersection.is_empty and intersection.width > 1 and intersection.height > size*.2:
                        raise ValueError('The text would overlap another text box. Use a smaller size or shorter text.')
            if source:
                page.add_redact_annot(fitz.Rect(source['bbox']), fill=False, cross_out=False)
                page.apply_redactions(images=0, graphics=0)
                if alias.startswith('EditFont'):
                    page.insert_font(fontname=alias,fontbuffer=font.buffer)
            if text:
                page.insert_text(origin, text, fontname=alias, fontsize=size, color=rgb)
            if fallback and text:
                warning = 'Saved using a compatible font; the original font could not be reused.'
        elif action == 'image':
            image = base64.b64decode(request['image'], validate=True)
            if len(image) > 15*1024*1024:
                raise ValueError('Choose an image smaller than 15 MB.')
            rect = fitz.Rect(request['rect'])
            if rect.is_empty or not page.rect.contains(rect):
                raise ValueError('Place the image fully inside the page.')
            page.insert_image(rect, stream=image, keep_proportion=True)
        elif action == 'highlight':
            rect = fitz.Rect(request['rect']) & page.rect
            if rect.is_empty:
                raise ValueError('Drag across an area of the page.')
            annotation = page.add_highlight_annot(rect)
            annotation.set_colors(stroke=color(request.get('color', '#f4c84b')))
            annotation.set_opacity(.4)
            annotation.update()
        elif action == 'note':
            content = str(request.get('text', '')).strip()
            if not content:
                raise ValueError('Enter a note first.')
            page.add_text_annot(fitz.Point(request['point']), content, icon='Comment')
        else:
            raise ValueError('Unknown editing action.')
        return doc.tobytes(garbage=4, deflate=True), warning


class Handler(BaseHTTPRequestHandler):
    def respond(self, body, content_type='application/json', status=200, headers=None):
        if isinstance(body, (dict, list)):
            body = json.dumps(body).encode()
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    def check_host(self):
        return self.headers.get('Host', '').split(':')[0] in ('127.0.0.1', 'localhost')

    def do_GET(self):
        if not self.check_host():
            return self.respond({'error': 'Local access only.'}, status=403)
        url = urlparse(self.path)
        try:
            if url.path in ('/', '/app.js', '/objects.js', '/style.css'):
                filename = 'index.html' if url.path == '/' else url.path[1:]
                content = (ROOT/'static'/filename).read_bytes()
                if filename == 'index.html':
                    content = content.replace(b'__TOKEN__', TOKEN.encode())
                return self.respond(content, {'index.html':'text/html; charset=utf-8', 'app.js':'text/javascript; charset=utf-8', 'objects.js':'text/javascript; charset=utf-8', 'style.css':'text/css; charset=utf-8'}[filename])
            if url.path == '/health':
                return self.respond({'ok': True})
            query = parse_qs(url.query)
            if self.headers.get('X-Editor-Token') != TOKEN and query.get('token', [''])[0] != TOKEN:
                return self.respond({'error': 'Reload the editor to reconnect.'}, status=403)
            with LOCK:
                record = DOCS[query['id'][0]]
                record['seen'] = time.time()
                if url.path == '/api/page':
                    return self.respond(metadata(record, int(query['page'][0])))
                if url.path == '/api/render':
                    render_data = record['data']
                    if 'exclude_objects' in query:
                        render_data = render_objects(render_data,int(query['page'][0]),query['exclude_objects'][0].split(','))
                    with fitz.open(stream=render_data, filetype='pdf') as doc:
                        scale = min(2.0, max(.15, float(query.get('scale', ['1.5'])[0])))
                        page = doc[int(query['page'][0])]
                        if 'exclude' in query:
                            block = text_blocks(page)[int(query['exclude'][0])]
                            for rect in block['rects']:
                                page.add_redact_annot(fitz.Rect(rect),fill=False,cross_out=False)
                            page.apply_redactions(images=0,graphics=0)
                        scale = min(scale, 2400/max(page.rect.width, page.rect.height))
                        return self.respond(page.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False).tobytes('png'), 'image/png')
                if url.path == '/api/object':
                    index = int(query['page'][0]); identities = query['objects'][0].split(',')
                    items = [o for o in list_objects(record['data'],index) if o['id'] in identities]
                    clip = fitz.Rect(items[0]['bbox'])
                    for item in items[1:]: clip |= fitz.Rect(item['bbox'])
                    data = render_objects(record['data'],index,identities,only=True)
                    with fitz.open(stream=data,filetype='pdf') as doc:
                        scale = min(2,1200/max(clip.width,clip.height))
                        return self.respond(doc[index].get_pixmap(matrix=fitz.Matrix(scale,scale),clip=clip,alpha=True).tobytes('png'),'image/png')
                if url.path == '/api/font':
                    with fitz.open(stream=record['data'],filetype='pdf') as doc:
                        page = doc[int(query['page'][0])]
                        block = text_blocks(page)[int(query['block'][0])] if 'block' in query else None
                        family = query.get('family',[block['font'] if block else 'Arial'])[0]
                        bold,italic = flags(family)
                        bold = query.get('bold',[str(int(bold))])[0]=='1'
                        italic = query.get('italic',[str(int(italic))])[0]=='1'
                        _,font,_ = styled_font(doc,page,family,block['text'] if block else 'Preview',bold,italic,pick_font)
                        if font.buffer:
                            return self.respond(font.buffer,'application/octet-stream')
                    return self.respond({'error':'No embedded font.'},status=404)
                if url.path == '/api/download':
                    stem = Path(record['name']).stem
                    return self.respond(record['data'], 'application/pdf', headers={'Content-Disposition': "attachment; filename*=UTF-8''"+quote(stem+'-edited.pdf')})
            self.respond({'error': 'Not found.'}, status=404)
        except Exception as error:
            self.respond({'error': 'Document unavailable. Please open it again.' if isinstance(error, KeyError) else str(error)}, status=400)

    def do_POST(self):
        if not self.check_host() or self.headers.get('X-Editor-Token') != TOKEN:
            return self.respond({'error': 'Reload the editor to reconnect.'}, status=403)
        try:
            length = int(self.headers.get('Content-Length', 0))
            if length > LIMIT:
                return self.respond({'error': 'Choose a PDF smaller than 50 MB.'}, status=413)
            body = self.rfile.read(length)
            with LOCK:
                if self.path == '/api/open':
                    # Expire inactive documents rather than retaining files on disk.
                    for key in list(DOCS):
                        if time.time()-DOCS[key]['seen'] > 3600:
                            del DOCS[key]
                    if len(DOCS) >= 8:
                        raise ValueError('Too many open documents. Restart the app to clear the session.')
                    with fitz.open(stream=body, filetype='pdf') as doc:
                        if doc.needs_pass:
                            raise ValueError('This PDF is password-protected. Open an unlocked copy.')
                        if not len(doc):
                            raise ValueError('This PDF has no pages.')
                        for page in doc:
                            if page.rotation:
                                page.remove_rotation()
                        data = doc.tobytes(garbage=3, deflate=True)
                    record = {'id': secrets.token_hex(16), 'name': self.headers.get('X-Filename', 'document.pdf'), 'data': data,
                              'revision': 0, 'undo': [], 'redo': [], 'seen': time.time()}
                    from urllib.parse import unquote
                    record['name'] = unquote(record['name'])
                    DOCS[record['id']] = record
                    return self.respond(metadata(record))
                request = json.loads(body)
                record = DOCS[request['id']]
                record['seen'] = time.time()
                if self.path == '/api/close':
                    del DOCS[record['id']]
                    return self.respond({'ok': True})
                if request.get('revision') != record['revision']:
                    raise ValueError('The document changed. Reload this page before editing again.')
                warning = ''
                if self.path == '/api/edit':
                    data, warning = edit_pdf(record['data'], request)
                    record['undo'].append(record['data'])
                    while len(record['undo']) > 20 or sum(map(len, record['undo'])) > 200*1024*1024:
                        record['undo'].pop(0)
                    record['redo'].clear()
                    record['data'] = data
                elif self.path in ('/api/undo', '/api/redo'):
                    source, target = ('undo','redo') if self.path == '/api/undo' else ('redo','undo')
                    if record[source]:
                        record[target].append(record['data'])
                        record['data'] = record[source].pop()
                else:
                    raise ValueError('Unknown request.')
                record['revision'] += 1
                return self.respond(metadata(record, int(request.get('page', 0))) | {'warning': warning, 'selection': request.get('_result_objects',[])})
        except Exception as error:
            self.respond({'error': str(error) if not isinstance(error, KeyError) else 'Document unavailable. Please open it again.'}, status=400)


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    print(f'Paperwork is ready at http://127.0.0.1:{port}', flush=True)
    ThreadingHTTPServer(('127.0.0.1', port), Handler).serve_forever()
