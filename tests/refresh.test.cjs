const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {test}=require('node:test');
const source=fs.readFileSync(require('node:path').join(__dirname,'../static/app.js'),'utf8');

class Canvas {
  constructor(){this._width=0;this._height=0;this.resizes=0;this.draws=[];}
  set width(value){this._width=value;this.resizes++;this.reset();}
  get width(){return this._width;}
  set height(value){this._height=value;this.resizes++;this.reset();}
  get height(){return this._height;}
  reset(){this.pixels=new Uint32Array(this.width*this.height);}
  getContext(){return {
    drawImage:(image,...args)=>{
      this.draws.push(args);
      const [sx,sy,w,h,dx,dy]=args.length===2?[0,0,image.naturalWidth,image.naturalHeight,0,0]:args;
      for(let y=0;y<h;y++)for(let x=0;x<w;x++)this.pixels[(dy+y)*this.width+dx+x]=image.pixels[(sy+y)*image.naturalWidth+sx+x];
    },
    getImageData:()=>({data:new Uint8ClampedArray(this.pixels.slice().buffer)})
  };}
}
function renderer(){
  const context=vm.createContext({document:{createElement:()=>new Canvas()},Uint32Array});
  vm.runInContext(source.slice(0,source.indexOf('const $ ='))+';globalThis.Renderer=PageRenderer;',context);
  const canvas=new Canvas();return {canvas,renderer:new context.Renderer(canvas)};
}
function image(width=130,height=130){return {naturalWidth:width,naturalHeight:height,pixels:new Uint32Array(width*height).fill(0xffffffff)};}
test('unchanged pages never clear or repaint the visible canvas',()=>{
  const state=renderer(),page=image();state.renderer.paint(page);
  const resizes=state.canvas.resizes;state.canvas.draws=[];state.renderer.paint(page);
  assert.equal(state.canvas.resizes,resizes);assert.equal(state.canvas.draws.length,0);
});
test('a small edit repaints one tile, preserving every other pixel',()=>{
  const state=renderer(),before=image(),after=image();state.renderer.paint(before);
  after.pixels[100*130+100]=0xff335577;state.canvas.draws=[];state.renderer.paint(after);
  assert.deepEqual(state.canvas.draws,[[64,64,64,64,64,64,64,64]]);
  assert.deepEqual(state.canvas.pixels,after.pixels);
});
test('moving an element clears its old tile and paints its new tile',()=>{
  const state=renderer(),before=image(),after=image();before.pixels[2*130+2]=0xff335577;after.pixels[129*130+129]=0xff335577;
  state.renderer.paint(before);state.canvas.draws=[];state.renderer.paint(after);
  assert.equal(state.canvas.draws.length,2);assert.deepEqual(state.canvas.pixels,after.pixels);
});
test('a page size change draws a complete new bitmap',()=>{
  const state=renderer();state.renderer.paint(image());const after=image(80,60);state.renderer.paint(after);
  assert.equal(state.canvas.width,80);assert.equal(state.canvas.height,60);assert.deepEqual(state.canvas.pixels,after.pixels);
});

function deferred(){let resolve,reject;const promise=new Promise((ok,fail)=>{resolve=ok;reject=fail;});return {promise,resolve,reject};}
function refreshContext(){
  const nodes=new Map(),node=id=>{
    if(!nodes.has(id))nodes.set(id,{hidden:true,style:{},clientWidth:500,clientHeight:650,inert:false,
      setAttribute(name,value){this[name]=value;},removeAttribute(name){delete this[name];}});
    return nodes.get(id);
  };
  const save=deferred(),render=deferred();
  const context=vm.createContext({$:node,document:{querySelector:node},busy:false,
    inline:{input:{contentEditable:'true'},frame:{querySelectorAll:()=>[node('done')]}},zoom:1,
    doc:{id:'sample',revision:0,page:0},dirty:false,objectBox:null,
    settings:{select:{hint:''}},tool:'select',pageBaseImage:{},
    api:()=>save.promise,
    showPage:async data=>{await render.promise;context.doc=data;context.inline=null;context.commits++;},
    resetSelection:()=>{context.inline=null;},layout:()=>{},updateUI:()=>{},selectObjects:()=>{},
    notify:message=>context.messages.push(message),messages:[],commits:0
  });
  for(const name of ['working','mutate']){
    const start=source.indexOf('async function '+name+'('),end=source.indexOf('\n}',start)+2;
    vm.runInContext(source.slice(start,end),context);
  }
  // A selection is unnecessary for undo, which exercises the same asynchronous update path.
  context.inline.input.getBoundingClientRect=()=>({left:20,top:20,right:180,bottom:60});
  context.inline.origin=[20,20];node('page-surface').getBoundingClientRect=()=>({left:0,top:0});
  return {context,node,save,render};
}
test('saving leaves the draft visible until the next bitmap is decoded, without an overlay',async()=>{
  const {context,node,save,render}=refreshContext(),editor=context.inline;
  const pending=vm.runInContext("mutate('undo')",context);
  assert.equal(node('busy').hidden,true);assert.equal(node('edit-progress').hidden,false);
  assert.equal(context.inline,editor);assert.equal(editor.input.contentEditable,'false');
  save.resolve({id:'sample',page:0,revision:1});await new Promise(resolve=>setImmediate(resolve));
  assert.equal(context.inline,editor);assert.equal(context.commits,0);
  render.resolve();assert.equal(await pending,true);assert.equal(context.commits,1);
  assert.equal(node('edit-progress').hidden,true);assert.equal(context.busy,false);
});
test('a failed edit keeps the draft and restores its controls',async()=>{
  const {context,node,save}=refreshContext(),editor=context.inline;
  const pending=vm.runInContext("mutate('undo')",context);save.reject(new Error('Save failed'));
  assert.equal(await pending,false);assert.equal(context.inline,editor);
  assert.equal(editor.input.contentEditable,'true');assert.equal(node('done').disabled,false);
  assert.equal(context.doc.revision,0);assert.equal(node('edit-progress').hidden,true);
});
test('a preview failure retains the saved revision so retrying cannot replay the edit',async()=>{
  const {context,save,render}=refreshContext();const pending=vm.runInContext("mutate('undo')",context);
  save.resolve({id:'sample',page:0,revision:1});render.reject(new Error('Decode failed'));
  assert.equal(await pending,false);assert.equal(context.doc.revision,1);assert.equal(context.dirty,true);
  assert.match(context.messages[0],/Edit saved/);assert.equal(context.busy,false);
});

function dragContext(){
  const objects=fs.readFileSync(require('node:path').join(__dirname,'../static/objects.js'),'utf8');
  const commit=deferred(),classes=new Set(['dragging']);
  const context=vm.createContext({objectDrag:{moved:true,target:[10,20,40,50],pointer:1,
    element:{hasPointerCapture:()=>false}},objectBox:[0,0,30,30],pageBaseImage:{},
    pageRenderer:{paint:()=>context.paints++},paints:0,
    objectFrame:{classList:{add:name=>classes.add(name),remove:name=>classes.delete(name)}},
    document:{querySelectorAll:()=>[]},objectMutation:()=>commit.promise,
    positionObjectFrame:box=>context.position=box,fillObjectControls:()=>{}
  });
  for(const name of ['releaseObjectDrag','finishObjectDrag']){
    const start=objects.indexOf((name==='finishObjectDrag'?'async ':'')+'function '+name+'(');
    const end=objects.indexOf('\n}',start)+2;vm.runInContext(objects.slice(start,end),context);
  }
  return {context,commit,classes};
}
test('a released drag keeps the moved preview visible while saving',async()=>{
  const {context,commit,classes}=dragContext();const pending=vm.runInContext('finishObjectDrag()',context);
  assert.equal(context.paints,0);assert.equal(classes.has('dragging'),true);assert.equal(context.position,undefined);
  commit.resolve(true);await pending;assert.equal(context.paints,0);
});
test('a failed drag commit restores the original bitmap and bounds',async()=>{
  const {context,commit,classes}=dragContext();const pending=vm.runInContext('finishObjectDrag()',context);
  commit.resolve(false);await pending;assert.equal(context.paints,1);
  assert.equal(classes.has('dragging'),false);assert.deepEqual(context.position,context.objectBox);
});
