'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const moduleUrl = source => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
const read = name => fs.readFileSync(path.join(__dirname, '../src/renderer/js', name), 'utf8');
const panelReady = import(moduleUrl(read('panel.js').replace("import { clamp, ease, reducedMotion } from './util.js';", 'const reducedMotion={matches:false};')));
const speechReady = import(moduleUrl(read('companion-speech.js')));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return {promise,resolve}; };
const audio = text => ({ok:true,audio:'AA==',engine:'reference',spokenText:text});
const flush = () => new Promise(setImmediate);

function element() {
  const classes = new Set();
  return {textContent:'',hidden:false,dataset:{},style:{},classList:{
    add(name){classes.add(name);},remove(name){classes.delete(name);},
    toggle(name,on){if(on)classes.add(name);else classes.delete(name);},contains:name=>classes.has(name),
  }};
}
async function fixture(t,{synthesis,decode,resume}={}) {
  const [{Panel},{CompanionSpeech}] = await Promise.all([panelReady,speechReady]);
  const p=Object.create(Panel.prototype);
  Object.assign(p,{el:element(),tickerEl:element(),line:element(),quote:element(),reply:element(),summary:element(),
    tag:element(),state:element(),labels:{state:{}},speechLease:null,current:null,
    setFace(){},setProgress(){},renderReport(){},renderActions(){},renderChat(){},renderLog(){},
    replayEnter(){},place(){},decode(text){this.line.textContent=text;},
  });
  let portraitStarts=0,portraitStops=0;
  p.portrait={animate(){portraitStarts++;return{cancel(){portraitStops++;}};}};
  const state={contexts:[],sources:[],events:[],activities:[],cancels:0};
  const oldWindow=globalThis.window,oldAudio=globalThis.AudioContext;
  globalThis.window={speechSynthesis:{cancel(){state.cancels++;}}};
  globalThis.AudioContext=class {
    constructor(){this.currentTime=0;this.destination={};state.contexts.push(this);}
    decodeAudioData(){return decode?decode.promise:Promise.resolve({duration:1});}
    resume(){return resume?resume.promise:Promise.resolve();}
    createGain(){return{gain:{value:1},connect(node){return node;},disconnect(){}};}
    createBiquadFilter(){return{frequency:{value:0},connect(node){return node;},disconnect(){}};}
    createDynamicsCompressor(){return{threshold:{value:0},ratio:{value:0},connect(node){return node;},disconnect(){}};}
    createBufferSource(){const source={playbackRate:{value:1},detune:{value:0},connect(node){return node;},disconnect(){},
      start(){this.started=true;},stop(){this.stopped=true;this.onended?.();}};state.sources.push(source);return source;}
  };
  const s=Object.create(CompanionSpeech.prototype);
  Object.assign(s,{panel:p,chat:{open:false},cfg:{companionVoice:true,voiceStyle:'capri-sample',responseLanguage:'ru',volume:.7,offlineChat:false},
    host:{synthesizeSpeech:synthesis||(async({text})=>audio(text))},speechTurn:0,generation:0,
    caption:element(),status:element(),button:{},note(text){this.status.textContent=text;},
    onPlayback(active){state.events.push(active);},onActivity(active){state.activities.push(active);},
  });
  s.caption.hidden=true;
  const show=(text,extra={})=>p.say({kind:'info',line:text,hold:1000,...extra});
  t.after(()=>{s.stop();p.hide();globalThis.window=oldWindow;globalThis.AudioContext=oldAudio;});
  return{p,s,state,show,get portraitStarts(){return portraitStarts;},get portraitStops(){return portraitStops;}};
}

test('slow TTS holds the same readable message; caption and portrait start only with audio and finish releases hold',async t=>{
  t.mock.timers.enable({apis:['setTimeout','setInterval']});
  const synth=deferred();const f=await fixture(t,{synthesis:()=>synth.promise});
  f.show('Мы рядом, чум.');const pending=f.s.say('Мы рядом, чум.');
  assert.equal(f.s.pendingSpeech,true);assert.equal(f.s.playing,false);assert.equal(f.s.caption.hidden,true);
  assert.match(f.s.status.textContent,/Готовлю/);assert.equal(f.p.line.textContent,'Мы рядом, чум.');
  assert.equal(f.portraitStarts,0);
  t.mock.timers.tick(61000);assert.equal(f.p.visible,true,'original short hold must not discard a pending voice');
  synth.resolve(audio('Мы рядом, чум.'));await pending;
  assert.equal(f.s.playing,true);assert.equal(f.s.caption.textContent,'Мы рядом, чум.');assert.equal(f.s.caption.hidden,false);
  assert.equal(f.portraitStarts,1);assert.equal(f.p.el.classList.contains('is-speaking'),true);
  t.mock.timers.tick(10000);assert.equal(f.p.visible,true,'message remains while audio actually plays');
  f.state.sources[0].onended();assert.equal(f.s.playing,false);assert.equal(f.s.caption.hidden,true);assert.equal(f.portraitStops,1);
  t.mock.timers.tick(2499);assert.equal(f.p.visible,true);t.mock.timers.tick(1);assert.equal(f.p.visible,false);
});

test('dismissal while TTS loads discards late audio and cannot overwrite a newer panel',async t=>{
  const synth=deferred();const f=await fixture(t,{synthesis:()=>synth.promise});
  f.show('Старая фраза');const pending=f.s.say('Старая фраза');f.p.hide();f.show('Новая карточка');
  synth.resolve(audio('Старая фраза'));await pending;
  assert.equal(f.state.contexts.length,0);assert.equal(f.s.pendingSpeech,false);assert.equal(f.p.line.textContent,'Новая карточка');
  assert.equal(f.s.caption.hidden,true);assert.equal(f.state.events.includes(true),false);
});

test('replacement during audio decoding does not resume or start the superseded voice',async t=>{
  const decode=deferred();const f=await fixture(t,{decode});
  f.show('Первая');const pending=f.s.say('Первая');await flush();assert.equal(f.state.contexts.length,1);
  f.show('Следующая');decode.resolve({duration:1});await pending;
  assert.equal(f.state.sources.length,0);assert.equal(f.s.pendingSpeech,false);assert.equal(f.p.line.textContent,'Следующая');
});

test('moving a pending message cancels speech and restores its ordinary hide timer on return',async t=>{
  t.mock.timers.enable({apis:['setTimeout','setInterval']});
  const synth=deferred();const f=await fixture(t,{synthesis:()=>synth.promise});
  f.show('До перемещения');const pending=f.s.say('До перемещения');f.p.suspend();
  assert.equal(f.s.pendingSpeech,false);f.p.resume();
  synth.resolve(audio('До перемещения'));await pending;assert.equal(f.state.sources.length,0);
  t.mock.timers.tick(2499);assert.equal(f.p.visible,true);t.mock.timers.tick(1);assert.equal(f.p.visible,false);
});

test('cancel during suspended AudioContext resume prevents audio and all later visual callbacks',async t=>{
  const resume=deferred();const f=await fixture(t,{resume});
  f.show('Первая');const pending=f.s.say('Первая');await flush();f.s.stop();resume.resolve();await pending;
  assert.equal(f.state.sources.length,0);assert.equal(f.s.playing,false);assert.equal(f.state.events.includes(true),false);
});

test('late audio ended events cannot stop the caption or portrait of a newer response',async t=>{
  const f=await fixture(t);f.show('Первая');await f.s.say('Первая');
  const previous=f.state.sources[0].onended;f.show('Вторая');await f.s.say('Вторая');previous();
  assert.equal(f.s.playing,true);assert.equal(f.s.caption.textContent,'Вторая');assert.equal(f.p.el.classList.contains('is-speaking'),true);
  assert.equal(f.state.sources[0].stopped,true);
  f.state.sources[1].onended();assert.equal(f.s.playing,false);
});

test('a new manual chat turn cancels the old voice while streaming text stays available',async t=>{
  const synth=deferred();const f=await fixture(t,{synthesis:()=>synth.promise});
  f.show('Старый ответ',{kind:'chat',chat:{}});const pending=f.s.say('Старый ответ');
  f.p.chatTurn({quote:'Новый вопрос',face:'aside'});
  f.p.stream('Новый ответ сразу доступен',{done:true});
  synth.resolve(audio('Старый ответ'));await pending;
  assert.equal(f.state.sources.length,0);assert.equal(f.p.current.line,'Новый ответ сразу доступен');assert.equal(f.s.pendingSpeech,false);
});

test('an explicit spoken excerpt has an exact caption while the complete chat answer is preserved',async t=>{
  const full='Я рядом. '+('Полный длинный ответ остаётся доступен. '.repeat(20));
  const f=await fixture(t,{synthesis:async()=>({...audio('Я рядом.'),excerpt:true})});
  f.show(full,{kind:'chat',chat:{}});await f.s.say(full);
  assert.equal(f.p.line.textContent,full);assert.equal(f.p.current.line,full);
  assert.equal(f.s.caption.textContent,'Я рядом.');assert.match(f.s.status.textContent,/начало ответа/);
});

test('selected voice failure releases the held message, leaves text and does not start animation',async t=>{
  const f=await fixture(t,{synthesis:async()=>({ok:false,keepSelectedVoice:true,error:'Модуль занят.'})});
  f.show('Текст остаётся');await f.s.say('Текст остаётся');
  assert.equal(f.s.pendingSpeech,false);assert.equal(f.p.speechLease,null);assert.equal(f.p.line.textContent,'Текст остаётся');
  assert.equal(f.s.status.textContent,'Модуль занят.');assert.equal(f.portraitStarts,0);
});

test('muting or hiding while preparing prevents late playback',async t=>{
  for(const patch of [{muted:true},{visible:false}]){
    await t.test(JSON.stringify(patch),async child=>{
      const synth=deferred();const f=await fixture(child,{synthesis:()=>synth.promise});
      f.show('Отменяемая');const pending=f.s.say('Отменяемая');f.s.configure(patch);
      synth.resolve(audio('Отменяемая'));await pending;
      assert.equal(f.state.sources.length,0);assert.equal(f.s.pendingSpeech,false);
    });
  }
});

test('native Windows presentation waits for real utterance start and ignores stale callbacks',async t=>{
  const f=await fixture(t);const utterances=[];const oldUtterance=globalThis.SpeechSynthesisUtterance;
  globalThis.SpeechSynthesisUtterance=class{constructor(text){this.text=text;}};
  window.SpeechSynthesisUtterance=globalThis.SpeechSynthesisUtterance;
  window.speechSynthesis.getVoices=()=>[{localService:true,lang:'ru-RU',name:'Irina'}];
  window.speechSynthesis.speak=utterance=>utterances.push(utterance);
  f.s.cfg.voiceStyle='natural';t.after(()=>{globalThis.SpeechSynthesisUtterance=oldUtterance;});
  f.show('Первая');await f.s.sayNative('Первая');assert.equal(f.s.pendingSpeech,true);assert.equal(f.s.playing,false);
  utterances[0].onstart();assert.equal(f.s.caption.textContent,'Первая');assert.equal(f.s.playing,true);
  f.show('Вторая');await f.s.sayNative('Вторая');utterances[1].onstart();
  const cancels=f.state.cancels;utterances[0].onstart();utterances[0].onend();
  assert.equal(f.state.cancels,cancels,'stale native start must not globally cancel a new utterance');
  assert.equal(f.s.caption.textContent,'Вторая');assert.equal(f.s.playing,true);
  utterances[1].onend();assert.equal(f.s.playing,false);
});
