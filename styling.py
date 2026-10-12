"""PDF typography, rich paragraph layout, and solid page backgrounds."""
import io
import math
import os
import re
import secrets
from pathlib import Path

import pymupdf as fitz
import pikepdf


def flags(name):
    name = name.lower()
    return 'bold' in name, 'italic' in name or 'oblique' in name


SYSTEM_FONTS = {
    'Arial': ('arial.ttf', 'arialbd.ttf', 'ariali.ttf', 'arialbi.ttf'),
    'Times New Roman': ('times.ttf', 'timesbd.ttf', 'timesi.ttf', 'timesbi.ttf'),
    'Georgia': ('georgia.ttf', 'georgiab.ttf', 'georgiai.ttf', 'georgiaz.ttf'),
    'Courier New': ('cour.ttf', 'courbd.ttf', 'couri.ttf', 'courbi.ttf'),
    'Segoe UI': ('segoeui.ttf', 'segoeuib.ttf', 'segoeuii.ttf', 'segoeuiz.ttf'),
}


def styled_font(doc, page, family, text, bold, italic, pick_font):
    if family in SYSTEM_FONTS:
        path = Path(os.environ.get('WINDIR', 'C:/Windows'))/'Fonts'/SYSTEM_FONTS[family][int(bold)+2*int(italic)]
        if not path.exists():
            raise ValueError(f'{family} is not installed on this computer.')
        font = fitz.Font(fontfile=str(path))
        if not all(font.has_glyph(ord(c)) for c in text if not c.isspace()):
            raise ValueError(f'{family} cannot display every character in this text. Choose another font.')
        alias = 'EditFont'+secrets.token_hex(4)
        page.insert_font(fontname=alias,fontfile=str(path))
        return alias,font,False
    original_bold, original_italic = flags(family)
    if (bold,italic)==(original_bold,original_italic):
        return pick_font(doc,page,family,text)
    base = re.sub(r'(?i)[\s-]*(bolditalic|boldoblique|bold|italic|oblique|regular|book)$','',family)
    name = base+('-Bold' if bold else '')+('Italic' if italic and bold else '-Italic' if italic else '')
    return pick_font(doc,page,name,text)


def rich_lines(runs, width):
    """Wrap words across style boundaries, retaining explicit and blank lines."""
    tokens = []
    for run in runs:
        for part in re.findall(r'\n|[^\S\n]+|[^\s]+',run['text'].replace('\r\n','\n').replace('\r','\n')):
            kind = 'newline' if part=='\n' else 'space' if part.isspace() else 'word'
            fragment = dict(run,text=part)
            if tokens and kind!='newline' and tokens[-1][0]==kind:
                tokens[-1][1].append(fragment)
            else:
                tokens.append((kind,[fragment]))
    lines,current,length = [],[],0
    def measure(fragment):
        return fragment['font_object'].text_length(fragment['text'],fontsize=fragment['size'])
    def flush():
        nonlocal current,length
        while current and current[-1]['text'].isspace():
            current.pop()
        merged=[]
        for fragment in current:
            if merged and all(merged[-1][key]==fragment[key] for key in ('alias','size','color','underline')):
                merged[-1]['text']+=fragment['text']
            else:
                merged.append(dict(fragment))
        lines.append(merged)
        current,length = [],0
    for kind,fragments in tokens:
        if kind=='newline':
            flush()
            continue
        token_width=sum(measure(f) for f in fragments)
        if kind=='space':
            if current:
                current.extend(fragments);length+=token_width
            continue
        if current and length+token_width>width+.01:
            flush()
        if token_width<=width+.01:
            current.extend(fragments);length+=token_width
        else:
            for fragment in fragments:
                pending = ''
                for char in fragment['text']:
                    advance=measure(dict(fragment,text=char))
                    if advance>width:
                        raise ValueError('The text area is too narrow for this font size.')
                    if length+advance>width+.01:
                        if pending:
                            current.append(dict(fragment,text=pending));pending=''
                        flush()
                    pending+=char;length+=advance
                if pending:
                    current.append(dict(fragment,text=pending))
    flush()
    return lines


def write_rich(doc,page,source,request,pick_font,color,all_spans):
    size = float(request.get('size',source['size'] if source else 14))
    width = float(request['width'])
    spacing = float(request.get('spacing',source['lineheight']/source['size'] if source else 1.35))
    align = request.get('align','left')
    if not all(math.isfinite(v) for v in (size,width,spacing)) or not 4<=size<=144 or width<5 or not 1<=spacing<=3 or align not in ('left','center','right'):
        raise ValueError('Choose a valid font size, width, alignment, and line spacing.')
    point = fitz.Point(source['origin'] if source else request['point'])
    default_font = request.get('font',source['font'] if source else 'Arial')
    raw = request.get('runs')
    if raw is None:
        bold,italic=flags(default_font)
        raw=[{'text':str(request.get('text','')),'font':default_font,'bold':request.get('bold',bold),'italic':request.get('italic',italic)}]
    if not isinstance(raw,list) or len(raw)>4000 or sum(len(str(r.get('text',''))) for r in raw)>30000:
        raise ValueError('This paragraph has too much text or formatting.')
    prepared,fonts,warnings=[],{},set()
    for raw_run in raw:
        text=str(raw_run.get('text',''))
        if not text:
            continue
        family=str(raw_run.get('font',default_font))
        bold,italic=flags(family)
        bold=bool(raw_run.get('bold',bold));italic=bool(raw_run.get('italic',italic))
        run_size=float(raw_run.get('size',size))
        if not math.isfinite(run_size) or not 4<=run_size<=144:
            raise ValueError('Choose a font size between 4 and 144.')
        key=(family,bold,italic)
        fonts.setdefault(key,{'text':''})['text']+=text
        prepared.append({'text':text,'font':family,'bold':bold,'italic':italic,'size':run_size,
                         'color':color(raw_run.get('color',request.get('color','#242a28'))),'underline':bool(raw_run.get('underline',False)),'key':key})
    for (family,bold,italic),value in fonts.items():
        alias,font,fallback=styled_font(doc,page,family,value['text'],bold,italic,pick_font)
        value.update(alias=alias,font=font)
        if fallback:
            warnings.add('A compatible font was used where the original font or style was unavailable.')
    for run in prepared:
        value=fonts[run['key']];run.update(alias=value['alias'],font_object=value['font'])
    lines=rich_lines(prepared,width)
    source_rects=source['rects'] if source else []
    others=[s for s in all_spans(page) if not any(all(abs(a-b)<.01 for a,b in zip(s['bbox'],r)) for r in source_rects)]
    positions=[];baseline=point.y
    for i,line in enumerate(lines):
        length=sum(r['font_object'].text_length(r['text'],fontsize=r['size']) for r in line)
        x=point.x+(width-length)*(0 if align=='left' else .5 if align=='center' else 1)
        for run in line:
            font=run['font_object'];advance=font.text_length(run['text'],fontsize=run['size'])
            asc=font.ascender/(font.ascender-font.descender);desc=-font.descender/(font.ascender-font.descender)
            target=fitz.Rect(x,baseline-run['size']*asc,x+advance,baseline+run['size']*desc)
            if not page.rect.contains(target):
                raise ValueError('The text reaches the page edge. Widen the block, reduce the size, or shorten the text.')
            for other in others:
                overlap=target & fitz.Rect(other['bbox'])
                if not overlap.is_empty and overlap.width>1 and overlap.height>run['size']*.15:
                    raise ValueError('The paragraph reaches another text block. Widen it, reduce the size, or shorten the text.')
            positions.append((run,x,baseline,advance));x+=advance
        baseline+=max([size]+[r['size'] for r in line])*spacing
    if source:
        source_box=fitz.Rect(source['bbox'])+(-3,-3,3,3)
        for annotation in list(page.annots() or []):
            if annotation.type[1]=='Underline' and source_box.contains(annotation.rect):
                page.delete_annot(annotation)
        for rect in source_rects:
            page.add_redact_annot(fitz.Rect(rect),fill=False,cross_out=False)
        page.apply_redactions(images=0,graphics=0)
    for value in fonts.values():
        if value['alias'].startswith('EditFont'):
            page.insert_font(fontname=value['alias'],fontbuffer=value['font'].buffer)
    for run,x,y,advance in positions:
        page.insert_text((x,y),run['text'],fontname=run['alias'],fontsize=run['size'],color=run['color'])
        if run['underline'] and run['text'].strip():
            font=run['font_object'];asc=font.ascender/(font.ascender-font.descender);desc=-font.descender/(font.ascender-font.descender)
            annotation=page.add_underline_annot(fitz.Rect(x,y-run['size']*asc,x+advance,y+run['size']*desc))
            annotation.set_colors(stroke=run['color']);annotation.update()
    return ' '.join(sorted(warnings))


def recolor_background(data,indices,rgb):
    """Change only single rectangular, page-covering fills; keep other artwork."""
    touched=set()
    with pikepdf.Pdf.open(io.BytesIO(data)) as pdf:
        for index in indices:
            page=pdf.pages[index]
            bounds=[float(v) for v in page.obj.get('/CropBox',page.obj.get('/MediaBox'))]
            ctm=fitz.Matrix(1,1);stack=[];rects=[];complex_path=False;clipped=False;output=[]
            for instruction in pikepdf.parse_content_stream(page):
                if isinstance(instruction,pikepdf.ContentStreamInlineImage):
                    output.append(instruction);continue
                operands,operator=instruction;op=str(operator)
                if op=='q':stack.append((fitz.Matrix(ctm),clipped))
                elif op=='Q':ctm,clipped=stack.pop() if stack else (fitz.Matrix(1,1),False)
                elif op=='cm':ctm=fitz.Matrix(*[float(v) for v in operands])*ctm
                elif op=='re':
                    x,y,w,h=[float(v) for v in operands]
                    rects.append(fitz.Rect(x,y,x+w,y+h)*ctm)
                    if abs(ctm.b)>.00001 or abs(ctm.c)>.00001:complex_path=True
                elif op in ('m','l','c','v','y'):complex_path=True
                if op in ('W','W*'):
                    target=fitz.Rect(bounds)
                    clipped=clipped or complex_path or len(rects)!=1 or not all(abs(a-b)<2 for a,b in zip(rects[0],target))
                if op in ('f','F','f*','B','B*','b','b*'):
                    target=fitz.Rect(bounds)
                    covers=not clipped and not complex_path and len(rects)==1 and all(abs(a-b)<max(2,target.width*.005) for a,b in zip(rects[0],target))
                    if covers:
                        output.extend([([],pikepdf.Operator('q')),(list(rgb),pikepdf.Operator('rg')),instruction,([],pikepdf.Operator('Q'))])
                        touched.add(index)
                    else:output.append(instruction)
                    rects=[];complex_path=False
                else:
                    output.append(instruction)
                    if op in ('S','s','n'):
                        rects=[];complex_path=False
            page.obj.Contents=pdf.make_stream(pikepdf.unparse_content_stream(output))
        buffer=io.BytesIO();pdf.save(buffer)
        return buffer.getvalue(),touched


def document_style(data,request,pick_font,color,all_spans):
    indices=[int(request['page'])] if request.get('scope')=='page' else None
    background=request.get('background');text_color=request.get('text_color');family=request.get('font')
    if not background and not text_color and not family:
        raise ValueError('Choose a background, text color, or font to apply.')
    with fitz.open(stream=data,filetype='pdf') as doc:
        if indices is None:indices=list(range(len(doc)))
    touched=set();warnings=[]
    if background:
        data,touched=recolor_background(data,indices,color(background))
    with fitz.open(stream=data,filetype='pdf') as doc:
        skipped=0;fitted=0
        for index in indices:
            page=doc[index]
            if background and index not in touched:
                has_covering=any(d.get('fill') and (d['rect'] & page.rect).get_area()>page.rect.get_area()*.95 for d in page.get_drawings())
                has_image=any((fitz.Rect(image['bbox']) & page.rect).get_area()>page.rect.get_area()*.95 for image in page.get_image_info())
                if has_covering or has_image:
                    raise ValueError(f'Page {index+1} has a background made from an image or complex artwork. Its solid background cannot be changed safely.')
                page.draw_rect(page.rect,color=None,fill=color(background),overlay=False)
            if not text_color and not family:
                continue
            source=all_spans(page);prepared=[];fontcache={};cache={}
            for span in source:
                bold,italic=flags(span['font']);chosen=family or span['font']
                cache.setdefault((chosen,bold,italic),'')
                cache[(chosen,bold,italic)]+=span['text']
            for key,text in cache.items():
                chosen,bold,italic=key
                alias,font,fallback=styled_font(doc,page,chosen,text,bold,italic,pick_font)
                cache[key]=(alias,font,fallback)
                fontcache[alias]=font
            for span in source:
                if not span['editable']:
                    skipped+=1;continue
                bold,italic=flags(span['font'])
                chosen=family or span['font']
                alias,font,fallback=cache[(chosen,bold,italic)]
                size=span['size']
                measured=font.text_length(span['text'],fontsize=size)
                # Preserve line positions and hierarchy; fit a wider replacement to its original region.
                if family and measured>span['bbox'][2]-span['bbox'][0]+1:
                    size*=max(1,span['bbox'][2]-span['bbox'][0])/measured;fitted+=1
                rgb=color(text_color) if text_color else tuple(((span['color']>>shift)&255)/255 for shift in (16,8,0))
                prepared.append((span,alias,size,rgb))
            for span,alias,size,rgb in prepared:
                page.add_redact_annot(fitz.Rect(span['bbox']),fill=False,cross_out=False)
            if prepared:
                page.apply_redactions(images=0,graphics=0)
            for alias,font in fontcache.items():
                if alias.startswith('EditFont'):
                    page.insert_font(fontname=alias,fontbuffer=font.buffer)
            for span,alias,size,rgb in prepared:
                page.insert_text(span['origin'],span['text'],fontname=alias,fontsize=size,color=rgb)
        if skipped:warnings.append(f'{skipped} rotated text spans retained their original styling.')
        if fitted:warnings.append('Wider text was fitted into its original space to preserve the layout.')
        return doc.tobytes(garbage=4,deflate=True),' '.join(warnings)
