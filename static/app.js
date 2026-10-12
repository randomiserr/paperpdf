'use strict';
const $ = id => document.getElementById(id);
const token = document.querySelector('meta[name="editor-token"]').content;
let doc = null, tool = 'select', selected = null, placement = null, imageAsset = null;
let zoom = 1, busy = false, dirty = false, pageRequest = 0, drag = null, toastTimer;
let inline = null, inlineSequence = 0;
const settings = {
  select: ['SELECT', 'Click a piece. Make it yours.', 'Click text, an image, or artwork. The editing controls appear automatically for your selection.', 'Click text, an image, or artwork to edit it · Escape deselects'],
  edit: ['EDIT TEXT', 'Write right on the page.', 'Click a paragraph and type directly. Enter adds a new line. Drag the corner to change the wrapping width.', 'Click a paragraph to edit · Ctrl+Enter to finish'],
  text: ['ADD TEXT', 'Room for your words.', 'Click an empty spot and start typing. Your text wraps as you write; Enter starts a new line.', 'Click the page and start typing'],
  image: ['ADD IMAGE', 'Put it in the picture.', 'Choose a PNG or JPEG, set its width, then click the page to place it.', 'Click the page to place your image'],
  objects: ['OBJECTS', 'Every piece, in reach.', 'Select an image or vector on the page or in the layer list. Drag it to move; use the corner handles to resize. Shift-click selects several pieces.', 'Select an object · drag to move · corners to resize'],
  highlight: ['HIGHLIGHT', 'Bring it into focus.', 'Click and drag across the area you want to highlight.', 'Drag across the page to highlight'],
  appearance: ['APPEARANCE', 'Set the tone.', 'Choose a background, font, and text color for this page or the whole document.', 'Style your pages and document'],
  note: ['ADD NOTE', 'Leave a little context.', 'Click the page to place a comment. Notes remain PDF annotations.', 'Click the page to leave a note']
};
function notify(message, error=false) {
  clearTimeout(toastTimer); $('toast').textContent=message; $('toast').classList.toggle('error',error); $('toast').hidden=false;
  toastTimer=setTimeout(()=>$('toast').hidden=true,error?9000:5000);
}
async function api(path, options={}) {
  const response=await fetch(path,{...options,headers:{'X-Editor-Token':token,...options.headers}});
  if(!response.ok){let info;try{info=await response.json();}catch{info={error:'The editor could not complete this request.'};}throw new Error(info.error);}
  return response.json();
}
async function working(fn) {
  if(busy)return; busy=true;$('busy').hidden=false;
  try{await fn();return true;}catch(error){notify(error.message||'Something went wrong.',true);return false;}finally{busy=false;$('busy').hidden=true;}
}
function renderURL(page,scale=1.5){return `/api/render?id=${doc.id}&page=${page}&scale=${scale}&revision=${doc.revision}&token=${encodeURIComponent(token)}`;}
function resetSelection(){
  clearObjects();
  inlineSequence++;
  if(inline){inline.observer.disconnect();inline.frame.remove();inline=null;if(doc)$('page-image').src=renderURL(doc.page);}
  selected=null;placement=null;$('edit-form').hidden=true;$('inline-settings').hidden=true;
  document.querySelectorAll('.text-hit.selected').forEach(el=>el.classList.remove('selected'));
  syncSelectionUI();
}
function syncSelectionUI(){
  $('object-library').hidden=tool==='select';
  if(tool!=='select')return;
  const items=chosenObjects(),kind=items.length===1?items[0].kind:items.length?'objects':inline?'text':null;
  $('objects-options').hidden=!items.length;
  const [tag,title,instructions,hint]=settings.select;
  $('tool-tag').textContent=kind?kind.toUpperCase()+' SELECTED':tag;
  $('inspector-title').textContent=kind==='text'?'Text selected.':kind==='image'?'Image selected.':kind==='vector'?'Vector selected.':kind==='artwork'?'Artwork selected.':kind?'Objects selected.':title;
  $('instructions').textContent=kind==='text'?'Type directly on the page, format your text, or delete this paragraph.':kind?'Drag to move, use a corner to resize, or edit the controls below.':instructions;
  $('hint').textContent=kind==='text'?'Edit this paragraph · Ctrl+Enter to finish':kind?'Drag to move · corners to resize · Delete to remove':doc?hint:'Open a PDF to get started';
}
async function setTool(value){
  if(inline&&!await finishInline())return;
  tool=value;resetSelection();
  document.querySelectorAll('[data-tool]').forEach(el=>{el.classList.toggle('active',el.dataset.tool===tool);el.setAttribute('aria-pressed',String(el.dataset.tool===tool));});
  const [tag,title,instructions,hint]=settings[tool];
  $('tool-tag').textContent=tag;$('inspector-title').textContent=title;$('instructions').textContent=instructions;$('hint').textContent=doc?hint:'Open a PDF to get started';
  $('appearance-options').hidden=tool!=='appearance';
  $('image-options').hidden=tool!=='image';$('highlight-options').hidden=tool!=='highlight';
  $('objects-options').hidden=tool!=='objects';
  $('interaction-layer').style.cursor=['select','edit','objects'].includes(tool)?'default':'crosshair';
  syncSelectionUI();
  if(doc)drawHits();
}
function updateUI(){
  $('apply-appearance').disabled=false;
  $('filename').textContent=doc.name;$('file-status').textContent=dirty?'Changes ready to download':'Opened on this computer';
  $('page-count').textContent=doc.count;$('page-indicator').textContent=`${doc.page+1} / ${doc.count}`;
  $('prev').disabled=doc.page===0;$('next').disabled=doc.page===doc.count-1;$('undo').disabled=!doc.undo;$('redo').disabled=!doc.redo;$('download').disabled=false;
  $('scan-notice').hidden=doc.spans.length>0;$('hint').textContent=settings[tool][3];
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
  const selection=window.getSelection();
  if(!selection.rangeCount)return;
  const range=selection.getRangeAt(0);
  if(inline.input.contains(range.startContainer)&&inline.input.contains(range.endContainer)){
    inline.range=range.cloneRange();const style=selectionStyle(range);
    $('text-scope').textContent=range.collapsed?'Styling the whole paragraph':'Styling selected words';
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
function restoreRange(range){const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);inline.range=range.cloneRange();}
function applyTextStyle(changes){
  if(!inline||inline.loading)return;
  const s=inline,range=s.range;
  if(range&&!range.collapsed&&s.input.contains(range.commonAncestorContainer)){
    const context=selectionStyle(range),extracted=range.extractContents();
    const runs=richRuns(extracted,context).map(run=>({...run,...changes}));
    const fragment=richFragment(runs),first=fragment.firstChild,last=fragment.lastChild;
    range.insertNode(fragment);if(first&&last){range.setStartBefore(first);range.setEndAfter(last);restoreRange(range);}
  }else{
    const runs=richRuns().map(run=>({...run,...changes}));
    s.defaultStyle={...s.defaultStyle,...changes};
    s.input.replaceChildren(richFragment(runs));
    const caret=document.createRange();caret.selectNodeContents(s.input);caret.collapse(false);restoreRange(caret);
  }
  if(changes.size!==undefined)s.size=changes.size;
  s.input.focus();styleInline();rememberSelection();$('file-status').textContent='Editing on the page…';
}
async function startInline(block=null,point=null){
  resetSelection();const sequence=inlineSequence;
  const size=block?.size||14,origin=block?.origin||point;
  const width=Math.min(doc.width-origin[0]-4,Math.max(40,block?block.bbox[2]-block.bbox[0]+2:250));
  const frame=document.createElement('div');frame.className='inline-frame';
  const input=document.createElement('div');input.className='inline-text';input.contentEditable='true';input.setAttribute('role','textbox');input.setAttribute('aria-multiline','true');input.setAttribute('aria-label','Edit paragraph directly on the PDF');input.spellcheck=true;input.dataset.placeholder='Start typing…';
  const actions=document.createElement('div');actions.className='inline-actions';
  const done=document.createElement('button');done.textContent='Done';done.className='primary';done.title='Apply paragraph (Ctrl+Enter)';
  const cancel=document.createElement('button');cancel.textContent='Cancel';cancel.title='Cancel paragraph edit (Escape)';
  const helper=document.createElement('span');helper.textContent='Enter ↵ new line';actions.append(done,cancel,helper);frame.append(input,actions);
  input.style.width=width*zoom+'px';input.style.maxWidth=(doc.width-origin[0]-2)*zoom+'px';
  Object.assign(frame.style,{left:origin[0]*zoom+'px',top:(block?block.bbox[1]:origin[1]-size*.8)*zoom+'px'});
  $('page-surface').append(frame);
  const observer=new ResizeObserver(()=>{if(inline?.input===input)inline.width=input.offsetWidth/zoom;});
  const color='#'+(block?.color??0x242a28).toString(16).padStart(6,'0');
  inline={frame,input,observer,block,origin,width,size,color,initial:block?.text||'',initialSize:size,initialWidth:width,loading:true,align:'left',spacing:block?Math.max(1,Math.min(3,block.lineheight/block.size)):1.35,
    defaultStyle:{font:block?.font||'Arial',size,color,bold:block?.bold||false,italic:block?.italic||false,underline:false}};
  input.replaceChildren(richFragment(block?.runs||[]));inline.initialSignature=JSON.stringify(richRuns());
  $('inline-size').value=Math.round(size*10)/10;$('inline-color').value=color;$('inline-settings').hidden=false;$('inline-family').value='original';$('inline-align').value='left';
  const spacing=String(Math.round(inline.spacing*100)/100);
  if(!Array.from($('inline-spacing').options).some(o=>o.value===spacing))$('inline-spacing').add(new Option(spacing+' (original)',spacing));
  $('inline-spacing').value=spacing;
  $('inline-font').textContent=block?.mixed?'Original mixed formatting is preserved.':`${block?.font||'Arial'} · multiline text`;
  $('delete-text').hidden=!block;syncSelectionUI();
  done.onclick=()=>finishInline();cancel.onclick=()=>{resetSelection();updateUI();};
  input.oninput=()=>{$('file-status').textContent='Editing on the page…';};
  input.onkeydown=event=>{
    event.stopPropagation();
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
    if(block){
      const background=new Image();background.src=renderURL(doc.page)+'&exclude='+block.id;frame.style.visibility='hidden';await background.decode();
      if(inlineSequence!==sequence)return;
      $('page-image').src=background.src;frame.style.visibility='visible';
    }
    await Promise.all((block?.runs||[inline.defaultStyle]).map(loadEditorFont));
    if(inlineSequence===sequence){inline.loading=false;const range=document.createRange();range.selectNodeContents(input);range.collapse(false);restoreRange(range);rememberSelection();input.focus();}
  }catch(error){if(inlineSequence===sequence){resetSelection();notify('Could not prepare inline editing. Please try again.',true);}}
}
function styleInline(){
  if(!inline)return;const s=inline;
  Object.assign(s.input.style,{fontSize:s.size*zoom+'px',lineHeight:s.size*s.spacing*zoom+'px',color:s.defaultStyle.color,fontFamily:s.defaultStyle.font,textAlign:s.align});
}
async function finishInline(){
  if(!inline)return true;if(busy||inline.loading)return false;
  const s=inline,runs=richRuns(),text=runs.map(r=>r.text).join('');
  if(s.block&&JSON.stringify(runs)===s.initialSignature&&s.align==='left'&&Math.abs(s.width-s.initialWidth)<2&&Math.abs(s.spacing-s.block.lineheight/s.block.size)<.01){resetSelection();return true;}
  if(!s.block&&!text.trim()){resetSelection();return true;}
  return mutate('edit',{action:s.block?'replace_block':'text_block',block:s.block?.id,point:s.origin,text,runs,size:s.size,color:s.color,width:s.width,spacing:s.spacing,align:s.align});
}
document.addEventListener('selectionchange',rememberSelection);
for(const key of ['bold','italic','underline']){
  $('format-'+key).onmousedown=event=>event.preventDefault();
  $('format-'+key).onclick=()=>{if(inline)applyTextStyle({[key]:!selectionStyle(inline.range)[key]});};
}
for(const id of ['inline-family','inline-size','inline-color'])$(id).onpointerdown=rememberSelection;
$('inline-family').onchange=()=>{if(inline)applyTextStyle({font:$('inline-family').value==='original'?inline.block?.font||'Arial':$('inline-family').value});};
$('inline-size').onchange=()=>{const size=Number($('inline-size').value);if(inline&&size>=4&&size<=144)applyTextStyle({size});};
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
  $('text-input').focus();$('text-input').select();
}
function thumbnails(){
  $('thumbnails').replaceChildren();
  for(let i=0;i<doc.count;i++){
    const button=document.createElement('button');button.className='thumbnail';button.setAttribute('aria-label',`Go to page ${i+1}`);
    const img=document.createElement('img');img.src=renderURL(i,.2);img.alt=`Page ${i+1}`;img.loading='lazy';
    const label=document.createElement('span');label.textContent=String(i+1).padStart(2,'0');button.append(img,label);button.onclick=()=>goPage(i);$('thumbnails').append(button);
  }
}
async function showPage(data,resize=false){
  doc=data;resetSelection();
  const img=$('page-image');
  await new Promise((resolve,reject)=>{img.onload=resolve;img.onerror=()=>reject(new Error('Could not render this page. Try opening the PDF again.'));img.src=renderURL(doc.page);});
  resize?fit():layout();updateUI();
  const thumb=$('thumbnails').children[doc.page]?.querySelector('img');if(thumb)thumb.src=renderURL(doc.page,.2);
}
async function openFile(file){
  if(!file)return;
  if(!file.name.toLowerCase().endsWith('.pdf'))return notify('Choose a PDF file.',true);
  if(file.size>50*1024*1024)return notify('Choose a PDF smaller than 50 MB.',true);
  if(!await finishInline())return;
  if(dirty&&!confirm('Open another PDF? Download your current changes first if you want to keep them.'))return;
  await working(async()=>{
    const previous=doc;
    const data=await api('/api/open',{method:'POST',headers:{'Content-Type':'application/pdf','X-Filename':encodeURIComponent(file.name)},body:file});
    doc=data;dirty=false;$('welcome').hidden=true;$('document-stage').hidden=false;thumbnails();await showPage(data,true);
    if(previous)api('/api/close',{method:'POST',body:JSON.stringify({id:previous.id})}).catch(()=>{});
    notify('PDF opened. Click a paragraph to start editing.');
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
  return working(async()=>{
    const result=await api(`/api/${action}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:doc.id,revision:doc.revision,page:doc.page,...payload})});
    dirty=true;await showPage(result);if(payload.action==='objects'&&result.selection?.length)selectObjects(result.selection);
    notify(result.warning||(action==='undo'?'Change undone.':action==='redo'?'Change restored.':'Change applied.'));
  });
}
function pagePoint(event){const rect=$('page-surface').getBoundingClientRect();return [Math.max(0,Math.min(doc.width,(event.clientX-rect.left)/zoom)),Math.max(0,Math.min(doc.height,(event.clientY-rect.top)/zoom))];}
$('interaction-layer').addEventListener('click',async event=>{
  if(!doc||busy||tool==='highlight'||tool==='appearance'||tool==='objects')return;
  if(tool==='select')return;
  if(!await finishInline())return;
  if(tool==='edit')return;
  placement=pagePoint(event);
  if(tool==='text'){await startInline(null,placement);return;}
  if(tool==='note'){showForm();return;}
  if(tool==='image'){
    if(!imageAsset)return notify('Choose an image in the settings panel first.');
    let width=Number($('image-width').value);if(!Number.isFinite(width)||width<10)return notify('Enter a width of at least 10 pt.',true);
    const height=width/imageAsset.ratio;
    if(await mutate('edit',{action:'image',image:imageAsset.data,rect:[placement[0],placement[1],placement[0]+width,placement[1]+height]})){
      const image=doc.objects.filter(o=>o.kind==='image').at(-1);await setTool('select');if(image)selectObjects([image.id]);
    }
  }
});
$('interaction-layer').addEventListener('pointerdown',async event=>{
  if(doc&&!busy&&tool==='select'&&event.target===event.currentTarget&&event.button===0){
    if(await finishInline()){resetSelection();drawHits();}return;
  }
  if(!doc||busy||tool!=='highlight')return;event.preventDefault();drag=pagePoint(event);$('interaction-layer').setPointerCapture(event.pointerId);$('selection-box').hidden=false;
  Object.assign($('selection-box').style,{left:drag[0]*zoom+'px',top:drag[1]*zoom+'px',width:'0',height:'0'});
});
$('interaction-layer').addEventListener('pointermove',event=>{
  if(!drag)return;const end=pagePoint(event);Object.assign($('selection-box').style,{left:Math.min(drag[0],end[0])*zoom+'px',top:Math.min(drag[1],end[1])*zoom+'px',width:Math.abs(end[0]-drag[0])*zoom+'px',height:Math.abs(end[1]-drag[1])*zoom+'px'});
});
$('interaction-layer').addEventListener('pointerup',async event=>{
  if(!drag)return;const start=drag,end=pagePoint(event);drag=null;$('selection-box').hidden=true;
  if(Math.abs(start[0]-end[0])<3||Math.abs(start[1]-end[1])<3)return;
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
document.querySelectorAll('[data-tool]').forEach(button=>button.onclick=()=>setTool(button.dataset.tool));
for(const id of ['open-btn','choose-file'])$(id).onclick=()=>$('file-input').click();
$('file-input').onchange=event=>{openFile(event.target.files[0]);event.target.value='';};
$('choose-image').onclick=()=>$('image-input').click();
$('image-input').onchange=async event=>{
  const file=event.target.files[0];event.target.value='';if(!file)return;
  if(file.size>15*1024*1024)return notify('Choose an image smaller than 15 MB.',true);
  if(!['image/png','image/jpeg'].includes(file.type))return notify('Choose a PNG or JPEG image.',true);
  try{
    const data=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(new Error('Could not read the image.'));reader.readAsDataURL(file);});
    const img=new Image();img.src=data;await img.decode();imageAsset={data:data.split(',')[1],ratio:img.width/img.height};$('image-preview').src=data;$('image-preview').hidden=false;$('choose-image').textContent='Change image';notify('Image ready. Click the page to place it.');
  }catch(error){notify(error.message,true);}
};
async function historyChange(action){
  if(busy||!doc)return;
  if(inline&&!await finishInline())return;
  resetSelection();if(doc[action])return mutate(action);
}
$('undo').onclick=()=>historyChange('undo');$('redo').onclick=()=>historyChange('redo');
$('prev').onclick=()=>goPage(doc.page-1);$('next').onclick=()=>goPage(doc.page+1);
$('zoom-in').onclick=async()=>{if(!await finishInline())return;zoom=Math.min(2.5,zoom+.15);layout();};$('zoom-out').onclick=async()=>{if(!await finishInline())return;zoom=Math.max(.25,zoom-.15);layout();};$('zoom-label').onclick=async()=>{if(await finishInline())fit();};
$('download').onclick=async()=>{
  if(!doc)return;
  if(!await finishInline())return;
  await working(async()=>{
    const response=await fetch(`/api/download?id=${doc.id}`,{headers:{'X-Editor-Token':token}});if(!response.ok)throw new Error('Could not download the PDF. Try again.');
    const blob=await response.blob(),url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=doc.name.replace(/\.pdf$/i,'')+'-edited.pdf';document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);dirty=false;updateUI();$('file-status').textContent='Downloaded a new copy';notify('Your edited PDF is ready in Downloads.');
  });
};
document.addEventListener('keydown',event=>{
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
window.addEventListener('beforeunload',event=>{if(dirty||inline){event.preventDefault();event.returnValue='';}});
initObjects();setTool('select');
// A local document link can reconnect a tab to a PDF still held by this server.
const resumeParameters=new URLSearchParams(location.search);
const resumeDocument=resumeParameters.get('document');
if(resumeDocument&&/^[a-f0-9]{32}$/.test(resumeDocument))working(async()=>{
  const data=await api(`/api/page?id=${resumeDocument}&page=0`);
  doc=data;dirty=Boolean(data.undo);$('welcome').hidden=true;$('document-stage').hidden=false;
  thumbnails();await showPage(data,true);
  if(['objects','select'].includes(resumeParameters.get('view'))){
    await setTool(resumeParameters.get('view'));const object=resumeParameters.get('object');if(object)selectObjects([object]);
  }
});
