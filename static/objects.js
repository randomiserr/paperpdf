'use strict';
let objectIds=new Set(), objectBox=null, objectFrame=null, objectDrag=null, objectReady=false, objectSequence=0;

function chosenObjects(){return (doc?.objects||[]).filter(o=>objectIds.has(o.id));}
function unionBox(items){
  return [Math.min(...items.map(o=>o.bbox[0])),Math.min(...items.map(o=>o.bbox[1])),Math.max(...items.map(o=>o.bbox[2])),Math.max(...items.map(o=>o.bbox[3]))];
}
function clearObjects(){
  if(objectDrag)releaseObjectDrag();
  objectSequence++;objectIds.clear();objectBox=null;objectDrag=null;objectReady=false;
  objectFrame?.remove();objectFrame=null;
  document.querySelectorAll('.snap-guide').forEach(el=>el.remove());
  document.querySelectorAll('.object-hit.selected').forEach(el=>el.classList.remove('selected'));
  document.querySelectorAll('.object-row[aria-pressed=true]').forEach(el=>el.setAttribute('aria-pressed','false'));
  $('object-settings').hidden=true;
}
function visibleObjects(){
  if(tool==='select')return doc.objects||[];
  const filter=$('object-filter').value;
  return (doc.objects||[]).filter(o=>filter==='all'||(filter==='background'?o.background:o.kind===filter));
}
function drawObjectHits(){
  objectFrame?.remove();objectFrame=null;
  for(const item of visibleObjects()){
    const button=document.createElement('button');button.className='object-hit';button.dataset.object=item.id;
    button.title=item.editable?item.name:item.reason;button.setAttribute('aria-label',`Select ${item.name}`);
    const [x0,y0,x1,y1]=item.bbox;
    Object.assign(button.style,{left:x0*zoom+'px',top:y0*zoom+'px',width:Math.max(5,(x1-x0)*zoom)+'px',height:Math.max(5,(y1-y0)*zoom)+'px'});
    if(tool==='select')button.style.zIndex=item.background?'0':item.kind==='image'||item.kind==='artwork'?'2':'0';
    button.classList.toggle('selected',objectIds.has(item.id));
    button.onpointerdown=async event=>{
      event.stopPropagation();event.preventDefault();if(event.button!==0||busy||!item.editable)return;
      if(inline&&!await finishInline())return;
      const current=resolveObject(item);if(!current)return;
      if(event.shiftKey){toggleObject(current.id);return;}
      if(!objectIds.has(current.id))selectObjects([current.id],false);
      if(button.isConnected)startObjectDrag(event,'move',button);
    };
    button.onclick=event=>{event.stopPropagation();};
    button.onkeydown=async event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();if(busy||!await finishInline())return;const current=resolveObject(item);if(current)event.shiftKey?toggleObject(current.id):selectObjects([current.id]);}};
    $('interaction-layer').append(button);
  }
  drawObjectList();
  if(objectIds.size){makeObjectFrame();prepareObjectPreview();}
}
function resolveObject(item){
  const same=o=>o.kind===item.kind&&o.bbox.every((v,i)=>Math.abs(v-item.bbox[i])<.1);
  return doc.objects.find(o=>o.id===item.id&&same(o))||doc.objects.find(same);
}
function drawObjectList(){
  const list=$('object-list');list.replaceChildren();
  $('object-count').textContent=String((doc.objects||[]).length);
  for(const item of visibleObjects().slice().reverse()){
    const button=document.createElement('button');button.className='object-row';button.setAttribute('aria-label',`Layer: ${item.name}`);
    button.setAttribute('aria-pressed',String(objectIds.has(item.id)));button.disabled=!item.editable;
    const icon=document.createElement('span');icon.className='object-icon';icon.textContent=item.kind==='image'?'▧':item.kind==='vector'?'◇':'▦';
    const title=document.createElement('span');title.textContent=item.name;
    const detail=document.createElement('small');detail.textContent=item.background?'Background':item.kind==='artwork'?'Group':'';
    button.append(icon,title,detail);button.title=item.reason||'Shift-click to select more than one object';
    button.onclick=event=>{if(busy)return;event.shiftKey?toggleObject(item.id):selectObjects([item.id]);};
    list.append(button);
  }
  if(!list.children.length){const empty=document.createElement('p');empty.className='small';empty.textContent='No matching objects on this page.';list.append(empty);}
}
function toggleObject(id){
  const ids=new Set(objectIds);ids.has(id)?ids.delete(id):ids.add(id);selectObjects([...ids]);
}
function selectObjects(ids,scroll=true){
  if(objectDrag)releaseObjectDrag();
  const selectable=new Set((doc.objects||[]).filter(o=>o.editable).map(o=>o.id));
  objectIds=new Set(ids.filter(id=>selectable.has(id)));objectSequence++;
  objectReady=false;objectDrag=null;objectBox=objectIds.size?unionBox(chosenObjects()):null;
  $('object-settings').hidden=!objectIds.size;
  syncSelectionUI();
  // Keep hit targets mounted through pointerup so the browser cannot retarget the click to empty space.
  document.querySelectorAll('.object-hit').forEach(el=>el.classList.toggle('selected',objectIds.has(el.dataset.object)));
  objectFrame?.remove();objectFrame=null;drawObjectList();
  if(objectIds.size){makeObjectFrame();fillObjectControls();prepareObjectPreview();if(scroll)objectFrame?.scrollIntoView({block:'nearest',inline:'nearest'});}
}
function makeObjectFrame(){
  if(!objectBox)return;
  objectReady=false;
  const frame=document.createElement('div');frame.className='object-frame';
  const preview=document.createElement('img');preview.className='object-preview';preview.alt='Selected artwork';preview.draggable=false;frame.append(preview);
  const title=document.createElement('span');title.className='object-caption';title.textContent=objectIds.size>1?`${objectIds.size} objects`:chosenObjects()[0].name;frame.append(title);
  for(const corner of ['nw','ne','sw','se']){
    const handle=document.createElement('button');handle.className='object-handle '+corner;
    handle.setAttribute('aria-label',`Resize ${corner} corner`);handle.title='Drag to resize';
    handle.onpointerdown=event=>{event.stopPropagation();startObjectDrag(event,corner,handle);};
    frame.append(handle);
  }
  $('page-surface').append(frame);objectFrame=frame;positionObjectFrame(objectBox);
}
function positionObjectFrame(box){
  if(!objectFrame)return;
  Object.assign(objectFrame.style,{left:box[0]*zoom+'px',top:box[1]*zoom+'px',width:(box[2]-box[0])*zoom+'px',height:(box[3]-box[1])*zoom+'px'});
}
async function prepareObjectPreview(){
  const sequence=objectSequence,ids=[...objectIds].join(',');
  try{
    const preview=new Image();
    preview.src=`/api/object?id=${doc.id}&page=${doc.page}&objects=${encodeURIComponent(ids)}&revision=${doc.revision}&token=${encodeURIComponent(token)}`;
    const [background]=await Promise.all([pageRenderer.load(renderURL(doc.page)+'&exclude_objects='+encodeURIComponent(ids)),preview.decode()]);
    if(sequence!==objectSequence||!objectFrame)return;
    objectFrame.querySelector('.object-preview').src=preview.src;objectFrame.pageBackground=background;objectReady=true;
    if(objectDrag?.moved||objectFrame.classList.contains('dragging')){pageRenderer.paint(background);objectFrame.classList.add('dragging');}
  }catch(error){if(sequence===objectSequence)notify('Could not prepare this object. Try selecting it again.',true);}
}
function fillObjectControls(box=objectBox){
  const items=chosenObjects();if(!items.length)return;
  $('object-summary').textContent=items.length===1?items[0].name:`${items.length} objects`;
  for(const [id,value] of [['object-x',box[0]],['object-y',box[1]],['object-width',box[2]-box[0]],['object-height',box[3]-box[1]]])$(id).value=(Math.round(value*100)/100).toString();
  const vectors=items.every(o=>o.kind==='vector');
  $('object-colors').hidden=!vectors;
  const fills=items.filter(o=>o.fill),strokes=items.filter(o=>o.stroke);
  $('object-fill').disabled=!fills.length;$('object-stroke').disabled=!strokes.length;
  if(fills.length)$('object-fill').value=fills[0].fill;
  if(strokes.length)$('object-stroke').value=strokes[0].stroke;
  const styleNote=items.length===1&&items[0].kind==='artwork'?'This artwork stays grouped.':vectors?'Colors affect existing fills and strokes.':'';
  $('object-style-note').textContent=styleNote;$('object-style-note').hidden=!styleNote;
}
function snapping(box){
  document.querySelectorAll('.snap-guide').forEach(el=>el.remove());
  const other=(doc.objects||[]).filter(o=>!objectIds.has(o.id)&&!o.background).concat(doc.blocks||[]);
  const guides=[[0,doc.width/2,doc.width],[0,doc.height/2,doc.height]];
  for(const item of other){const r=item.bbox;guides[0].push(r[0],(r[0]+r[2])/2,r[2]);guides[1].push(r[1],(r[1]+r[3])/2,r[3]);}
  for(let axis=0;axis<2;axis++){
    const positions=[box[axis],(box[axis]+box[axis+2])/2,box[axis+2]];let best=6/zoom,adjust=0,guide=null;
    for(const g of guides[axis])for(const p of positions){if(Math.abs(g-p)<best){best=Math.abs(g-p);adjust=g-p;guide=g;}}
    if(guide!==null&&box[axis]+adjust>=0&&box[axis+2]+adjust<=(axis?doc.height:doc.width)){
      box[axis]+=adjust;box[axis+2]+=adjust;
      const line=document.createElement('div');line.className='snap-guide '+(axis?'horizontal':'vertical');line.style[axis?'top':'left']=guide*zoom+'px';$('page-surface').append(line);
    }
  }
  return box;
}
function startObjectDrag(event,mode,element){
  if(busy||!objectBox||event.button!==0)return;
  event.preventDefault();element.setPointerCapture(event.pointerId);
  objectDrag={mode,start:pagePoint(event),box:[...objectBox],target:[...objectBox],pointer:event.pointerId,element,moved:false};
  element.onpointermove=moveObjectDrag;element.onpointerup=finishObjectDrag;element.onpointercancel=cancelObjectDrag;
}
function moveObjectDrag(event){
  const drag=objectDrag;if(!drag)return;
  const p=pagePoint(event),dx=p[0]-drag.start[0],dy=p[1]-drag.start[1],b=drag.box;
  let target;
  if(drag.mode==='move'){
    const x=Math.max(-b[0],Math.min(doc.width-b[2],dx)),y=Math.max(-b[1],Math.min(doc.height-b[3],dy));
    target=[b[0]+x,b[1]+y,b[2]+x,b[3]+y];
    if(!event.altKey&&$('object-snap').checked)target=snapping(target);
  }else{
    const left=drag.mode.includes('w'),top=drag.mode.includes('n'),anchor=[b[left?2:0],b[top?3:1]];
    let w=Math.max(1,(b[2]-b[0])+dx*(left?-1:1)),h=Math.max(1,(b[3]-b[1])+dy*(top?-1:1));
    if($('object-aspect').checked){const ratio=(b[2]-b[0])/(b[3]-b[1]);if(Math.abs(dx)>Math.abs(dy))h=w/ratio;else w=h*ratio;}
    const maxW=left?anchor[0]:doc.width-anchor[0],maxH=top?anchor[1]:doc.height-anchor[1];
    const scale=Math.min(1,maxW/w,maxH/h);w*=scale;h*=scale;
    target=[left?anchor[0]-w:anchor[0],top?anchor[1]-h:anchor[1],left?anchor[0]:anchor[0]+w,top?anchor[1]:anchor[1]+h];
  }
  drag.target=target;drag.moved=drag.moved||(Math.abs(dx)+Math.abs(dy))*zoom>3;
  if(drag.moved){if(objectReady&&!objectFrame.classList.contains('dragging')){pageRenderer.paint(objectFrame.pageBackground);objectFrame.classList.add('dragging');}positionObjectFrame(target);fillObjectControls(target);}
}
function releaseObjectDrag(restore=true){
  const drag=objectDrag;if(drag){drag.element.onpointermove=null;drag.element.onpointerup=null;drag.element.onpointercancel=null;
    if(drag.element.hasPointerCapture(drag.pointer))drag.element.releasePointerCapture(drag.pointer);}
  objectDrag=null;document.querySelectorAll('.snap-guide').forEach(el=>el.remove());
  if(restore){if(pageBaseImage)pageRenderer.paint(pageBaseImage);objectFrame?.classList.remove('dragging');}
  return drag;
}
function cancelObjectDrag(){releaseObjectDrag();positionObjectFrame(objectBox);fillObjectControls();}
async function finishObjectDrag(){
  const drag=releaseObjectDrag(!objectDrag?.moved);if(!drag)return;
  if(drag.moved){
    objectFrame?.classList.add('dragging');
    if(!await objectMutation('transform',{rect:drag.target})){if(pageBaseImage)pageRenderer.paint(pageBaseImage);objectFrame?.classList.remove('dragging');positionObjectFrame(objectBox);fillObjectControls();}
  }
}
async function objectMutation(operation,extra={}){
  if(busy||!objectIds.size)return false;
  return mutate('edit',{action:'objects',objects:[...objectIds],operation,...extra});
}
function initObjects(){
  $('object-filter').onchange=()=>{clearObjects();drawHits();};
  $('apply-object').onclick=()=>{
    const x=Number($('object-x').value),y=Number($('object-y').value);let w=Number($('object-width').value),h=Number($('object-height').value);
    if(objectBox&&$('object-aspect').checked){const oldW=objectBox[2]-objectBox[0],oldH=objectBox[3]-objectBox[1];if(Math.abs(w-oldW)>.02)h=w*oldH/oldW;else if(Math.abs(h-oldH)>.02)w=h*oldW/oldH;}
    if(![x,y,w,h].every(Number.isFinite)||w<1||h<1)return notify('Enter valid position and size values.',true);
    objectMutation('transform',{rect:[x,y,x+w,y+h]});
  };
  $('object-width').oninput=()=>{if(objectBox&&$('object-aspect').checked)$('object-height').value=(Number($('object-width').value)*(objectBox[3]-objectBox[1])/(objectBox[2]-objectBox[0])).toFixed(2);};
  $('object-height').oninput=()=>{if(objectBox&&$('object-aspect').checked)$('object-width').value=(Number($('object-height').value)*(objectBox[2]-objectBox[0])/(objectBox[3]-objectBox[1])).toFixed(2);};
  $('apply-object-color').onclick=()=>{
    const payload={};if(!$('object-fill').disabled)payload.fill=$('object-fill').value;if(!$('object-stroke').disabled)payload.stroke=$('object-stroke').value;
    objectMutation('style',payload);
  };
  $('object-front').onclick=()=>objectMutation('front');$('object-back').onclick=()=>objectMutation('back');$('object-delete').onclick=()=>objectMutation('delete');
  $('clear-objects').onclick=()=>{clearObjects();syncSelectionUI();drawHits();};
}
