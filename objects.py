"""Edit individual painting occurrences without changing shared PDF resources."""
import io
import math
import secrets
from decimal import Decimal

import pikepdf
import pymupdf as fitz


PATH = {'m', 'l', 'c', 'v', 'y', 'h', 're'}
PAINT = {'S', 's', 'f', 'F', 'f*', 'B', 'B*', 'b', 'b*'}
STATE = {'w', 'J', 'j', 'M', 'd', 'ri', 'i', 'gs', 'CS', 'cs', 'SC', 'SCN', 'sc', 'scn', 'G', 'g', 'RG', 'rg', 'K', 'k'}


def command(op, values=()):
    return (numbers(values), pikepdf.Operator(op))


def numbers(values):
    # PDF's default six-decimal float conversion causes drift when inverting large image matrices.
    return [Decimal(str(round(v,12))) if isinstance(v,float) else v for v in values]


def copy_dictionary(value):
    return pikepdf.Dictionary({str(k): v for k, v in value.items()})


def rgb(operands, op):
    if op.lower() not in ('g','rg','k'):
        return None
    values = [float(v) for v in operands]
    if op.lower() == 'g':
        values *= 3
    elif op.lower() == 'k':
        c, m, y, k = values
        values = [1-min(1, channel+k) for channel in (c, m, y)]
    elif op.lower() != 'rg':
        return None
    return '#' + ''.join(f'{round(max(0,min(1,v))*255):02x}' for v in values)


def geometry(data, index):
    with fitz.open(stream=data, filetype='pdf') as doc:
        page = doc[index]
        return fitz.Matrix(page.transformation_matrix), fitz.Rect(page.rect)


def scan(page, page_matrix, page_bounds):
    """Paths and image occurrences; existing Form XObjects stay grouped artwork."""
    instructions = pikepdf.parse_content_stream(page)
    resources = page.Resources
    state = {'ctm': fitz.Matrix(1, 1), 'commands': [], 'clips': [], 'fill': '#000000', 'stroke': '#000000', 'width': 1.0}
    stack, path, points, objects = [], [], [], []
    path_ctm, path_safe, pending_clip = None, True, None

    def clone(s):
        return {**s, 'ctm': fitz.Matrix(s['ctm']), 'commands': list(s['commands']), 'clips': list(s['clips'])}

    def path_box():
        if not points:
            return None
        return fitz.Rect(min(p.x for p in points), min(p.y for p in points), max(p.x for p in points), max(p.y for p in points))

    def add(kind, start, end, box, body, fill=None, stroke=None, own=None, safe=True):
        if box is None:
            return
        for clip in state['clips']:
            box &= clip['box']
        pdf_box = fitz.Rect(box)
        view_box = (box * page_matrix) & page_bounds
        if view_box.is_empty or view_box.is_infinite:
            return
        identity = str(own.get('/PWID')) if own is not None and own.get('/PWID') else f'paint-{end}'
        objects.append({'id': identity, 'kind': kind, 'bbox': list(view_box), 'fill': fill, 'stroke': stroke,
                        'editable': safe, 'reason': '' if safe else 'This path changes its coordinate system while drawing.',
                        'background': view_box.get_area() > page_bounds.get_area()*.8,
                        '_start': start, '_end': end, '_body': body, '_state': clone(state), '_box': pdf_box, '_own': own})

    for i, ins in enumerate(instructions):
        inline_image = isinstance(ins, pikepdf.ContentStreamInlineImage)
        if inline_image:
            add('image', i, i, fitz.Rect(0, 0, 1, 1)*state['ctm'], [ins])
            continue
        values, operator = ins
        op = str(operator)
        if op == 'q':
            stack.append(clone(state))
        elif op == 'Q':
            if stack:
                state = stack.pop()
                if path and tuple(state['ctm'])!=tuple(path_ctm): path_safe=False
        elif op == 'cm':
            state['ctm'] = fitz.Matrix(*[float(v) for v in values])*state['ctm']
            if path:
                path_safe = False
        elif op in STATE:
            state['commands'].append(ins)
            if op in ('g', 'rg', 'k', 'cs', 'sc', 'scn'):
                state['fill'] = rgb(values, op)
            elif op in ('G', 'RG', 'K', 'CS', 'SC', 'SCN'):
                state['stroke'] = rgb(values, op)
            elif op == 'w':
                state['width'] = float(values[0])
        elif op in PATH:
            if not path:
                path_ctm = fitz.Matrix(state['ctm'])
            path.append((i, ins))
            coords = [float(v) for v in values]
            if op == 're':
                x, y, w, h = coords
                points.extend(fitz.Point(a, b)*state['ctm'] for a, b in ((x,y),(x+w,y),(x+w,y+h),(x,y+h)))
            elif op != 'h':
                # Control points give a conservative bound for curved paths.
                points.extend(fitz.Point(coords[n],coords[n+1])*state['ctm'] for n in range(0,len(coords),2))
        elif op in ('W', 'W*'):
            pending_clip = op
        elif op in PAINT or op == 'n':
            box = path_box()
            if op in PAINT and path and box is not None:
                filled = op not in ('S','s')
                stroked = op in ('S','s','B','B*','b','b*')
                if stroked:
                    scale = max(math.hypot(state['ctm'].a,state['ctm'].b), math.hypot(state['ctm'].c,state['ctm'].d))
                    pad = max(.5,state['width']*scale/2)
                    box += (-pad,-pad,pad,pad)
                add('vector', path[0][0], i, box, [x[1] for x in path]+[ins],
                    state['fill'] if filled else None, state['stroke'] if stroked else None, safe=path_safe)
            if pending_clip and path and box is not None:
                state['clips'].append({'matrix': path_ctm, 'path': [x[1] for x in path], 'operator': pending_clip, 'box': box})
                if op in PAINT and objects and objects[-1]['_end']==i:
                    objects[-1]['editable'] = False
                    objects[-1]['reason'] = 'This painting also defines a clipping mask.'
            path, points, path_ctm, path_safe, pending_clip = [], [], None, True, None
        elif op == 'Do':
            obj = resources.get('/XObject', {}).get(values[0])
            if obj is None:
                continue
            if obj.get('/Subtype') == '/Image':
                add('image',i,i,fitz.Rect(0,0,1,1)*state['ctm'],[ins])
            elif obj.get('/Subtype') == '/Form':
                matrix = fitz.Matrix(*[float(v) for v in obj.get('/Matrix',[1,0,0,1,0,0])])
                box = fitz.Rect([float(v) for v in obj.get('/PWBounds',obj.BBox)])*matrix*state['ctm']
                kind = str(obj.get('/PWKind','artwork'))
                fill = str(obj.get('/PWFill')) if obj.get('/PWFill') else None
                stroke = str(obj.get('/PWStroke')) if obj.get('/PWStroke') else None
                add(kind,i,i,box,[ins],fill,stroke,own=obj if obj.get('/PWID') else None)
    return instructions, resources, objects


def list_objects(data, index):
    matrix, bounds = geometry(data,index)
    with pikepdf.Pdf.open(io.BytesIO(data)) as pdf:
        _, _, objects = scan(pdf.pages[index],matrix,bounds)
        counts = {}
        result = []
        for item in objects:
            kind = item['kind']; counts[kind] = counts.get(kind,0)+1
            label = 'Image' if kind=='image' else 'Vector' if kind=='vector' else 'Grouped artwork'
            result.append({k:v for k,v in item.items() if not k.startswith('_')} | {'name': f'{label} {counts[kind]}'})
        return result


def snapshot(item):
    state = item['_state']; commands = [command('q')]
    for clip in state['clips']:
        cm = clip['matrix']
        commands += [command('cm',cm), *clip['path'], command(clip['operator']), command('n'), command('cm',~cm)]
    commands += state['commands'] + [command('cm',state['ctm'])] + item['_body'] + [command('Q')]
    return commands


def remove_paints(instructions, items):
    """Keep state and clipping operators; remove only the selected painting."""
    ends = {item['_end'] for item in items}
    return [command('n') if i in ends and not isinstance(ins,pikepdf.ContentStreamInlineImage) and str(ins[1]) in PAINT else ins
            for i,ins in enumerate(instructions) if i not in ends or (not isinstance(ins,pikepdf.ContentStreamInlineImage) and str(ins[1]) in PAINT)]


def save(pdf):
    output = io.BytesIO(); pdf.save(output)
    return output.getvalue()


def render_objects(data, index, ids, only=False):
    matrix, bounds = geometry(data,index)
    with pikepdf.Pdf.open(io.BytesIO(data)) as pdf:
        page = pdf.pages[index]
        instructions, _, objects = scan(page,matrix,bounds)
        items = [o for o in objects if o['id'] in ids]
        if len(items)!=len(ids):
            raise ValueError('The object changed. Select it again.')
        commands = [c for item in items for c in snapshot(item)] if only else remove_paints(instructions,items)
        page.Contents = pdf.make_stream(pikepdf.unparse_content_stream(commands))
        if only:
            page.obj.Annots = pikepdf.Array()
        return save(pdf)


def edit_objects(data, request, color):
    index = int(request['page']); matrix, bounds = geometry(data,index)
    ids = request.get('objects',[])
    if not isinstance(ids,list) or not ids or len(ids)>500:
        raise ValueError('Select one or more objects.')
    with pikepdf.Pdf.open(io.BytesIO(data)) as pdf:
        page = pdf.pages[index]
        instructions, resources, objects = scan(page,matrix,bounds)
        items = [o for o in objects if o['id'] in ids]
        if len(items)!=len(set(ids)) or any(not o['editable'] for o in items):
            raise ValueError('This object cannot be edited safely. Select another object.')
        operation = request.get('operation','transform')
        if operation not in ('transform','style','delete','front','back'):
            raise ValueError('Unknown object operation.')
        if operation=='delete':
            page.Contents = pdf.make_stream(pikepdf.unparse_content_stream(remove_paints(instructions,items)))
            return save(pdf), ''
        source = fitz.Rect(items[0]['bbox'])
        for item in items[1:]: source |= fitz.Rect(item['bbox'])
        target = fitz.Rect(request.get('rect',source))
        if not all(math.isfinite(v) for v in target) or target.width<1 or target.height<1 or not (bounds+(-.01,-.01,.01,.01)).contains(target):
            raise ValueError('Keep the object inside the page, with width and height of at least 1 pt.')
        sx, sy = target.width/source.width, target.height/source.height
        view_delta = fitz.Matrix(sx,0,0,sy,target.x0-source.x0*sx,target.y0-source.y0*sy)
        delta = matrix*view_delta*~matrix
        original_resources = resources
        resources = copy_dictionary(resources)
        xobjects = copy_dictionary(resources.get('/XObject',pikepdf.Dictionary()))
        resources.XObject = xobjects; page.Resources = resources
        replacements, root_commands = {}, []
        request['_result_objects'] = []
        for item in items:
            own = item['_own']; identity = item['id'] if own is not None else 'object-'+secrets.token_hex(8)
            request['_result_objects'].append(identity)
            if own is not None:
                body = pikepdf.parse_content_stream(own)
                form_resources = own.get('/Resources',pikepdf.Dictionary())
                form_box = own.BBox
                object_bounds = own.get('/PWBounds',own.BBox)
                old_matrix = fitz.Matrix(*[float(v) for v in own.get('/Matrix',[1,0,0,1,0,0])])
                context = item['_state']['ctm']
                transform = old_matrix*context*delta
            else:
                body = snapshot(item)
                form_resources = original_resources
                form_box = list(item['_box'])
                object_bounds = list(item['_box'])
                if item['kind']=='vector':
                    cm = item['_state']['ctm']
                    scale = max(math.hypot(cm.a,cm.b),math.hypot(cm.c,cm.d))
                    miter = max([10]+[float(ins[0][0]) for ins in item['_state']['commands'] if str(ins[1])=='M'])
                    pad = max(2,item['_state']['width']*scale*miter)
                    form_box = list(item['_box']+(-pad,-pad,pad,pad))
                transform = delta
            fill, stroke = item['fill'], item['stroke']
            if operation=='style':
                if item['kind']!='vector':
                    raise ValueError('Color controls apply to vector paths. Grouped artwork keeps its internal colors.')
                if 'fill' in request and fill is not None: fill = str(request['fill']); color(fill)
                if 'stroke' in request and stroke is not None: stroke = str(request['stroke']); color(stroke)
                # Our vector forms contain exactly one path painting, so overrides stay local.
                for n in range(len(body)-1,-1,-1):
                    if not isinstance(body[n],pikepdf.ContentStreamInlineImage) and str(body[n][1]) in PAINT:
                        overrides = ([command('rg',color(fill))] if fill else []) + ([command('RG',color(stroke))] if stroke else [])
                        body[n:n] = overrides
                        break
            form = pdf.make_stream(pikepdf.unparse_content_stream(body))
            form.Type = pikepdf.Name.XObject; form.Subtype = pikepdf.Name.Form
            form.BBox = pikepdf.Array(numbers(form_box)); form.Matrix = pikepdf.Array(numbers(transform)); form.Resources = form_resources
            form.PWBounds = pikepdf.Array(numbers(object_bounds))
            form.PWID = identity; form.PWKind = item['kind']
            if fill: form.PWFill = fill
            if stroke: form.PWStroke = stroke
            name = pikepdf.Name('/PW'+secrets.token_hex(8)); xobjects[name] = form
            replacement = [command('q'),command('cm',~item['_state']['ctm']),command('Do',[name]),command('Q')]
            replacements[item['_end']] = replacement
            root_commands += [command('q'),command('Do',[name]),command('Q')]
        output = []
        for n,ins in enumerate(instructions):
            if n not in replacements:
                output.append(ins); continue
            if not isinstance(ins,pikepdf.ContentStreamInlineImage) and str(ins[1]) in PAINT:
                output.append(command('n'))
            if operation not in ('front','back'):
                output += replacements[n]
        if operation in ('front','back'):
            isolated = [command('q'),*output,command('Q')]
            output = root_commands+isolated if operation=='back' else isolated+root_commands
        page.Contents = pdf.make_stream(pikepdf.unparse_content_stream(output))
        warning = 'Objects keep their original clipping masks.' if any(o['_state']['clips'] for o in items) else ''
        return save(pdf), warning
