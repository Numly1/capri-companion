'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const base = fs.existsSync(path.join(__dirname, '../src/renderer/js/companion-visits.js')) ? path.join(__dirname, '../src/renderer/js') : path.join(__dirname, '../renderer/js');
const load = source => import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const guestSource = fs.readFileSync(path.join(base, 'companion-visit-guest.js'), 'utf8').replace(/^import .*;\r?$/gm, '');
const guestReady = load(`const SpriteRenderer=class{}; const Player=class{}; const SPRITE={width:240,height:420,pad:56}; const NEUTRAL={head:0,mane:0,hair:0,tilt:0,armL:0,armR:0,longL:1,longR:1,kickL:0,kickR:0,smear:[0,0],echo:[0,0]};\n${guestSource}`);
let visitsReady;
async function modules() {
  const guest = await guestReady;
  visitsReady ||= load(fs.readFileSync(path.join(base, 'companion-visits.js'), 'utf8').replace("import { GuestSprite, visitGuest, visitName } from './companion-visit-guest.js';", `const GuestSprite=class{};const visitName=${guest.visitName.toString()};const visitGuest=${guest.visitGuest.toString()};`));
  return { guest, visits: await visitsReady };
}

class Element {
  constructor(tag) { this.tag=tag;this.style={};this.attributes={};this.children=[];this.hidden=false; }
  setAttribute(key,value){this.attributes[key]=String(value);}
  appendChild(child){this.children.push(child);child.parent=this;return child;}
  insertBefore(child,before){const at=this.children.indexOf(before);this.children.splice(at<0?this.children.length:at,0,child);child.parent=this;}
  remove(){this.removed=true;if(this.parent)this.parent.children=this.parent.children.filter(item=>item!==this);}
  getContext(){return{clearRect(){},drawImage(){}};}
}
const documentFixture=()=>({head:new Element('head'),body:new Element('body'),createElement:tag=>new Element(tag)});
const guestData=(extra={})=>({name:'Капри от Саши',mood:'idle',facing:1,scale:.55,visitId:'visit_1',...extra});
const paired=(extra={})=>({paired:true,peerName:'Подруга',connection:'paired',listening:false,away:false,guest:null,...extra});
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('guest input is bounded and literal, with only local pose/facing/scale fields accepted',async()=>{
  const {guest,visits}=await modules();
  assert.equal(Array.from(guest.visitName('😀'.repeat(40))).length,24);
  assert.equal(guest.visitName(' A\n\u202eB '),'A B');
  assert.equal(guest.visitGuest({name:'x',visitId:'../path'}),null);
  assert.deepEqual(guest.visitGuest(guestData({scale:900,facing:99,mood:'run-shell',url:'https://evil',command:'powershell'})),guestData({scale:.8,facing:1,mood:'idle'}));
  const state=visits.visitState(paired({guest:guestData(),apiKeys:{secret:'NEVER'},error:'UNTRUSTED ERROR BODY'}));
  assert.doesNotMatch(JSON.stringify(state),/NEVER|UNTRUSTED/);
  assert.equal(visits.visitState({paired:false,away:true,guest:guestData()}).away,false);
  assert.equal(visits.visitState({paired:false,away:true,guest:guestData()}).guest,null);
  assert.equal(visits.invitationCode('https://example.com/capri1.secret'),null);
  assert.equal(visits.invitationCode('capri1.'+'A'.repeat(1100)),null);
  assert.equal(visits.invitationCode(' capri1.'+'A'.repeat(50)+' '),'capri1.'+'A'.repeat(50));
});

test('guest uses original renderer art, no global drag handlers, and stops its loop/GPU context on disposal',async()=>{
  const {guest}=await modules(); const doc=documentFixture();let now=0,next=0,lost=0;const callbacks=new Map(),listeners=new Map(),draws=[];const image={localArt:true};
  class Renderer{constructor(canvas,source){assert.equal(source,image);this.gl={getExtension:()=>({loseContext(){lost++;}})};}resize(scale){this.scale=scale;}draw(pose){draws.push(pose);}}
  class Pose{constructor(name){this.name=name;}sample(){return{pose:{bob:-2},index:0};}resolve(pose){return pose;}}
  const win={innerWidth:1000,innerHeight:700,addEventListener:(name,fn)=>listeners.set(name,fn),removeEventListener:(name,fn)=>{if(listeners.get(name)===fn)listeners.delete(name);}};
  const sprite=new guest.GuestSprite({image,guest:guestData({name:'<img onerror=evil>'})},{document:doc,window:win,now:()=>now,SpriteRenderer:Renderer,Player:Pose,requestAnimationFrame:fn=>{callbacks.set(++next,fn);return next;},cancelAnimationFrame:id=>callbacks.delete(id)});
  assert.equal(sprite.label.textContent,'В гостях · <img onerror=evil>');assert.equal(sprite.root.style.pointerEvents,'none');
  assert.deepEqual([...listeners.keys()],['resize']);assert.equal(callbacks.size,1);assert.ok(draws.length>0);
  now=1500;const [id,callback]=callbacks.entries().next().value;callbacks.delete(id);callback(now);assert.equal(callbacks.size,1);
  sprite.configure({visible:false});assert.equal(sprite.root.hidden,true);assert.equal(callbacks.size,0);
  sprite.configure({visible:true});assert.equal(sprite.root.hidden,false);assert.equal(callbacks.size,1);
  sprite.dispose();sprite.dispose();assert.equal(callbacks.size,0);assert.equal(listeners.size,0);assert.equal(lost,1);assert.equal(sprite.root.removed,true);
});

test('reduced-motion guest is static and schedules no animation frames',async()=>{
  const {guest}=await modules();let frames=0;const poses=[];
  class Renderer{resize(scale){this.scale=scale;}draw(pose){poses.push(pose);}}
  const sprite=new guest.GuestSprite({image:{},guest:guestData()},{document:documentFixture(),window:{innerWidth:800,innerHeight:600,addEventListener(){},removeEventListener(){}},now:()=>100,SpriteRenderer:Renderer,Player:class{},reduced:()=>true,requestAnimationFrame:()=>{frames++;return 1;},cancelAnimationFrame(){}});
  const position=sprite.root.style.transform;sprite.render(10000,true);
  assert.equal(sprite.root.style.transform,position);assert.equal(frames,0);assert.ok(poses.every(pose=>pose.glitch===0&&pose.collapse===0&&pose.boil===0));sprite.dispose();
});

async function fixture({state=paired(),asks=[],texts=[],handler}={}){
  const {visits}=await modules();const listeners={},requests=[],away=[],shown=[],guests=[],sceneOptions=[];let current=state;
  const panel={visible:false,say:data=>{shown.push(data);return true;},resume(){}};
  const host={onVisits:fn=>{listeners.state=fn;return()=>{listeners.removed=(listeners.removed||0)+1;};},onConfig:fn=>{listeners.config=fn;return()=>{listeners.removed=(listeners.removed||0)+1;};},visitsAction:async request=>{
    requests.push(request);if(handler){const custom=await handler(request);if(custom!==undefined)return custom;}
    if(request.action==='state')return{ok:true,state:current};
    if(request.action==='options')return{ok:true,addresses:[{kind:'lan',address:'192.168.1.3'},{kind:'radmin',address:'26.1.2.3'},{kind:'loopback',address:'127.0.0.1'}]};
    if(request.action==='invite')return{ok:true,code:'capri1.'+'A'.repeat(50)};
    if(request.action==='join')current=paired();if(request.action==='visit')current=paired({away:true});if(request.action==='return')current=paired();if(request.action==='disconnect')current={paired:false,connection:'off'};
    return{ok:true};
  }};
  const guide={running:false,async scene(play,options){sceneOptions.push(options);this.running=true;try{await play();}finally{this.running=false;}},ask:async data=>{shown.push(data);return asks.shift()??null;},askText:async data=>{shown.push(data);return texts.shift()??null;},answer(){}};
  class Guest{constructor({guest}){this.data=guest;guests.push(this);}configure(cfg){this.cfg=cfg;}update(data){this.data=data;}dispose(){this.disposed=true;}}
  const component=new visits.CompanionVisits({host,capri:{mode:'idle',facing:1,scale:.6,busy:false},panel,chat:{open:false},guide,image:{local:true},onAwayChange:value=>away.push(value)},{document:documentFixture(),GuestSprite:Guest});
  await tick();return{component,listeners,requests,away,shown,guests,guide,panel,sceneOptions,setState:value=>{current=value;listeners.state(value);}};
}

test('arrival keeps main pet intact, respects manual hiding, and consumes greetings during chat without queueing',async()=>{
  const f=await fixture();f.component.configure({visible:false});f.setState(paired({guest:guestData()}));
  assert.equal(f.guests.length,1);assert.equal(f.guests[0].cfg.visible,false);assert.equal(f.shown.length,0);assert.deepEqual(f.away,[]);
  f.component.configure({visible:true});f.setState(paired({guest:guestData()}));assert.equal(f.shown.length,0,'same hidden arrival is not queued');
  f.component.chat.open=true;f.setState(paired({guest:guestData({visitId:'visit_2'})}));assert.equal(f.guests[0].disposed,true);assert.equal(f.shown.length,0);
  f.component.chat.open=false;f.setState(paired({guest:guestData({visitId:'visit_2'})}));assert.equal(f.shown.length,0);
  f.setState(paired({guest:guestData({visitId:'visit_3'})}));assert.equal(f.shown.length,1);
  f.setState({paired:false,connection:'off'});assert.equal(f.guests.at(-1).disposed,true);assert.equal(f.component.guest,null);
  f.component.dispose();assert.equal(f.listeners.removed,2);
});

test('runtime away and disconnect restore callbacks never persist or force the visible setting',async()=>{
  const f=await fixture();f.component.configure({visible:false});f.setState(paired({away:true}));f.setState(paired({away:true}));f.setState({paired:false,connection:'error',away:true});
  assert.deepEqual(f.away,[true,false]);assert.equal(f.component.cfg.visible,false);
  assert.equal(f.requests.some(request=>request.action==='setConfig'||'apiKeys'in request),false);f.component.dispose();
});

test('visit controls preserve stowed state and support join, send, return, and end with closed actions',async()=>{
  const f=await fixture({state:{paired:false,connection:'off'},asks:['join','visit','return','disconnect','close'],texts:[{text:'capri1.'+'A'.repeat(50)},{text:'Капри от Саши'}]});
  f.component.configure({visible:false});await f.component.open();
  assert.deepEqual(f.sceneOptions,[{keepStowed:true}]);
  assert.deepEqual(f.requests.filter(request=>['join','visit','return','disconnect'].includes(request.action)).map(request=>request.action),['join','visit','return','disconnect']);
  assert.deepEqual(f.away,[true,false]);assert.equal(f.component.cfg.visible,false);
  assert.equal(f.shown.find(item=>item.placeholder?.startsWith('Приглашение')).secret,true);assert.equal(f.component.invitation,null);f.component.dispose();
});

test('invitation selects an actual Radmin address first and copies only after an explicit button press',async()=>{
  const f=await fixture({state:{paired:false,connection:'off'},asks:['invite','address:0','copy','ok','close'],texts:[{text:'Моя Капри'}]});
  await f.component.open();const invite=f.requests.find(request=>request.action==='invite');const copy=f.requests.find(request=>request.action==='copy');
  assert.equal(invite.address,'26.1.2.3');assert.equal(copy.code,'capri1.'+'A'.repeat(50));assert.equal(f.requests.filter(request=>request.action==='copy').length,1);assert.equal(f.component.invitation,null);f.component.dispose();
});

test('invalid invitation URLs and overlong input never reach a network action',async()=>{
  for(const value of ['https://evil.example','capri1.'+'A'.repeat(1100)]){
    const f=await fixture({state:{paired:false,connection:'off'},asks:['join','ok','close'],texts:[{text:value}]});await f.component.open();assert.equal(f.requests.some(request=>request.action==='join'),false);f.component.dispose();
  }
});

test('late initial state cannot roll back an acknowledged away event and disposal drops listeners/guest',async()=>{
  let finish;const {visits}=await modules();const away=[];let listener;
  const component=new visits.CompanionVisits({host:{onVisits:fn=>{listener=fn;return()=>{};},visitsAction:()=>new Promise(resolve=>{finish=resolve;})},capri:{},panel:{visible:false,say(){}},guide:{},chat:{},image:{},onAwayChange:value=>away.push(value)},{document:documentFixture(),GuestSprite:class{configure(){}dispose(){}}});
  listener(paired({away:true}));finish({ok:true,state:{paired:false}});await tick();assert.equal(component.away,true);assert.deepEqual(away,[true]);component.dispose();assert.deepEqual(away,[true,false]);
});
