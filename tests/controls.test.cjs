const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {test}=require('node:test');
const source=fs.readFileSync(require('node:path').join(__dirname,'../static/app.js'),'utf8');
function install(context,names){
  for(const name of names){const start=source.indexOf('function '+name+'('),end=source.indexOf('\n}',start)+2;vm.runInContext(source.slice(start,end),context);}
}
function geometry(){const context=vm.createContext({});install(context,['imagePlacement','textBoxBounds']);return context;}
test('upload placement centers an image without an additional page click',()=>{
  assert.deepEqual(Array.from(geometry().imagePlacement(360,480,1,180)),[90,150,270,330]);
});
test('wide and tall uploads retain proportions and stay within the page',()=>{
  const context=geometry();
  for(const ratio of [.01,.5,2,100]){
    const [x0,y0,x1,y1]=context.imagePlacement(360,480,ratio,1000,[350,470]);
    assert.ok(x0>=0&&y0>=0&&x1<=360&&y1<=480);
    assert.ok(Math.abs((x1-x0)/(y1-y0)-ratio)<.000001);
  }
});
test('corner handles resize towards the dragged corner and keep the opposite corner fixed',()=>{
  const context=geometry();
  assert.deepEqual(Array.from(context.textBoxBounds([40,50,140,80],'se',30,40,500,700)),[40,50,170,120]);
  assert.deepEqual(Array.from(context.textBoxBounds([40,50,140,80],'nw',-100,-80,500,700)),[0,0,140,80]);
});
test('the text grip moves a box without resizing it or leaving the page',()=>{
  assert.deepEqual(Array.from(geometry().textBoxBounds([40,50,140,80],'move',1000,-100,500,700)),[400,0,500,30]);
});
test('font spinner input updates repeatedly without taking focus away from its field',()=>{
  const nodes=new Map(),node=id=>{if(!nodes.has(id))nodes.set(id,{value:'12',style:{},setAttribute(name,value){this[name]=value;}});return nodes.get(id);};
  const context=vm.createContext({$:node,busy:false,zoom:1,doc:{width:500,height:700},focusCalls:0,
    document:{activeElement:node('inline-size'),querySelector:()=>({contains:()=>true}),
      createRange:()=>({collapsed:true,selectNodeContents(){},collapse(){}})},
    richRuns:()=>context.runs,richFragment:runs=>{context.runs=runs;return runs;},
    restoreRange:range=>{context.inline.range=range;}
  });
  context.runs=[{text:'Text',size:12,font:'Helvetica'}];
  context.inline={input:{style:{},offsetHeight:24,contains:()=>false,replaceChildren(){},focus:()=>context.focusCalls++},
    frame:{style:{}},range:{collapsed:true},defaultStyle:{size:12,font:'Helvetica'},
    size:12,width:120,left:36,top:75,initialSize:12,initialBaselineOffset:9,baselineOffset:9,spacing:1.35,minimumHeight:0};
  install(context,['rememberSelection','applyTextStyle','styleInline']);
  vm.runInContext(source.split('\n').find(line=>line.startsWith("$('inline-size').oninput=")),context);
  for(const size of [13,14,24]){node('inline-size').value=String(size);node('inline-size').oninput();}
  assert.equal(context.inline.size,24);assert.equal(context.runs[0].size,24);
  assert.equal(context.inline.width,240);assert.equal(context.inline.input.style.fontSize,'24px');
  assert.equal(context.focusCalls,0);assert.equal(context.document.activeElement,node('inline-size'));
  assert.equal(node('inline-size').value,'24');
  context.applyTextStyle({bold:true});assert.equal(node('format-bold')['aria-pressed'],'true');
  assert.equal(context.focusCalls,0);
});
test('formatting from a field stores its text range without focusing the contenteditable',()=>{
  const saved={collapsed:true},context=vm.createContext({inline:{},window:{getSelection:()=>{throw new Error('Restoring browser selection would steal focus');}}});
  install(context,['restoreRange']);context.restoreRange({cloneRange:()=>saved},false);
  assert.equal(context.inline.range,saved);
});
