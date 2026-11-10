import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:https';
import {randomUUID} from 'node:crypto';
import {WebSocket} from 'ws';
import * as Y from 'yjs';
import {createLegalDocument} from '../src/legal-structure.mjs';
import {createPublicSharedDraft} from '../editor/shared-legal-draft.mjs';
import {attachPublicCollaborationHub} from '../server/public-collaboration-hub.mjs';
import {canonicalize} from '../src/integrity-values.mjs';

const sessionA='A'.repeat(43),sessionB='B'.repeat(43),sessionC='D'.repeat(43);
const csrf='C'.repeat(43);
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,ms=5000) {
 const stop=Date.now()+ms;
 while(Date.now()<stop){const v=fn();if(v)return v;await sleep(15);}
 throw Error('Timed out waiting for collaboration state');
}
function firstText(ydoc) {
 function scan(node){
  if(node instanceof Y.XmlText)return node;
  for(const child of node.toArray?.()??[]) {const text=scan(child);if(text)return text;}
  return null;
 }
 return scan(ydoc.getXmlFragment('prosemirror'));
}
async function fixture({jsonbOrder=false,emptySource=false,admissionYield=false,pauseAdmission=false,maxAdmissions=32,maxRooms=2,multipleDocuments=false}={}) {
 const temp=mkdtempSync(join(tmpdir(),'dge-wss-test-'));
 try {
  const result=spawnSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes',
    '-keyout',join(temp,'key.pem'),'-out',join(temp,'cert.pem'),
    '-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost,IP:127.0.0.1',
    '-days','1'],{stdio:'ignore'});
  if(result.status!==0)throw Error('TLS test setup failed');
  const server=createServer({key:readFileSync(join(temp,'key.pem')),
   cert:readFileSync(join(temp,'cert.pem')),minVersion:'TLSv1.3'},
   (req,res)=>{res.statusCode=404;res.end();});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin='https://127.0.0.1:'+server.address().port;
  const tenantId=randomUUID(),documentId=randomUUID(),secondDocumentId=randomUUID();
  const knownDocument=doc=>doc===documentId||multipleDocuments&&doc===secondDocumentId;
  let document=structuredClone(createLegalDocument({id:documentId,tenantId,title:'Public project'}));
  document.content[0].inlines=[{kind:'text',text:emptySource?'':'Seed'}];
  let version=1,saveCount=0,visibility='public',persistedCrdt=null;
  let admissionReads=0;
  let releaseAdmission;const admissionGate=new Promise(resolve=>{releaseAdmission=resolve;});
  const roles=new Map([[sessionA,'editor'],[sessionB,'viewer'],[sessionC,'editor']]);
  const check=(credentials,write=false)=>{
   if(credentials.origin!==origin||credentials.csrfToken!==csrf||!roles.has(credentials.sessionToken))throw Error('ACCESS_DENIED');
   if(write&&!['editor','admin','owner'].includes(roles.get(credentials.sessionToken)))throw Error('ACCESS_DENIED');
   return roles.get(credentials.sessionToken);
  };
  const documents={
   async read(credentials,tenant,doc) {
    const role=check(credentials);
    if(tenant!==tenantId||!knownDocument(doc))throw Error('WRONG_DOCUMENT');
    return {document:jsonbOrder?JSON.parse(canonicalize({...document,id:doc})):structuredClone({...document,id:doc}),viewerRole:role,version,visibility};
   },
   async collaborationState(credentials,tenant,doc) {
    admissionReads++;
    if(admissionYield||pauseAdmission)await admissionGate;
    check(credentials);
    if(tenant!==tenantId||!knownDocument(doc))throw Error('WRONG_DOCUMENT');
    return persistedCrdt;
   },
   async save(credentials,tenant,doc,command) {
    check(credentials,true);
    if(tenant!==tenantId||doc!==documentId||version!==command.expectedVersion)throw Error('VERSION_CONFLICT');
    if(command.document.revision!==document.revision+1)throw Error('REVISION_NOT_INCREASED');
    if(command.document.mode!=='collaboration'||command.document.lifecycle!=='draft')throw Error('SOURCE_FROZEN');
    if(typeof command.crdtState!=='string'||!command.crdtState.length)throw Error('CRDT_STATE_REQUIRED');
    document=structuredClone(command.document);version++;saveCount++;
    persistedCrdt={version,state:command.crdtState};
    return {document:structuredClone(document),version,visibility};
   }
  };
  const hub=attachPublicCollaborationHub({server,origin,documents,maxRooms,maxAdmissions});
  let upgrades=0;
  server.on('upgrade',()=>{upgrades++;if(admissionYield&&upgrades===2)setImmediate(releaseAdmission);});
  const sockets=[];
  async function connect(token,{originHeader=origin,targetDocument=documentId}={}) {
   const ws=new WebSocket('wss://127.0.0.1:'+server.address().port+'/ws/public/'+tenantId+'/'+targetDocument,
    ['dge-public-v1'],{rejectUnauthorized:false,headers:{
     Origin:originHeader,Cookie:'__Host-dge_session='+token+'; __Host-dge_csrf='+csrf
    }});
   sockets.push(ws);
   const frames=[];
   ws.on('message',(message,isBinary)=>{if(isBinary)frames.push(new Uint8Array(message));});
   ws.on('error',()=>{});
   await until(()=>ws.readyState===WebSocket.OPEN||ws.readyState===WebSocket.CLOSED);
   return {ws,frames};
  }
  return {
   connect,tenantId,documentId,secondDocumentId,roles,hub,
   releaseAdmission,admissionReads:()=>admissionReads,upgrades:()=>upgrades,
   freeze:()=>{visibility='private';},
   getSaveCount:()=>saveCount,
   getDocument:()=>document,
   setPersistedState:state=>{persistedCrdt={version,state};},
   close:async()=>{
    hub.close();for(const ws of sockets)ws.terminate();
    await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});
   }
  };
 }finally{rmSync(temp,{recursive:true,force:true});}
}

test('public TLS WebSocket room commits one authorized Yjs edit and broadcasts to a read-only viewer',{timeout:15000},async()=>{
 const fx=await fixture();
 try {
  const author=await fx.connect(sessionA),viewer=await fx.connect(sessionB);
  const a=await until(()=>author.frames.find(frame=>frame[0]===1));
  const b=await until(()=>viewer.frames.find(frame=>frame[0]===1));
  assert.equal(fx.hub.stats().connections,2);
  const writer=createPublicSharedDraft({document:fx.getDocument(),classification:'public',initialState:a.slice(1),
   onLocalUpdate:update=>author.ws.send(Buffer.concat([Buffer.from([2]),Buffer.from(update)]))});
  writer.mutateLocal(y=>firstText(y).insert(0,'Added '));
  await until(()=>fx.getSaveCount()===1);
  const relayed=await until(()=>viewer.frames.find(frame=>frame[0]===2));
  const replica=createPublicSharedDraft({document:fx.getDocument(),classification:'public',initialState:b.slice(1)});
  replica.receive(relayed.slice(1));
  assert.match(replica.snapshot().content[0].inlines[0].text,/Added/);
  assert.equal(fx.getDocument().revision,1);
  const ack=await until(()=>author.frames.find(frame=>frame[0]===4));
  assert.equal(new DataView(ack.buffer,ack.byteOffset+1,4).getUint32(0),2);
  writer.close();replica.close();
  author.ws.close();viewer.ws.close();
  await until(()=>fx.hub.stats().rooms===0);
  const reopened=await fx.connect(sessionB);
  const initial=await until(()=>reopened.frames.find(frame=>frame[0]===1));
  const restored=createPublicSharedDraft({document:fx.getDocument(),classification:'public',initialState:initial.slice(1)});
  assert.match(restored.snapshot().content[0].inlines[0].text,/Added Seed/);
  assert.doesNotMatch(restored.snapshot().content[0].inlines[0].text,/Seed.*Seed/);
  restored.close();
 }finally{await fx.close();}
});
test('writer demotion and unrelated origin block collaboration messages and upgrades',{timeout:15000},async()=>{
 const fx=await fixture();
 try {
  const author=await fx.connect(sessionA);
  await until(()=>author.frames.find(frame=>frame[0]===1));
  fx.roles.set(sessionA,'viewer');
  author.ws.send(Buffer.from([2,1,1]),{binary:true});
  await until(()=>author.ws.readyState===WebSocket.CLOSING||author.ws.readyState===WebSocket.CLOSED);
  assert.equal(fx.getSaveCount(),0);
  const foreign=await fx.connect(sessionC,{originHeader:'https://attacker.example'});
  assert.notEqual(foreign.ws.readyState,WebSocket.OPEN);
  assert.equal(fx.getSaveCount(),0);
 }finally{await fx.close();}
});
test('private source is not admitted to public collaboration and no fallback relay exists',{timeout:15000},async()=>{
 const fx=await fixture();
 try {
  fx.freeze();
  const client=await fx.connect(sessionA);
  assert.notEqual(client.ws.readyState,WebSocket.OPEN);
  assert.equal(fx.hub.stats().rooms,0);
 }finally{await fx.close();}
});

test('JSONB-style object key ordering cannot reject semantically identical collaboration content',{timeout:15000},async()=>{
 const fx=await fixture({jsonbOrder:true});
 try{const author=await fx.connect(sessionA);await until(()=>author.frames.some(frame=>frame[0]===1));assert.equal(fx.hub.stats().connections,1);}
 finally{await fx.close();}
});

test('an empty source projects for read-only viewing without rewriting stored source',{timeout:15000},async()=>{
 const fx=await fixture({jsonbOrder:true,emptySource:true});
 try{const original=structuredClone(fx.getDocument()),viewer=await fx.connect(sessionB);await until(()=>viewer.frames.some(frame=>frame[0]===1));assert.deepEqual(fx.getDocument(),original);assert.equal(fx.getSaveCount(),0);}
 finally{await fx.close();}
});
test('a persisted CRDT with different text is still refused after projection normalization',{timeout:15000},async()=>{
 const fx=await fixture({jsonbOrder:true});let forged;
 try{const changed=structuredClone(fx.getDocument());changed.content[0].inlines=[{kind:'text',text:'Unapproved source substitution'}];forged=createPublicSharedDraft({document:changed,classification:'public'});fx.setPersistedState(Buffer.from(forged.encodeState()).toString('base64url'));const client=await fx.connect(sessionA);assert.equal(client.ws.readyState,WebSocket.CLOSED);assert.equal(fx.hub.stats().connections,0);assert.equal(fx.getSaveCount(),0);}
 finally{forged?.close();await fx.close();}
});

// Yield the initial history read so both first sockets reach the cold-room path.
test('simultaneous first room joins share one initial CRDT history and tracked room',{timeout:15000},async()=>{
 const fx=await fixture({admissionYield:true});
 try{
  const [one,two]=await Promise.all([fx.connect(sessionA),fx.connect(sessionC)]);
  const first=await until(()=>one.frames.find(frame=>frame[0]===1));
  const second=await until(()=>two.frames.find(frame=>frame[0]===1));
  assert.deepEqual(second,first,'Every first joiner must receive the same Yjs history');
  assert.deepEqual(fx.hub.stats(),{rooms:1,connections:2});
 }finally{await fx.close();}
});

test('queued joins reauthenticate after an earlier failed initialization releases the turn',{timeout:15000},async()=>{
 const fx=await fixture({pauseAdmission:true});
 try{
  const first=fx.connect(sessionA);await until(()=>fx.admissionReads()===1);
  const second=fx.connect(sessionC);await until(()=>fx.upgrades()===2);
  fx.roles.delete(sessionA);fx.releaseAdmission();
  const rejected=await first,admitted=await second;
  assert.equal(rejected.ws.readyState,WebSocket.CLOSED);
  await until(()=>admitted.frames.some(frame=>frame[0]===1));
  assert.deepEqual(fx.hub.stats(),{rooms:1,connections:1});
 }finally{fx.releaseAdmission();await fx.close();}
});
test('revocation while queued refuses admission when the queued turn starts',{timeout:15000},async()=>{
 const fx=await fixture({pauseAdmission:true});
 try{
  const first=fx.connect(sessionA);await until(()=>fx.admissionReads()===1);
  const second=fx.connect(sessionC);await until(()=>fx.upgrades()===2);
  fx.roles.delete(sessionC);fx.releaseAdmission();
  const admitted=await first,rejected=await second;
  await until(()=>admitted.frames.some(frame=>frame[0]===1));
  assert.equal(rejected.ws.readyState,WebSocket.CLOSED);assert.equal(rejected.frames.length,0);
  assert.deepEqual(fx.hub.stats(),{rooms:1,connections:1});
 }finally{fx.releaseAdmission();await fx.close();}
});
test('pending admission budget refuses excess sockets and releases capacity after completion',{timeout:15000},async()=>{
 const fx=await fixture({pauseAdmission:true,maxAdmissions:1});
 try{
  const first=fx.connect(sessionA);await until(()=>fx.admissionReads()===1);
  const excess=await fx.connect(sessionC);assert.equal(excess.ws.readyState,WebSocket.CLOSED);assert.equal(excess.frames.length,0);
  fx.releaseAdmission();const admitted=await first;await until(()=>admitted.frames.some(frame=>frame[0]===1));
  const retry=await fx.connect(sessionC);await until(()=>retry.frames.some(frame=>frame[0]===1));
  assert.deepEqual(fx.hub.stats(),{rooms:1,connections:2});
 }finally{fx.releaseAdmission();await fx.close();}
});
test('shutdown refuses an in-flight first join and cannot resurrect a room',{timeout:15000},async()=>{
 const fx=await fixture({pauseAdmission:true});
 try{
  const first=fx.connect(sessionA);await until(()=>fx.admissionReads()===1);fx.hub.close();
  const rejected=await first;assert.equal(rejected.ws.readyState,WebSocket.CLOSED);
  fx.releaseAdmission();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(rejected.frames.length,0);assert.deepEqual(fx.hub.stats(),{rooms:0,connections:0});
 }finally{fx.releaseAdmission();await fx.close();}
});

test('simultaneous different-document initialization cannot exceed the configured room budget',{timeout:15000},async()=>{
 const fx=await fixture({admissionYield:true,multipleDocuments:true,maxRooms:1});
 try{
  const sockets=await Promise.all([fx.connect(sessionA),fx.connect(sessionC,{targetDocument:fx.secondDocumentId})]);
  await until(()=>sockets.some(client=>client.frames.some(frame=>frame[0]===1)));
  assert.equal(sockets.filter(client=>client.ws.readyState===WebSocket.OPEN).length,1);
  assert.equal(sockets.filter(client=>client.ws.readyState===WebSocket.CLOSED).length,1);
  assert.deepEqual(fx.hub.stats(),{rooms:1,connections:1});
 }finally{fx.releaseAdmission();await fx.close();}
});
