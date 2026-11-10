import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import * as Y from 'yjs';
import {createLegalDocument} from '../src/legal-structure.mjs';
import {createPublicSharedDraft} from '../editor/shared-legal-draft.mjs';
import {mountPublicRealtimeEditor} from '../editor/realtime-editor.mjs';

const tenant='123e4567-e89b-42d3-a456-426614174000';
const docId='223e4567-e89b-42d3-a456-426614174000';
const base=()=>{const d=structuredClone(createLegalDocument({id:docId,tenantId:tenant,title:'Public collaboration'}));d.content[0].inlines=[{kind:'text',text:'Seed'}];return d;};
const frame=(kind,update)=>{const bytes=new Uint8Array(update.length+1);bytes[0]=kind;bytes.set(update,1);return bytes;};
class FakeSocket {
 static sessions=[];
 constructor(url,protocol) {
  this.url=url;this.protocol=protocol;this.readyState=0;this.listeners=new Map();this.sent=[];
  FakeSocket.sessions.push(this);
  queueMicrotask(()=>{
   if(this.readyState!==0)return;
   this.readyState=1;
   this.fire('message',{data:frame(1,FakeSocket.snapshot)});
  });
 }
 addEventListener(name,fn){if(!this.listeners.has(name))this.listeners.set(name,new Set());this.listeners.get(name).add(fn);}
 removeEventListener(name,fn){this.listeners.get(name)?.delete(fn);}
 fire(name,event){for(const fn of this.listeners.get(name)??[])fn(event);}
 send(data){this.sent.push(new Uint8Array(data));}
 close(){this.readyState=3;this.fire('close',{});}
}
function setupDom() {
 const dom=new JSDOM('<div id="editor"></div>',{url:'https://example.test/'});
 const names=['window','document','Node','HTMLElement','MutationObserver','navigator','getComputedStyle'];
 const previous=new Map(names.map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]));
 for(const name of names)Object.defineProperty(globalThis,name,{value:name==='getComputedStyle'?
  dom.window.getComputedStyle.bind(dom.window):dom.window[name],configurable:true,writable:true});
 return {host:dom.window.document.getElementById('editor'),close(){
  for(const [name,descriptor] of previous) {
   if(descriptor)Object.defineProperty(globalThis,name,descriptor);else delete globalThis[name];
  }
  dom.window.close();
 }};
}
test('live editor mounts shared ProseMirror document and sends bounded Yjs deltas over WSS',{timeout:10000},async()=>{
 const dom=setupDom();
 const seed=createPublicSharedDraft({document:base(),classification:'public'});
 FakeSocket.snapshot=seed.encodeState();
 let editor;
 try {
  const updates=[],states=[];
  editor=await mountPublicRealtimeEditor(dom.host,base(),{classification:'public',origin:'https://example.test',
   WebSocketCtor:FakeSocket,onChange:doc=>updates.push(doc),onStatus:s=>states.push(s)});
  assert.match(editor.view.dom.textContent,/Seed/);
  assert.equal(FakeSocket.sessions.at(-1).url,'wss://example.test/ws/public/'+tenant+'/'+docId);
  editor.view.dispatch(editor.view.state.tr.insertText('Local ',1));
  await new Promise(resolve=>setTimeout(resolve,0));
  const sent=FakeSocket.sessions.at(-1).sent.filter(message=>message[0]===2);
  assert.ok(sent.length,'an accepted local ProseMirror update is transmitted');
  assert.match(editor.getDocument().content[0].inlines[0].text,/Local/);
  assert.ok(updates.length>0);
  assert.match(states.at(-1),/Saving live edits/);
  seed.receive(sent[0].slice(1));
  const ack=new Uint8Array(4);new DataView(ack.buffer).setUint32(0,2);FakeSocket.sessions.at(-1).fire('message',{data:frame(4,ack)});
  assert.match(states.at(-1),/acknowledged/);
 }finally{editor?.destroy();seed.close();dom.close();}
});
test('readonly, private and lost-connection editing fail closed',{timeout:10000},async()=>{
 const dom=setupDom(),seed=createPublicSharedDraft({document:base(),classification:'public'});
 FakeSocket.snapshot=seed.encodeState();
 let editor;
 try {
  await assert.rejects(mountPublicRealtimeEditor(dom.host,base(),{classification:'private',
   origin:'https://example.test',WebSocketCtor:FakeSocket}),/public collaboration/);
  editor=await mountPublicRealtimeEditor(dom.host,base(),{classification:'public',
   origin:'https://example.test',WebSocketCtor:FakeSocket,readOnly:true});
  assert.equal(editor.command(()=>true),false);
  const socket=FakeSocket.sessions.at(-1);
  assert.equal(socket.sent.length,0);
  socket.close();
  assert.equal(editor.command(()=>true),false);
 }finally{editor?.destroy();seed.close();dom.close();}
});
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
function acknowledge(socket,version){const value=new Uint8Array(4);new DataView(value.buffer).setUint32(0,version);socket.fire('message',{data:frame(4,value)});}
function textOf(shared){return shared.snapshot().content[0].inlines.map(run=>run.text??'').join('');}
test('multiple local edits wait behind one acknowledgment and become one next delta',{timeout:10000},async()=>{
 const dom=setupDom(),seed=createPublicSharedDraft({document:base(),classification:'public'});FakeSocket.snapshot=seed.encodeState();let editor;
 try{
  const states=[],versions=[];editor=await mountPublicRealtimeEditor(dom.host,base(),{classification:'public',origin:'https://example.test',WebSocketCtor:FakeSocket,onStatus:value=>states.push(value),onAcknowledged:value=>versions.push(value)});const socket=FakeSocket.sessions.at(-1);
  editor.view.dispatch(editor.view.state.tr.insertText('A',1));await tick();assert.equal(socket.sent.length,1);
  editor.view.dispatch(editor.view.state.tr.insertText('B',2));await tick();editor.view.dispatch(editor.view.state.tr.insertText('C',3));await tick();assert.equal(socket.sent.length,1);assert.doesNotMatch(states.at(-1),/acknowledged/);
  seed.receive(socket.sent[0].slice(1));acknowledge(socket,2);await tick();assert.equal(socket.sent.length,2);assert.match(states.at(-1),/Saving remaining/);
  seed.receive(socket.sent[1].slice(1));acknowledge(socket,3);await tick();assert.equal(socket.sent.length,2);assert.equal(textOf(seed),'ABCSeed');assert.match(states.at(-1),/saved as public version 3/);assert.deepEqual(versions,[2,3]);
 }finally{editor?.destroy();seed.close();dom.close();}
});
test('delete-only changes are confirmed without resending historical delete sets forever',{timeout:10000},async()=>{
 const dom=setupDom(),seed=createPublicSharedDraft({document:base(),classification:'public'});FakeSocket.snapshot=seed.encodeState();let editor;
 try{
  const states=[];editor=await mountPublicRealtimeEditor(dom.host,base(),{classification:'public',origin:'https://example.test',WebSocketCtor:FakeSocket,onStatus:value=>states.push(value)});const socket=FakeSocket.sessions.at(-1);
  editor.view.dispatch(editor.view.state.tr.delete(1,2));await tick();assert.equal(socket.sent.length,1);seed.receive(socket.sent[0].slice(1));acknowledge(socket,2);await tick();
  assert.equal(textOf(seed),'eed');assert.equal(socket.sent.length,1,'An already confirmed deletion must not produce another update.');assert.match(states.at(-1),/saved as public version 2/);
 }finally{editor?.destroy();seed.close();dom.close();}
});
test('unconfirmed save times out once, preserves text and refuses a late acknowledgment',{timeout:10000},async()=>{
 const dom=setupDom(),seed=createPublicSharedDraft({document:base(),classification:'public'});FakeSocket.snapshot=seed.encodeState();let editor;
 try{
  const states=[],connections=[],versions=[];editor=await mountPublicRealtimeEditor(dom.host,base(),{classification:'public',origin:'https://example.test',WebSocketCtor:FakeSocket,acknowledgementTimeoutMs:100,onStatus:value=>states.push(value),onConnectionChange:value=>connections.push(value),onAcknowledged:value=>versions.push(value)});const socket=FakeSocket.sessions.at(-1);
  editor.view.dispatch(editor.view.state.tr.insertText('Preserved ',1));await new Promise(resolve=>setTimeout(resolve,150));
  assert.equal(editor.command(()=>true),false);assert.equal(editor.view.dom.getAttribute('contenteditable'),'false');assert.match(states.at(-1),/timed out/);assert.match(editor.getDocument().content[0].inlines[0].text,/Preserved/);assert.deepEqual(connections,[true,false]);
  acknowledge(socket,2);assert.deepEqual(versions,[]);assert.match(states.at(-1),/timed out/);
 }finally{editor?.destroy();seed.close();dom.close();}
});
test('unsolicited or regressing acknowledgments never claim a persisted save',{timeout:10000},async()=>{
 const dom=setupDom(),seed=createPublicSharedDraft({document:base(),classification:'public'});FakeSocket.snapshot=seed.encodeState();let editor;
 try{
  const versions=[];editor=await mountPublicRealtimeEditor(dom.host,base(),{classification:'public',origin:'https://example.test',WebSocketCtor:FakeSocket,onAcknowledged:value=>versions.push(value)});const socket=FakeSocket.sessions.at(-1);acknowledge(socket,2);assert.deepEqual(versions,[]);assert.equal(editor.command(()=>true),false);
  editor.destroy();editor=await mountPublicRealtimeEditor(dom.host,base(),{classification:'public',origin:'https://example.test',WebSocketCtor:FakeSocket,onAcknowledged:value=>versions.push(value)});const active=FakeSocket.sessions.at(-1);
  editor.view.dispatch(editor.view.state.tr.insertText('A',1));await tick();seed.receive(active.sent[0].slice(1));acknowledge(active,2);
  editor.view.dispatch(editor.view.state.tr.insertText('B',2));await tick();acknowledge(active,1);assert.deepEqual(versions,[2]);assert.equal(editor.command(()=>true),false);
 }finally{editor?.destroy();seed.close();dom.close();}
});

function firstText(y){function scan(node){if(node instanceof Y.XmlText)return node;for(const child of node.toArray?.()??[]){const result=scan(child);if(result)return result;}return null;}return scan(y.getXmlFragment('prosemirror'));}
test('remote updates interleaved with an in-flight edit cannot hide queued local text',{timeout:10000},async()=>{
 const dom=setupDom(),seed=createPublicSharedDraft({document:base(),classification:'public'});FakeSocket.snapshot=seed.encodeState();let remote;const peer=createPublicSharedDraft({document:base(),classification:'public',initialState:seed.encodeState(),onLocalUpdate:update=>{remote=update;}});let editor;
 try{
  editor=await mountPublicRealtimeEditor(dom.host,base(),{classification:'public',origin:'https://example.test',WebSocketCtor:FakeSocket});const socket=FakeSocket.sessions.at(-1);
  editor.view.dispatch(editor.view.state.tr.insertText('Local ',1));await tick();assert.equal(socket.sent.length,1);
  peer.mutateLocal(y=>firstText(y).insert(0,'Peer '));seed.receive(remote);socket.fire('message',{data:frame(2,remote)});
  editor.view.dispatch(editor.view.state.tr.insertText('Queued ',1));await tick();assert.equal(socket.sent.length,1);
  seed.receive(socket.sent[0].slice(1));acknowledge(socket,3);await tick();assert.equal(socket.sent.length,2);seed.receive(socket.sent[1].slice(1));acknowledge(socket,4);await tick();
  assert.equal(socket.sent.length,2);assert.deepEqual(editor.getDocument().content,seed.snapshot().content);assert.match(textOf(seed),/Queued/);assert.match(textOf(seed),/Local/);assert.match(textOf(seed),/Peer/);
 }finally{editor?.destroy();peer.close();seed.close();dom.close();}
});
test('first edit includes clock entries created by editor normalization of a historical snapshot',{timeout:10000},async()=>{
 const dom=setupDom(),d=base();d.content=[{kind:'section',id:'historical-section',title:'Historical',children:d.content}];const seed=createPublicSharedDraft({document:d,classification:'public'});seed.mutateLocal(y=>y.getXmlFragment('prosemirror').get(0).setAttribute('numberLabel','OLD'));FakeSocket.snapshot=seed.encodeState();let editor;
 try{
  editor=await mountPublicRealtimeEditor(dom.host,d,{classification:'public',origin:'https://example.test',WebSocketCtor:FakeSocket});const socket=FakeSocket.sessions.at(-1);editor.view.dispatch(editor.view.state.tr.insertText('Retained ',2));await tick();assert.equal(socket.sent.length,1);seed.receive(socket.sent[0].slice(1));acknowledge(socket,2);await tick();
  assert.deepEqual(editor.getDocument().content,seed.snapshot().content);assert.match(seed.snapshot().content[0].children[0].inlines[0].text,/Retained/);assert.equal(socket.sent.length,1);
 }finally{editor?.destroy();seed.close();dom.close();}
});
