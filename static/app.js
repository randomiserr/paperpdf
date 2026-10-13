'use strict';

// Keep the visible bitmap intact while decoding. Paint only tiles whose pixels changed.
class PageRenderer {
  constructor(canvas) {
    this.canvas=canvas;
    this.context=canvas.getContext('2d');
    this.buffer=document.createElement('canvas');
    this.bufferContext=this.buffer.getContext('2d',{willReadFrequently:true});
    this.images=new Map();
    this.pixels=null;
  }
  load(url) {
    if(!this.images.has(url)) {
      const image=new Image();image.src=url;
      const ready=image.decode().then(()=>image).catch(error=>{this.images.delete(url);throw error;});
      this.images.set(url,ready);
      if(this.images.size>4)this.images.delete(this.images.keys().next().value);
    }
    return this.images.get(url);
  }
  paint(image) {
    const width=image.naturalWidth,height=image.naturalHeight;
    this.buffer.width=width;this.buffer.height=height;
    this.bufferContext.drawImage(image,0,0);
    const next=this.bufferContext.getImageData(0,0,width,height);
    const pixels=new Uint32Array(next.data.buffer);
    if(this.canvas.width!==width||this.canvas.height!==height||!this.pixels) {
      this.canvas.width=width;this.canvas.height=height;
      this.context.drawImage(image,0,0);
    } else {
      const tile=64;
      for(let y=0;y<height;y+=tile)for(let x=0;x<width;x+=tile) {
        const right=Math.min(x+tile,width),bottom=Math.min(y+tile,height);
        let changed=false;
        for(let row=y;row<bottom&&!changed;row++)for(let col=x;col<right;col++) {
          const index=row*width+col;
          if(pixels[index]!==this.pixels[index]){changed=true;break;}
        }
        if(changed)this.context.drawImage(image,x,y,right-x,bottom-y,x,y,right-x,bottom-y);
      }
    }
    this.pixels=pixels;
  }
}

const $ = id => document.getElementById(id);
const token = document.querySelector('meta[name="editor-token"]').content;
let doc = null, tool = 'select', selected = null, placement = null;
let zoom = 1, busy = false, dirty = false, pageRequest = 0, drag = null, toastTimer;
let inline = null, inlineSequence = 0;
let savePending = false;
const pageRenderer=new PageRenderer($('page-image'));
let pageBaseImage=null;
const settings = {
  select: {title:'Selection', instructions:'Select text or an object to edit.', hint:'Shift-click for multiple objects · Esc to deselect'},
  edit: {title:'Text', hint:'Click a paragraph to edit'},
  text: {title:'Text', hint:'Click the page to add text'},
  image: {title:'Image', hint:''},
  objects: {title:'Objects', hint:'Drag to move · Corners resize · Shift-click for multiple'},
  highlight: {title:'Highlight', hint:'Drag over the area to highlight'},
  appearance: {title:'Appearance', hint:''},
  find: {title:'Find & redact', hint:'Find exact text, or draw an area to remove sensitive information'},
  signature: {title:'Signature', hint:'Save a signature, then click the page to place it'},
  date: {title:'Date', hint:'Click an empty space to insert the date'},
  note: {title:'Note', hint:'Click the page to place a note'}
};
function setInstructions(text='') {
  $('instructions').textContent=text;$('instructions').hidden=!text;
}
function notify(message, error=false) {
  clearTimeout(toastTimer); $('toast').textContent=message; $('toast').classList.toggle('error',error); $('toast').hidden=false;
  toastTimer=setTimeout(()=>$('toast').hidden=true,error?9000:5000);
}
async function api(path, options={}) {
  const response=await fetch(path,{...options,headers:{'X-Editor-Token':token,...options.headers}});
  if(!response.ok){let info;try{info=await response.json();}catch{info={error:'The editor could not complete this request.'};}throw new Error(info.error);}
  return response.json();
}
async function working(fn,{overlay=true,rect=null,status='Updating page'}={}) {
  if(busy)return;
  busy=true;$('busy').hidden=!overlay;
  const editor=inline;
  if(!overlay){
    $('page-surface').setAttribute('aria-busy','true');
    document.querySelector('.inspector').inert=true;document.querySelector('.toolbar').inert=true;
    if(editor){editor.input.contentEditable='false';editor.frame.querySelectorAll('button').forEach(button=>button.disabled=true);}
    if(rect){
      const x=Math.min($('page-surface').clientWidth-16,Math.max(16,rect[2]*zoom));
      const y=Math.min($('page-surface').clientHeight-16,Math.max(16,rect[1]*zoom));
      Object.assign($('edit-progress').style,{left:x+'px',top:y+'px'});$('edit-progress').hidden=false;
    }else {$('activity-label').textContent=status;$('save-status').hidden=false;}
  }
  try{await fn();return true;}catch(error){notify(error.message||'Could not complete the edit. Try again.',true);return false;}
  finally{
    busy=false;$('busy').hidden=true;$('edit-progress').hidden=true;$('save-status').hidden=true;
    $('page-surface').removeAttribute('aria-busy');
    document.querySelector('.inspector').inert=false;document.querySelector('.toolbar').inert=false;
    if(editor&&inline===editor){editor.input.contentEditable='true';editor.frame.querySelectorAll('button').forEach(button=>button.disabled=false);}
  }
}
function renderURL(page,scale=1.5,document=doc){return `/api/render?id=${document.id}&page=${page}&scale=${scale}&revision=${document.revision}&token=${encodeURIComponent(token)}`;}
function resetSelection({restore=true}={}){
  clearObjects();
  inlineSequence++;
  if(inline){inline.observer.disconnect();inline.frame.remove();inline=null;if(restore&&pageBaseImage)pageRenderer.paint(pageBaseImage);}
  selected=null;placement=null;$('edit-form').hidden=true;$('inline-settings').hidden=true;
  document.querySelectorAll('.text-hit.selected').forEach(el=>el.classList.remove('selected'));
  $('hint').textContent=doc?settings[tool].hint:'';
  syncSelectionUI();
}
function syncSelectionUI(){
  $('object-library').hidden=tool==='select';
  if(tool!=='select')return;
  const items=chosenObjects(),kind=items.length===1?items[0].kind:items.length?'objects':inline?'text':null;
  $('objects-options').hidden=!items.length;
  const {title,instructions,hint}=settings.select;
  $('inspector-title').textContent=kind==='text'?'Text':kind==='image'?'Image':kind==='vector'?'Vector':kind==='artwork'?'Artwork':kind?`${items.length} objects`:title;
  setInstructions(kind?'':instructions);
  $('hint').textContent=kind==='text'?'Ctrl+Enter to apply · Esc to cancel':kind?'Drag to move · Corners resize · Delete to remove':doc?hint:'';
}
async function setTool(value){
  if(inline&&!await finishInline())return;
  tool=value;resetSelection();
  document.querySelectorAll('[data-tool]').forEach(el=>{el.classList.toggle('active',el.dataset.tool===tool);el.setAttribute('aria-pressed',String(el.dataset.tool===tool));});
  const {title,instructions,hint}=settings[tool];
  $('inspector-title').textContent=title;setInstructions(instructions);$('hint').textContent=doc?hint:'';
  $('appearance-options').hidden=tool!=='appearance';
  $('image-options').hidden=tool!=='image';$('highlight-options').hidden=tool!=='highlight';
  $('objects-options').hidden=tool!=='objects';
  syncBasicTools();
  $('interaction-layer').style.cursor=['select','edit','objects'].includes(tool)?'default':'crosshair';
  syncSelectionUI();
  if(doc)drawHits();
}
function updateUI(){
  $('apply-appearance').disabled=false;
  $('filename').textContent=doc.name;$('file-status').textContent=dirty?'Modified':'';
  $('page-count').textContent=doc.count;$('page-indicator').textContent=`${doc.page+1} / ${doc.count}`;
  $('prev').disabled=doc.page===0;$('next').disabled=doc.page===doc.count-1;$('undo').disabled=!doc.undo;$('redo').disabled=!doc.redo;$('download').disabled=false;
  $('scan-notice').hidden=doc.spans.length>0;$('hint').textContent=settings[tool].hint;
  document.querySelectorAll('.thumbnail').forEach((el,i)=>{el.classList.toggle('active',i===doc.page);el.setAttribute('aria-current',String(i===doc.page));});
  syncSelectionUI();
}
function fit(){if(!doc)return;zoom=Math.min(1.5,Math.max(.25,($('canvas-scroll').clientWidth-64)/doc.width));layout();}
function layout(){
  if(!doc)return;$('page-surface').style.width=doc.width*zoom+'px';$('page-surface').style.height=doc.height*zoom+'px';
  $('zoom-label').textContent=Math.round(zoom*100)+'%';if(!inline)drawHits();
}
function drawHits(){
  $('interaction-layer').replaceChildren();
  if(tool==='find'){drawFindMatches();return;}
  if(tool==='objects'||tool==='select'){drawObjectHits();if(tool==='objects')return;}
  if(tool!=='edit'&&tool!=='select')return;
  for(const span of doc.blocks||[]){
    if(!span.editable)continue;
    const button=document.createElement('button');button.className='text-hit';button.title=span.text;button.setAttribute('aria-label',`Edit: ${span.text}`);
    const [x0,y0,x1,y1]=span.bbox;Object.assign(button.style,{left:x0*zoom+'px',top:y0*zoom+'px',width:(x1-x0)*zoom+'px',height:(y1-y0)*zoom+'px'});
    if(tool==='select')button.style.zIndex='1';
    button.setAttribute('aria-label',`${tool==='select'?'Select text':'Edit'}: ${span.text}`);
    button.onpointerdown=e=>e.stopPropagation();
    button.onclick=async e=>{e.stopPropagation();if(busy)return;if(!await finishInline())return;const current=doc.blocks.find(b=>Math.abs(b.origin[0]-span.origin[0])<1&&Math.abs(b.origin[1]-span.origin[1])<1);if(current)await startInline(current);};
    $('interaction-layer').append(button);
  }
}
// Rich text stays on the document; the sidebar only contains formatting controls.
const editorFontCache=new Map();
function styleOf(node, fallback=null){
  const result={...(fallback||inline?.defaultStyle||{font:'Arial',size:14,color:'#242a28',bold:false,italic:false,underline:false})};
  const parents=[];
  for(let el=node.nodeType===3?node.parentElement:node;el&&el!==inline?.input;el=el.parentElement)parents.push(el);
  for(const el of parents.reverse()){
    for(const key of ['font','size','color','bold','italic','underline']){
      if(el.dataset?.[key]!==undefined)result[key]=['bold','italic','underline'].includes(key)?el.dataset[key]==='true':key==='size'?Number(el.dataset[key]):el.dataset[key];
    }
    if(['B','STRONG'].includes(el.tagName))result.bold=true;
    if(['I','EM'].includes(el.tagName))result.italic=true;
    if(el.tagName==='U')result.underline=true;
  }
  return result;
}
function richRuns(root=inline?.input, fallback=null){
  const runs=[];
  function emit(text,style){if(!text)return;const last=runs.at(-1);if(last&&['font','size','color','bold','italic','underline'].every(k=>last[k]===style[k]))last.text+=text;else runs.push({...style,text});}
  function visit(node){
    if(node.nodeType===3){emit(node.nodeValue,styleOf(node,fallback));return;}
    if(node.nodeType!==1&&node.nodeType!==11)return;
    if(node.nodeName==='BR'){emit('\n',styleOf(node,fallback));return;}
    const block=node!==root&&['DIV','P'].includes(node.nodeName);
    if(block&&runs.length&&!runs.at(-1).text.endsWith('\n'))emit('\n',styleOf(node,fallback));
    for(const child of node.childNodes)visit(child);
    if(block&&node.nextSibling&&runs.length&&!runs.at(-1).text.endsWith('\n'))emit('\n',styleOf(node,fallback));
  }
  visit(root);return runs;
}
async function loadEditorFont(style){
  const key=[doc.id,doc.page,doc.revision,style.font,style.bold,style.italic].join('|');
  if(!editorFontCache.has(key)){
    const name='PdfFace'+editorFontCache.size;
    const url=`/api/font?id=${doc.id}&page=${doc.page}${inline?.block?'&block='+inline.block.id:''}&family=${encodeURIComponent(style.font)}&bold=${Number(style.bold)}&italic=${Number(style.italic)}&token=${encodeURIComponent(token)}`;
    editorFontCache.set(key,new FontFace(name,`url(${url})`).load().then(font=>{document.fonts.add(font);return font.family;}).catch(()=>null));
  }
  return editorFontCache.get(key);
}
function richFragment(runs){
  const fragment=document.createDocumentFragment(),sequence=inlineSequence;
  for(const run of runs){
    const chunks=run.text.split('\n');
    chunks.forEach((text,index)=>{
      if(index)fragment.append(document.createElement('br'));
      if(!text)return;
      const el=document.createElement('span');el.textContent=text;
      for(const key of ['font','size','color','bold','italic','underline'])el.dataset[key]=String(run[key]);
      const fallback=/serif|times|georgia/i.test(run.font)?'Georgia,serif':/mono|courier/i.test(run.font)?'monospace':'Arial,sans-serif';
      Object.assign(el.style,{fontFamily:fallback,fontSize:run.size*zoom+'px',color:run.color,fontWeight:run.bold?'700':'400',fontStyle:run.italic?'italic':'normal',textDecoration:run.underline?'underline':'none'});
      loadEditorFont(run).then(family=>{if(family&&sequence===inlineSequence&&el.isConnected){el.style.fontFamily=family;el.style.fontWeight='400';el.style.fontStyle='normal';}});
      fragment.append(el);
    });
  }
  return fragment;
}
function rememberSelection(){
  if(!inline)return;
  if(document.querySelector('.inspector').contains(document.activeElement))return;
  const selection=window.getSelection();
  if(!selection.rangeCount)return;
  const range=selection.getRangeAt(0);
  if(inline.input.contains(range.startContainer)&&inline.input.contains(range.endContainer)){
    inline.range=range.cloneRange();const style=selectionStyle(range);
    $('text-scope').textContent=range.collapsed?'Whole paragraph':'Selected words';
    for(const key of ['bold','italic','underline'])$('format-'+key).setAttribute('aria-pressed',String(style[key]));
    const choices=Array.from($('inline-family').options).map(o=>o.value);
    $('inline-family').value=choices.includes(style.font)?style.font:'original';
    $('inline-size').value=Math.round(style.size*10)/10;$('inline-color').value=style.color;
  }
}
function selectionStyle(range){
  if(!range)return {...inline.defaultStyle};
  let node=range.startContainer;
  if(node.nodeType!==3)node=node.childNodes[range.startOffset]||node.lastChild||node;
  while(node.firstChild)node=node.firstChild;
  return styleOf(node);
}
function restoreRange(range,show=true){if(show){const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);}inline.range=range.cloneRange();}
function applyTextStyle(changes){
  if(!inline||inline.loading||busy)return;
  const s=inline,range=s.range,previousSize=s.size;
  const editorFocused=s.input===document.activeElement||s.input.contains(document.activeElement);
  if(range&&!range.collapsed&&s.input.contains(range.commonAncestorContainer)){
    const context=selectionStyle(range),extracted=range.extractContents();
    const runs=richRuns(extracted,context).map(run=>({...run,...changes}));
    const fragment=richFragment(runs),first=fragment.firstChild,last=fragment.lastChild;
    range.insertNode(fragment);if(first&&last){range.setStartBefore(first);range.setEndAfter(last);restoreRange(range,editorFocused);}
  }else{
    const runs=richRuns().map(run=>({...run,...changes}));
    s.defaultStyle={...s.defaultStyle,...changes};
    s.input.replaceChildren(richFragment(runs));
    const caret=document.createRange();caret.selectNodeContents(s.input);caret.collapse(false);restoreRange(caret,editorFocused);
  }
  if(changes.size!==undefined){
    s.size=changes.size;
    // Grow the frame with its type instead of forcing larger text into the old box.
    s.width=Math.min(doc.width-4,Math.max(40,s.width*changes.size/previousSize));
    s.left=Math.min(s.left,Math.max(2,doc.width-s.width-2));
    s.baselineOffset=s.initialBaselineOffset*s.size/s.initialSize;
  }
  for(const key of ['bold','italic','underline'])if(changes[key]!==undefined)$('format-'+key).setAttribute('aria-pressed',String(changes[key]));
  if(editorFocused)s.input.focus();
  styleInline();rememberSelection();$('file-status').textContent='Editing…';
}
function imagePlacement(width,height,ratio,preferredWidth,center=[width/2,height/2]){
  const margin=Math.min(24,width/8,height/8);
  const w=Math.max(1,Math.min(Number.isFinite(preferredWidth)?preferredWidth:180,width-margin*2,(height-margin*2)*ratio));
  const h=w/ratio,x=Math.max(margin,Math.min(width-margin-w,center[0]-w/2)),y=Math.max(margin,Math.min(height-margin-h,center[1]-h/2));
  return [x,y,x+w,y+h];
}
function textBoxBounds(box,mode,dx,dy,pageWidth,pageHeight){
  const [x0,y0,x1,y1]=box,minWidth=Math.min(40,pageWidth),minHeight=16;
  if(mode==='move'){
    const x=Math.max(0,Math.min(pageWidth-(x1-x0),x0+dx)),y=Math.max(0,Math.min(pageHeight-(y1-y0),y0+dy));
    return [x,y,x+x1-x0,y+y1-y0];
  }
  return [mode.includes('w')?Math.max(0,Math.min(x1-minWidth,x0+dx)):x0,
    mode.includes('n')?Math.max(0,Math.min(y1-minHeight,y0+dy)):y0,
    mode.includes('e')?Math.max(x0+minWidth,Math.min(pageWidth,x1+dx)):x1,
    mode.includes('s')?Math.max(y0+minHeight,Math.min(pageHeight,y1+dy)):y1];
}
function addTextHandles(frame){
  for(const mode of ['move','nw','ne','sw','se']){
    const handle=document.createElement('button');handle.type='button';
    handle.className=mode==='move'?'text-move':'text-handle '+mode;
    handle.setAttribute('aria-label',mode==='move'?'Move text box':`Resize text ${mode} corner`);
    handle.title=mode==='move'?'Drag to move':'Drag to resize';
    handle.onpointerdown=event=>{
      if(busy||!inline||inline.loading||event.button!==0)return;
      event.preventDefault();event.stopPropagation();handle.setPointerCapture(event.pointerId);
      const s=inline,start=[event.clientX,event.clientY],box=[s.left,s.top,s.left+s.width,s.top+s.input.offsetHeight/zoom];
      const minimum=s.minimumHeight;
      const release=()=>{handle.onpointermove=null;handle.onpointerup=null;handle.onpointercancel=null;if(handle.hasPointerCapture(event.pointerId))handle.releasePointerCapture(event.pointerId);};
      handle.onpointermove=move=>{
        if(inline!==s)return;
        const next=textBoxBounds(box,mode,(move.clientX-start[0])/zoom,(move.clientY-start[1])/zoom,doc.width,doc.height);
        s.left=next[0];s.top=next[1];s.width=next[2]-next[0];s.minimumHeight=next[3]-next[1];
        styleInline();$('file-status').textContent='Editing…';
      };
      handle.onpointerup=release;
      handle.onpointercancel=()=>{s.left=box[0];s.top=box[1];s.width=box[2]-box[0];s.minimumHeight=minimum;styleInline();release();};
    };
    handle.onkeydown=event=>{
      if(!inline||inline.loading||busy||!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key))return;
      event.preventDefault();event.stopPropagation();
      const step=event.shiftKey?10:1,s=inline;
      const next=textBoxBounds([s.left,s.top,s.left+s.width,s.top+s.input.offsetHeight/zoom],mode,
        event.key==='ArrowLeft'?-step:event.key==='ArrowRight'?step:0,event.key==='ArrowUp'?-step:event.key==='ArrowDown'?step:0,doc.width,doc.height);
      s.left=next[0];s.top=next[1];s.width=next[2]-next[0];s.minimumHeight=next[3]-next[1];styleInline();$('file-status').textContent='Editing…';
    };
    frame.append(handle);
  }
}
async function startInline(block=null,point=null){
  resetSelection();const sequence=inlineSequence;
  const size=block?.size||14,origin=block?.origin||point;
  const width=Math.min(doc.width-origin[0]-4,Math.max(40,block?block.bbox[2]-block.bbox[0]+2:250));
  const frame=document.createElement('div');frame.className='inline-frame';
  if(block)frame.style.visibility='hidden';
  const input=document.createElement('div');input.className='inline-text';input.contentEditable='true';input.setAttribute('role','textbox');input.setAttribute('aria-multiline','true');input.setAttribute('aria-label','Edit paragraph directly on the PDF');input.spellcheck=true;input.dataset.placeholder='Start typing…';
  const actions=document.createElement('div');actions.className='inline-actions';
  const done=document.createElement('button');done.textContent='Done';done.className='primary';done.title='Apply paragraph (Ctrl+Enter)';done.disabled=true;
  const cancel=document.createElement('button');cancel.textContent='Cancel';cancel.title='Cancel paragraph edit (Escape)';
  actions.append(done,cancel);frame.append(input,actions);
  const top=block?block.bbox[1]:origin[1]-size*.8;
  $('page-surface').append(frame);
  const observer=new ResizeObserver(()=>{if(inline?.input===input)inline.width=input.offsetWidth/zoom;});
  const color='#'+(block?.color??0x242a28).toString(16).padStart(6,'0');
  inline={frame,input,observer,block,origin:[...origin],left:origin[0],top,width,size,color,minimumHeight:0,
    baselineOffset:origin[1]-top,initialBaselineOffset:origin[1]-top,
    initial:block?.text||'',initialSize:size,initialWidth:width,loading:true,align:'left',spacing:block?Math.max(1,Math.min(3,block.lineheight/block.size)):1.35,
    defaultStyle:{font:block?.font||'Arial',size,color,bold:block?.bold||false,italic:block?.italic||false,underline:false}};
  input.replaceChildren(richFragment(block?.runs||[]));inline.initialSignature=JSON.stringify(richRuns());
  addTextHandles(frame);
  $('inline-size').value=Math.round(size*10)/10;$('inline-color').value=color;$('inline-settings').hidden=false;$('inline-family').value='original';$('inline-align').value='left';
  const spacing=String(Math.round(inline.spacing*100)/100);
  if(!Array.from($('inline-spacing').options).some(o=>o.value===spacing))$('inline-spacing').add(new Option(spacing+' (original)',spacing));
  $('inline-spacing').value=spacing;
  $('inline-font').textContent=block?.mixed?'Mixed fonts':block?.font||'Arial';
  $('delete-text').hidden=!block;syncSelectionUI();$('hint').textContent='Ctrl+Enter to apply · Esc to cancel';
  done.onclick=()=>finishInline();cancel.onclick=()=>{resetSelection();updateUI();};
  input.oninput=()=>{styleInline();$('file-status').textContent='Editing…';};
  input.onkeydown=event=>{
    event.stopPropagation();
    if(busy){event.preventDefault();return;}
    if(event.key==='Escape'){event.preventDefault();resetSelection();updateUI();}
    else if((event.ctrlKey||event.metaKey)&&event.key==='Enter'){event.preventDefault();finishInline();}
    else if((event.ctrlKey||event.metaKey)&&['b','i','u'].includes(event.key.toLowerCase())){event.preventDefault();rememberSelection();const key={b:'bold',i:'italic',u:'underline'}[event.key.toLowerCase()];applyTextStyle({[key]:!selectionStyle(inline.range)[key]});}
  };
  input.onpaste=event=>{
    event.preventDefault();const text=event.clipboardData.getData('text/plain');
    rememberSelection();let range=inline.range;if(!range){range=document.createRange();range.selectNodeContents(input);range.collapse(false);}
    const style=styleOf(range.startContainer),fragment=richFragment([{...style,text}]),last=fragment.lastChild;
    range.deleteContents();range.insertNode(fragment);if(last){range.setStartAfter(last);range.collapse(true);restoreRange(range);}input.dispatchEvent(new Event('input'));
  };
  observer.observe(input);styleInline();input.focus();
  try{
    const [background]=await Promise.all([
      block?pageRenderer.load(renderURL(doc.page)+'&exclude='+block.id):null,
      Promise.all((block?.runs||[inline.defaultStyle]).map(loadEditorFont))
    ]);
    if(inlineSequence===sequence){
      if(background)pageRenderer.paint(background);
      frame.style.visibility='visible';inline.loading=false;done.disabled=false;
      const range=document.createRange();range.selectNodeContents(input);range.collapse(false);restoreRange(range);rememberSelection();input.focus();
    }
  }catch(error){if(inlineSequence===sequence){resetSelection();notify('Could not prepare inline editing. Please try again.',true);}}
}
function styleInline(){
  if(!inline)return;const s=inline;
  Object.assign(s.input.style,{width:s.width*zoom+'px',minHeight:s.minimumHeight*zoom+'px',fontSize:s.size*zoom+'px',lineHeight:s.size*s.spacing*zoom+'px',color:s.defaultStyle.color,fontFamily:s.defaultStyle.font,textAlign:s.align});
  s.top=Math.max(0,Math.min(s.top,Math.max(0,doc.height-s.input.offsetHeight/zoom)));
  s.origin=[s.left,s.top+s.baselineOffset];
  Object.assign(s.frame.style,{left:s.left*zoom+'px',top:s.top*zoom+'px'});
}
async function finishInline(){
  if(!inline)return true;if(busy||inline.loading)return false;
  const s=inline,runs=richRuns(),text=runs.map(r=>r.text).join('');
  if(s.block&&JSON.stringify(runs)===s.initialSignature&&s.align==='left'&&Math.abs(s.width-s.initialWidth)<2&&s.origin.every((value,i)=>Math.abs(value-s.block.origin[i])<.01)&&Math.abs(s.spacing-s.block.lineheight/s.block.size)<.01){resetSelection();return true;}
  if(!s.block&&!text.trim()){resetSelection();return true;}
  return mutate('edit',{action:s.block?'replace_block':'text_block',block:s.block?.id,point:s.origin,text,runs,size:s.size,color:s.color,width:s.width,spacing:s.spacing,align:s.align,auto_layout:true});
}
document.addEventListener('selectionchange',rememberSelection);
for(const key of ['bold','italic','underline']){
  $('format-'+key).onmousedown=event=>event.preventDefault();
  $('format-'+key).onclick=()=>{if(inline)applyTextStyle({[key]:!selectionStyle(inline.range)[key]});};
}
for(const id of ['inline-family','inline-size','inline-color'])$(id).onpointerdown=rememberSelection;
$('inline-family').onchange=()=>{if(inline)applyTextStyle({font:$('inline-family').value==='original'?inline.block?.font||'Arial':$('inline-family').value});};
$('inline-size').oninput=()=>{const size=Number($('inline-size').value);if(inline&&Number.isFinite(size)&&size>=4&&size<=144)applyTextStyle({size});};
$('inline-color').oninput=()=>{if(inline)applyTextStyle({color:$('inline-color').value});};
$('inline-align').onchange=()=>{if(inline){inline.align=$('inline-align').value;styleInline();}};
$('inline-spacing').onchange=()=>{if(inline){inline.spacing=Number($('inline-spacing').value);styleInline();}};
$('delete-text').onclick=async()=>{if(inline&&!inline.loading&&!busy){inline.input.replaceChildren();await finishInline();}};
$('apply-appearance').onclick=async()=>{
  if(!doc||!await finishInline())return;
  const payload={action:'document_style',scope:$('appearance-scope').value};
  if($('enable-background').checked)payload.background=$('page-background').value;
  if($('enable-document-color').checked)payload.text_color=$('document-color').value;
  if($('enable-document-font').checked)payload.font=$('document-family').value;
  if(await mutate('edit',payload)){thumbnails();updateUI();}
};
document.querySelectorAll('[data-bg]').forEach(button=>button.onclick=()=>{
  $('page-background').value=button.dataset.bg;$('enable-background').checked=true;
  if(button.dataset.bg==='#203039'){$('document-color').value='#f5f1e8';$('enable-document-color').checked=true;}
  else if($('enable-document-color').checked&&$('document-color').value==='#f5f1e8')$('document-color').value='#1c3039';
});

function showForm(text='',size=14,hex='#242a28'){
  $('edit-form').hidden=false;$('text-input').value=text;$('font-size').value=Math.round(size*10)/10;$('text-color').value=hex;
  $('text-label').textContent=tool==='note'?'Comment':'Text';$('text-options').hidden=tool==='note';$('apply').textContent=tool==='note'?'Add note':'Add text';
  $('hint').textContent='';$('text-input').focus();$('text-input').select();
}
function thumbnails(){
  if($('thumbnails').dataset.document===doc.id&&$('thumbnails').children.length===doc.count){
    for(let i=0;i<doc.count;i++)refreshThumbnail(i);return;
  }
  $('thumbnails').dataset.document=doc.id;
  $('thumbnails').replaceChildren();
  for(let i=0;i<doc.count;i++){
    const button=document.createElement('button');button.className='thumbnail';button.setAttribute('aria-label',`Go to page ${i+1}`);
    const img=document.createElement('img');img.src=renderURL(i,.2);img.alt=`Page ${i+1}`;img.loading='lazy';
    const label=document.createElement('span');label.textContent=String(i+1).padStart(2,'0');button.append(img,label);button.onclick=()=>goPage(i);$('thumbnails').append(button);
  }
}
function refreshThumbnail(index,data=doc){
  const thumb=$('thumbnails').children[index]?.querySelector('img');
  if(thumb)pageRenderer.load(renderURL(index,.2,data)).then(image=>{
    if(thumb.isConnected&&doc.id===data.id&&doc.revision===data.revision){image.alt=thumb.alt;thumb.replaceWith(image);}
  }).catch(()=>{});
}
async function showPage(data,resize=false){
  const image=await pageRenderer.load(renderURL(data.page,1.5,data));
  doc=data;document.body.classList.add('document-open');resetSelection({restore:false});
  invalidateFind();
  pageBaseImage=image;pageRenderer.paint(image);
  resize?fit():layout();updateUI();
  refreshThumbnail(doc.page,data);
}
async function openFile(file){
  if(!file)return;
  if(!file.name.toLowerCase().endsWith('.pdf'))return notify('Choose a PDF file.',true);
  if(file.size>50*1024*1024)return notify('Choose a PDF smaller than 50 MB.',true);
  if(!await finishInline())return;
  if(dirty&&!confirm('Open another PDF? Save your current changes first if you want to keep them.'))return;
  await working(async()=>{
    const previous=doc;
    const data=await api('/api/open',{method:'POST',headers:{'Content-Type':'application/pdf','X-Filename':encodeURIComponent(file.name)},body:file});
    doc=data;dirty=false;$('welcome').hidden=true;$('document-stage').hidden=false;thumbnails();await showPage(data,true);
    if(previous)api('/api/close',{method:'POST',body:JSON.stringify({id:previous.id})}).catch(()=>{});
  });
}
async function goPage(index){
  if(!doc||busy||index<0||index>=doc.count)return;
  if(!await finishInline())return;
  const request=++pageRequest;
  await working(async()=>{const result=await api(`/api/page?id=${doc.id}&page=${index}`);if(request===pageRequest){await showPage(result);$('canvas-scroll').scrollTop=0;}});
}
async function mutate(action, payload={}){
  if(!doc)return;
  let rect=payload.rect||objectBox;
  if(inline){
    const old=inline.block?.bbox||[inline.origin[0],inline.origin[1],inline.origin[0],inline.origin[1]];
    const bounds=inline.input.getBoundingClientRect(),surface=$('page-surface').getBoundingClientRect();
    rect=[Math.min(old[0],(bounds.left-surface.left)/zoom),Math.min(old[1],(bounds.top-surface.top)/zoom),Math.max(old[2],(bounds.right-surface.left)/zoom),Math.max(old[3],(bounds.bottom-surface.top)/zoom)];
  }else if(!rect&&payload.point)rect=[...payload.point,...payload.point];
  return working(async()=>{
    const result=await api(`/api/${action}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:doc.id,revision:doc.revision,page:doc.page,...payload})});
    dirty=true;
    try{await showPage(result);}catch(error){
      // Saving succeeded even if the preview failed. Keep the revision current for the next edit.
      doc=result;resetSelection();layout();updateUI();
      throw new Error('Edit saved, but the preview could not refresh. Select this page again to retry.');
    }
    if(payload.action==='objects'&&result.selection?.length)selectObjects(result.selection,false);
    if(result.warning)notify(result.warning);
  },{overlay:false,rect});
}
function pagePoint(event){const rect=$('page-surface').getBoundingClientRect();return [Math.max(0,Math.min(doc.width,(event.clientX-rect.left)/zoom)),Math.max(0,Math.min(doc.height,(event.clientY-rect.top)/zoom))];}
$('interaction-layer').addEventListener('click',async event=>{
  if(!doc||busy||tool==='highlight'||tool==='appearance'||tool==='objects'||tool==='image')return;
  if(['find','signature','date'].includes(tool)){await basicPageClick(event);return;}
  if(tool==='select')return;
  if(!await finishInline())return;
  if(tool==='edit')return;
  placement=pagePoint(event);
  if(tool==='text'){await startInline(null,placement);return;}
  if(tool==='note'){showForm();return;}
});
$('interaction-layer').addEventListener('pointerdown',async event=>{
  if(doc&&!busy&&tool==='select'&&event.target===event.currentTarget&&event.button===0){
    if(await finishInline()){resetSelection();drawHits();}return;
  }
  if(!doc||busy||!(tool==='highlight'||(tool==='find'&&$('find-target').value==='area')))return;event.preventDefault();drag=pagePoint(event);$('interaction-layer').setPointerCapture(event.pointerId);$('selection-box').hidden=false;
  Object.assign($('selection-box').style,{left:drag[0]*zoom+'px',top:drag[1]*zoom+'px',width:'0',height:'0'});
});
$('interaction-layer').addEventListener('pointermove',event=>{
  if(!drag)return;const end=pagePoint(event);Object.assign($('selection-box').style,{left:Math.min(drag[0],end[0])*zoom+'px',top:Math.min(drag[1],end[1])*zoom+'px',width:Math.abs(end[0]-drag[0])*zoom+'px',height:Math.abs(end[1]-drag[1])*zoom+'px'});
});
$('interaction-layer').addEventListener('pointerup',async event=>{
  if(!drag)return;const start=drag,end=pagePoint(event);drag=null;$('selection-box').hidden=true;
  if(Math.abs(start[0]-end[0])<3||Math.abs(start[1]-end[1])<3)return;
  if(tool==='find'){setRedactionArea([Math.min(start[0],end[0]),Math.min(start[1],end[1]),Math.max(start[0],end[0]),Math.max(start[1],end[1])]);return;}
  await mutate('edit',{action:'highlight',rect:[Math.min(start[0],end[0]),Math.min(start[1],end[1]),Math.max(start[0],end[0]),Math.max(start[1],end[1])],color:$('highlight-color').value});
});
$('interaction-layer').addEventListener('pointercancel',()=>{drag=null;$('selection-box').hidden=true;});
$('edit-form').onsubmit=async event=>{
  event.preventDefault();if(!doc)return;
  const payload={action:tool==='edit'?'replace':tool,text:$('text-input').value,size:Number($('font-size').value),color:$('text-color').value};
  if(tool!=='note'&&/[\r\n]/.test(payload.text))return notify('Use one line per text box. Add another box for a new line.',true);
  if(tool==='edit'){if(!selected)return;payload.span=selected.id;}else{if(!placement)return;payload.point=placement;}
  await mutate('edit',payload);
};
$('cancel-edit').onclick=resetSelection;
document.querySelectorAll('[data-tool]').forEach(button=>button.onclick=()=>{if(!busy)return setTool(button.dataset.tool);});
for(const id of ['open-btn','choose-file'])$(id).onclick=()=>$('file-input').click();
$('file-input').onchange=event=>{openFile(event.target.files[0]);event.target.value='';};
$('choose-image').onclick=async()=>{if(doc&&!busy&&await finishInline())$('image-input').click();};
$('image-input').onchange=async event=>{
  const file=event.target.files[0];event.target.value='';if(!file)return;
  if(!doc||busy)return;
  const target=doc;
  if(file.size>15*1024*1024)return notify('Choose an image smaller than 15 MB.',true);
  if(!['image/png','image/jpeg'].includes(file.type))return notify('Choose a PNG or JPEG image.',true);
  try{
    const data=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(new Error('Could not read the image.'));reader.readAsDataURL(file);});
    const img=new Image();img.src=data;await img.decode();
    if(doc.id!==target.id||doc.page!==target.page||busy)return notify('Choose the image again on the current page.');
    const surface=$('page-surface').getBoundingClientRect(),view=$('canvas-scroll').getBoundingClientRect();
    const center=[(Math.max(surface.left,view.left)+Math.min(surface.right,view.right))/2-surface.left,(Math.max(surface.top,view.top)+Math.min(surface.bottom,view.bottom))/2-surface.top].map(value=>value/zoom);
    const rect=imagePlacement(doc.width,doc.height,img.width/img.height,Number($('image-width').value),center);
    if(await mutate('edit',{action:'image',image:data.split(',')[1],rect})){
      const image=doc.objects.filter(o=>o.kind==='image').at(-1);await setTool('select');if(image)selectObjects([image.id]);
    }
  }catch(error){notify(error.message,true);}
};
async function historyChange(action){
  if(busy||!doc)return;
  if(inline&&!await finishInline())return;
  if(doc[action]){const succeeded=await mutate(action);if(succeeded)thumbnails();return succeeded;}
}
$('undo').onclick=()=>historyChange('undo');$('redo').onclick=()=>historyChange('redo');
$('prev').onclick=()=>goPage(doc.page-1);$('next').onclick=()=>goPage(doc.page+1);
$('zoom-in').onclick=async()=>{if(busy||!await finishInline())return;zoom=Math.min(2.5,zoom+.15);layout();};$('zoom-out').onclick=async()=>{if(busy||!await finishInline())return;zoom=Math.max(.25,zoom-.15);layout();};$('zoom-label').onclick=async()=>{if(!busy&&await finishInline())fit();};
async function savePDF(){
  if(!doc||busy||savePending)return;
  savePending=true;$('download').disabled=true;
  try{
    if(!await finishInline())return;
    await working(async()=>{
      const target=doc.id,revision=doc.revision;
      const result=await api('/api/save',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:target,revision})});
      if(result.saved&&result.revision===revision&&doc.id===target&&doc.revision===revision){
        dirty=false;updateUI();$('file-status').textContent='Saved';
      }
    },{overlay:false,status:'Saving PDF'});
  }finally{savePending=false;$('download').disabled=!doc;}
}
$('download').onclick=savePDF;
document.addEventListener('keydown',event=>{
  if(busy){if(event.key==='Escape'||((event.ctrlKey||event.metaKey)&&['z','y'].includes(event.key.toLowerCase())))event.preventDefault();return;}
  if(event.key==='Escape'){resetSelection();if(doc)drawHits();return;}
  if(event.target.matches('input,textarea,select')||event.target.isContentEditable)return;
  if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='z'){event.preventDefault();historyChange(event.shiftKey?'redo':'undo');}
  else if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='y'){event.preventDefault();historyChange('redo');}
  else if((event.key==='Delete'||event.key==='Backspace')&&objectIds.size){event.preventDefault();objectMutation('delete');}
});
let dragDepth=0;
document.addEventListener('dragenter',event=>{if(event.dataTransfer.types.includes('Files')){event.preventDefault();dragDepth++;$('drop-overlay').hidden=false;}});
document.addEventListener('dragover',event=>event.preventDefault());
document.addEventListener('dragleave',()=>{dragDepth=Math.max(0,dragDepth-1);if(!dragDepth)$('drop-overlay').hidden=true;});
document.addEventListener('drop',event=>{event.preventDefault();dragDepth=0;$('drop-overlay').hidden=true;openFile(event.dataTransfer.files[0]);});
window.addEventListener('beforeunload',event=>{if(dirty||inline||busy){event.preventDefault();event.returnValue='';}});
initObjects();initBasicTools();setTool('select');
// A local document link can reconnect a tab to a PDF still held by this server.
const resumeParameters=new URLSearchParams(location.search);
const resumeDocument=resumeParameters.get('document');
if(resumeDocument&&/^[a-f0-9]{32}$/.test(resumeDocument))working(async()=>{
  const page=Number(resumeParameters.get('page')||0);
  const data=await api(`/api/page?id=${resumeDocument}&page=${Number.isSafeInteger(page)&&page>=0?page:0}`);
  doc=data;dirty=Boolean(data.undo);$('welcome').hidden=true;$('document-stage').hidden=false;
  thumbnails();await showPage(data,true);
  if(['objects','select'].includes(resumeParameters.get('view'))){
    await setTool(resumeParameters.get('view'));const object=resumeParameters.get('object');if(object)selectObjects([object]);
  }
});
