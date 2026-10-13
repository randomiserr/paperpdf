'use strict';

let findPreview=null, redactionArea=null, savedSignature=null, useCurrentDate=true;

function localDateValue(now=new Date()){
  return [now.getFullYear(),String(now.getMonth()+1).padStart(2,'0'),String(now.getDate()).padStart(2,'0')].join('-');
}
function findRequest(){
  return {query:$('find-query').value,scope:$('find-scope').value,case_sensitive:$('find-case').checked};
}
function clearFindPreview(){
  findPreview=null;redactionArea=null;
  $('find-results').replaceChildren();$('find-summary').textContent='Find exact text to preview the matches.';
  $('area-summary').textContent='Drag over sensitive information, then apply.';
  syncFindAction();if(doc&&tool==='find')drawHits();
}
function invalidateFind(){
  if((findPreview&&(findPreview.id!==doc.id||findPreview.revision!==doc.revision||
      (findPreview.request.scope==='page'&&findPreview.page!==doc.page)))||
      (redactionArea&&(redactionArea.id!==doc.id||redactionArea.revision!==doc.revision||redactionArea.page!==doc.page)))clearFindPreview();
}
function syncFindAction(){
  const area=$('find-target').value==='area',replace=$('find-operation').value==='replace';
  $('find-text-options').hidden=area;$('area-summary').hidden=!area;
  $('find-operation').querySelector('option[value="replace"]').disabled=area;
  if(area&&replace)$('find-operation').value='blackout';
  const operation=$('find-operation').value;
  $('find-replacement-options').hidden=operation!=='replace';
  $('redaction-explanation').hidden=operation==='replace';
  const ready=area?redactionArea:findPreview?.matches.length;
  $('apply-find').disabled=!doc||!ready||(operation==='replace'&&!$('find-replacement').value);
  $('apply-find').textContent=(operation==='replace'?'Replace':operation==='remove'?'Remove':'Blackout')+(area?' selected area':' all matches');
}
function syncBasicTools(){
  for(const name of ['find','signature','date'])$(name+'-options').hidden=tool!==name;
  if(tool==='find')syncFindAction();
  if(tool==='signature')loadSavedSignature();
}
function drawFindMatches(){
  if(!doc)return;
  const areas=$('find-target').value==='area'?(redactionArea?[redactionArea]:[]):findPreview?.matches||[];
  for(const area of areas){
    if(area.page!==doc.page)continue;
    const [x0,y0,x1,y1]=area.rect,overlay=document.createElement('div');overlay.className='find-match';
    Object.assign(overlay.style,{left:x0*zoom+'px',top:y0*zoom+'px',width:(x1-x0)*zoom+'px',height:(y1-y0)*zoom+'px'});
    $('interaction-layer').append(overlay);
  }
}
function setRedactionArea(rect){
  redactionArea={rect,page:doc.page,id:doc.id,revision:doc.revision};
  $('area-summary').textContent='Area selected. Apply to remove its contents securely.';
  syncFindAction();drawHits();
}
async function searchDocument(){
  if(!doc||busy||!await finishInline())return;
  clearFindPreview();
  await working(async()=>{
    const request=findRequest(),result=await api('/api/find',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({id:doc.id,revision:doc.revision,page:doc.page,...request})});
    findPreview={...result,request,id:doc.id,page:doc.page};
    const skipped=result.unsearchable_pages.length;
    $('find-summary').textContent=`${result.count} match(es).`+(skipped?` ${skipped} page(s) have no searchable text; use Draw an area for scans.`:'');
    for(const [index,match] of result.matches.slice(0,100).entries()){
      const button=document.createElement('button');button.type='button';button.className='find-result';
      button.textContent=`${index+1}. Page ${match.page+1}: ${match.text}`;
      button.onclick=()=>goPage(match.page);$('find-results').append(button);
    }
    if(result.count>100){const more=document.createElement('p');more.className='small';more.textContent='Showing the first 100 matches. The action applies to all matches.';$('find-results').append(more);}
    syncFindAction();drawHits();
  },{overlay:false});
}
async function applyFindAction(){
  if(!doc||busy||!await finishInline())return;
  invalidateFind();
  const operation=$('find-operation').value;
  let payload;
  if($('find-target').value==='area'){
    if(!redactionArea)return;
    payload={action:'redact',mode:operation,rect:redactionArea.rect};
  }else{
    if(!findPreview?.matches.length)return;
    payload={...findPreview.request,action:operation==='replace'?'replace_text':'redact',
      mode:operation,replacement:$('find-replacement').value};
  }
  const succeeded=await mutate('edit',payload);
  if(succeeded){clearFindPreview();thumbnails();}
}
function showSavedSignature(info){
  savedSignature=info.saved?info:null;
  $('signature-preview').hidden=!info.saved;$('clear-signature').hidden=!info.saved;
  if(info.saved)$('saved-signature').src='data:image/png;base64,'+info.image;
  else $('saved-signature').removeAttribute('src');
}
async function loadSavedSignature(){
  try{showSavedSignature(await api('/api/signature'));}catch(error){notify(error.message,true);}
}
async function storeSignature(payload){
  if(busy)return;
  await working(async()=>{
    const info=await api('/api/signature',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
    showSavedSignature(info);notify(info.saved?'Signature saved on this computer. Click the page to place it.':'Saved signature removed.');
  },{overlay:false});
}
async function basicPageClick(event){
  if(tool==='find')return;
  if(tool==='date'){
    if(useCurrentDate)$('date-value').value=localDateValue();
    await mutate('edit',{action:'date',point:pagePoint(event),date:$('date-value').value,
      format:$('date-format').value,size:Number($('date-size').value),color:$('date-color').value});
  }else if(tool==='signature'){
    if(!savedSignature)return notify('Choose an image or create a signature first.',true);
    const point=pagePoint(event),width=Number($('signature-width').value);
    if(!Number.isFinite(width)||width<10||width>1000)return notify('Choose a signature width between 10 and 1,000 points.',true);
    const rect=imagePlacement(doc.width,doc.height,savedSignature.width/savedSignature.height,width,point);
    const previous=new Set(doc.objects.map(object=>object.id));
    if(await mutate('edit',{action:'signature',rect})){
      const image=doc.objects.find(object=>object.kind==='image'&&!previous.has(object.id));
      await setTool('select');if(image)selectObjects([image.id]);
    }
  }
}
function initBasicTools(){
  $('date-value').value=localDateValue();
  $('date-value').onchange=()=>{useCurrentDate=false;};
  $('date-today').onclick=()=>{useCurrentDate=true;$('date-value').value=localDateValue();};
  for(const id of ['find-query','find-scope','find-case'])$(id).addEventListener('input',clearFindPreview);
  $('find-target').onchange=()=>{clearFindPreview();syncFindAction();};
  $('find-operation').onchange=syncFindAction;$('find-replacement').oninput=syncFindAction;
  $('find-query').onkeydown=event=>{if(event.key==='Enter'){event.preventDefault();searchDocument();}};
  $('find-matches').onclick=searchDocument;$('apply-find').onclick=applyFindAction;
  $('choose-signature').onclick=()=>{if(!busy)$('signature-input').click();};
  $('generate-signature').onclick=()=>storeSignature({name:$('signature-name').value});
  $('clear-signature').onclick=()=>storeSignature({clear:true});
  $('signature-input').onchange=async event=>{
    const file=event.target.files[0];event.target.value='';if(!file||busy)return;
    if(file.size>2*1024*1024)return notify('Choose a signature image smaller than 2 MB.',true);
    try{
      const image=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(new Error('Could not read the signature image.'));reader.readAsDataURL(file);});
      await storeSignature({image:image.split(',')[1]});
    }catch(error){notify(error.message,true);}
  };
}
