const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync('static/app.js','utf8');
const start=source.indexOf('async function savePDF('),end=source.indexOf('\n}',start)+2;

function setup({commit=true,saved=true,error=false}={}){
  const events=[],nodes=new Map();
  const node=id=>{if(!nodes.has(id))nodes.set(id,{});return nodes.get(id);};
  const context=vm.createContext({$:node,doc:{id:'fixture',revision:0,name:'fixture.pdf'},busy:false,savePending:false,dirty:true,
    working:async callback=>{context.busy=true;try{await callback();return true;}catch{events.push('error');return false;}finally{context.busy=false;}},
    finishInline:async()=>{events.push('commit');if(commit)context.doc.revision++;return commit;},
    api:async(path,options)=>{events.push('dialog');assert.equal(path,'/api/save');assert.equal(JSON.parse(options.body).revision,1);if(error)throw Error('Disk full');return {saved,revision:1};},
    updateUI:()=>events.push('ui')});
  vm.runInContext(source.slice(start,end),context);
  return {context,node,events};
}

test('save commits the current draft and opens a dialog before marking it saved',async()=>{
  const {context,node,events}=setup();const pending=context.savePDF();
  assert.equal(node('download').disabled,true);assert.equal(context.dirty,true);
  await pending;assert.deepEqual(events,['commit','dialog','ui']);
  assert.equal(context.dirty,false);assert.equal(node('file-status').textContent,'Saved');
});
test('dialog cancellation keeps changes marked modified and re-enables saving',async()=>{
  const {context,node,events}=setup({saved:false});await context.savePDF();
  assert.deepEqual(events,['commit','dialog']);assert.equal(context.dirty,true);assert.equal(node('download').disabled,false);
});
test('failed save preserves the modified state',async()=>{
  const {context,events}=setup({error:true});await context.savePDF();
  assert.deepEqual(events,['commit','dialog','error']);assert.equal(context.dirty,true);
});
test('failed draft commit prevents export and repeated clicks open only one dialog',async()=>{
  const {context,events}=setup({commit:false});const first=context.savePDF();await context.savePDF();await first;
  assert.deepEqual(events,['commit']);assert.equal(context.savePending,false);assert.equal(context.dirty,true);
  const success=setup();const save=success.context.savePDF();await success.context.savePDF();await save;
  assert.deepEqual(success.events,['commit','dialog','ui']);
});
