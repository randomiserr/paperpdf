'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../static/basic-tools.js'),'utf8');
function install(context,names){
  for(const name of names){const start=source.indexOf('function '+name+'('),end=source.indexOf('\n}',start)+2;vm.runInContext(source.slice(start,end),context);}
}
test('today uses the user local calendar day at midnight and year boundaries',()=>{
  const context=vm.createContext({});install(context,['localDateValue']);
  const now={getFullYear:()=>2027,getMonth:()=>0,getDate:()=>1,toISOString:()=>{throw Error('UTC date would select the wrong local day');}};
  assert.equal(context.localDateValue(now),'2027-01-01');
});
test('search results become unusable after an edit, a document change, or a scoped page change',()=>{
  for(const change of [{revision:2},{id:'other'},{page:1}]){
    const context=vm.createContext({doc:{id:'document',revision:1,page:0,...change},
      findPreview:{id:'document',revision:1,page:0,request:{scope:'page'},matches:[{}]},
      redactionArea:null,cleared:false,clearFindPreview(){this.cleared=true;}});
    context.clearFindPreview=()=>{context.cleared=true;};install(context,['invalidateFind']);
    context.invalidateFind();assert.equal(context.cleared,true);
  }
});
test('whole-document search remains available when navigating to a match on another page',()=>{
  const context=vm.createContext({doc:{id:'document',revision:1,page:1},
    findPreview:{id:'document',revision:1,page:0,request:{scope:'all'},matches:[{}]},
    redactionArea:null,clearFindPreview:()=>{throw Error('Page navigation must not discard a valid whole-document preview');}});
  install(context,['invalidateFind']);context.invalidateFind();
});
test('area redaction cannot reuse a rectangle from a previous page',()=>{
  const context=vm.createContext({doc:{id:'document',revision:1,page:1},findPreview:null,
    redactionArea:{id:'document',revision:1,page:0},clearFindPreview:()=>{context.redactionArea=null;}});
  install(context,['invalidateFind']);context.invalidateFind();assert.equal(context.redactionArea,null);
});
