import {randomUUID} from 'node:crypto';
import {WebSocketServer,WebSocket} from 'ws';
import {requestCookies} from './account-http.mjs';
import {createPublicSharedDraft} from '../editor/shared-legal-draft.mjs';
import {canonicalize} from '../src/integrity-values.mjs';
import {legalToEditor,editorToLegal} from '../editor/model.mjs';

const UUID='[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}';
const PATH=new RegExp('^/ws/public/('+UUID+')/('+UUID+')$');
const CSRF=/^[A-Za-z0-9_-]{43}$/;
const FRAME_SNAPSHOT=1,FRAME_UPDATE=2,FRAME_STATE_VECTOR=3,FRAME_ACK=4;
const writable=new Set(['owner','admin','editor']);

function credentialCookies(header,origin) {
 const cookies=requestCookies(header);
 const matches=header.split(';').map(x=>x.trim()).filter(x=>x.startsWith('__Host-dge_csrf='));
 if(matches.length!==1)throw Error('Invalid collaboration CSRF cookie');
 const csrf=matches[0].slice('__Host-dge_csrf='.length);
 if(!CSRF.test(csrf)||!cookies.get('__Host-dge_session'))
  throw Error('Invalid collaboration session');
 return {sessionToken:cookies.get('__Host-dge_session'),csrfToken:csrf,origin};
}
function binary(type,payload) {
 return Buffer.concat([Buffer.from([type]),Buffer.from(payload)]);
}
function refuse(socket,status=403) {
 if(socket.destroyed)return;
 socket.end('HTTP/1.1 '+status+' Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
 socket.destroy();
}
function drop(connection,code=1008) {
 if(connection.readyState===WebSocket.OPEN)connection.close(code,'Collaboration access changed');
 else connection.terminate();
}

/**
 * Authenticated TLS WebSocket relay for explicitly PUBLIC drafts only.
 * Private documents must use a separate reviewed E2EE protocol and server.
 * Every accepted edit goes through the existing permissioned immutable-version document store.
 */
export function attachPublicCollaborationHub({server,origin,documents,maxRooms=32,maxClientsPerRoom=12,maxPending=12,maxAdmissions=32}={}) {
 if(!server?.on||!server?.off||typeof documents?.read!=='function'||typeof documents?.save!=='function'||
    typeof documents?.collaborationState!=='function'||
    new URL(origin).protocol!=='https:'||new URL(origin).origin!==origin||
    ![maxRooms,maxClientsPerRoom,maxPending,maxAdmissions].every(n=>Number.isSafeInteger(n)&&n>=1&&n<=100))
  throw Error('Invalid public collaboration hub configuration');
 const expectedHost=new URL(origin).host;
 const rooms=new Map(),joining=new Map(),admissions=new Set();
 const wss=new WebSocketServer({noServer:true,maxPayload:65536,perMessageDeflate:false,
  handleProtocols:protocols=>protocols.has('dge-public-v1')?'dge-public-v1':false});
 let stopped=false;
 function endRoom(room) {
  if(room.closed)return;
  room.closed=true;
  for(const client of room.clients)drop(client.ws,1012);
  room.clients.clear();
  room.shared.close();
  if(rooms.get(room.key)===room)rooms.delete(room.key);
 }
 async function access(client,room) {
  const snapshot=await documents.read(client.credentials,room.tenantId,room.documentId);
  if(snapshot.visibility!=='public'||snapshot.document.mode!=='collaboration'||
     snapshot.document.lifecycle!=='draft'||snapshot.version!==room.version)
   throw Error('Public collaboration source changed');
  return snapshot;
 }
 async function handleMessage(room,client,data,isBinary) {
  if(!isBinary||data.length<2||data.length>65536||room.closed||stopped)
   throw Error('Invalid collaboration frame');
  const kind=data[0],payload=new Uint8Array(data.subarray(1));
  // Reauthenticate every operation, including state-vector queries.
  const current=await access(client,room);
  if(kind===FRAME_STATE_VECTOR) {
   if(payload.length>8192)throw Error('Oversized collaboration vector');
   const encoded=room.shared.encodeState(payload);
   if(encoded.length>3000000)throw Error('Oversized document snapshot');
   client.ws.send(binary(FRAME_SNAPSHOT,encoded),{binary:true});
   return;
  }
  if(kind!==FRAME_UPDATE||!writable.has(current.viewerRole))
   throw Error('Writing to public collaboration requires editor role');
  const sample=createPublicSharedDraft({classification:'public',document:room.document,
   initialState:room.shared.encodeState()});
  let candidate,candidateState;
  try{candidate=sample.receive(payload);candidateState=sample.encodeState();}
  finally{sample.close();}
  const advanced=!Buffer.from(candidateState).equals(Buffer.from(room.shared.encodeState()));
  if(advanced) {
   const document={...structuredClone(candidate),revision:room.document.revision+1};
   const result=await documents.save(client.credentials,room.tenantId,room.documentId,{
    document,expectedVersion:room.version,commandId:randomUUID(),
    crdtState:Buffer.from(candidateState).toString('base64url')
   });
   if(result.visibility!=='public'||result.version!==room.version+1)
    throw Error('Collaboration save was not committed');
   room.version=result.version;
   room.document=result.document;
  }
  room.shared.receive(payload);
  // Version confirmation is sent only after the durable transaction committed.
  const acknowledgement=Buffer.allocUnsafe(4);
  acknowledgement.writeUInt32BE(room.version,0);
  if(client.ws.readyState===WebSocket.OPEN)
   client.ws.send(binary(FRAME_ACK,acknowledgement),{binary:true});
  // Every receiver is reauthorized before accepting an update; removed members
  // never receive subsequent plaintext public content via a stale socket.
  for(const receiver of [...room.clients]) {
   if(receiver.ws.readyState!==WebSocket.OPEN){room.clients.delete(receiver);continue;}
   try {
    await documents.read(receiver.credentials,room.tenantId,room.documentId);
    if(receiver.ws!==client.ws)receiver.ws.send(binary(FRAME_UPDATE,payload),{binary:true});
   }catch{room.clients.delete(receiver);drop(receiver.ws);}
  }
 }
 async function onUpgrade(req,socket,head) {
  let releaseAdmission,ticket,admissionKey;
  try {
   if(stopped||!req.socket.encrypted||req.socket.getProtocol?.()!=='TLSv1.3'||
      req.headers.host!==expectedHost||req.headers.origin!==origin||
      typeof req.url!=='string'||req.url.length>220||req.url.includes('?')||
      req.headers['sec-websocket-protocol']!=='dge-public-v1')
    return refuse(socket);
   const match=req.url.match(PATH);
   if(!match)return refuse(socket,404);
   const [,tenantId,documentId]=match,key=tenantId+'/'+documentId;
   const credentials=credentialCookies(req.headers.cookie??'',origin);
   if(admissions.size>=maxAdmissions)return refuse(socket,503);
   admissions.add(socket);admissionKey=key;
   const prior=joining.get(key)??Promise.resolve();
   ticket=new Promise(resolve=>{releaseAdmission=resolve;});
   joining.set(key,ticket);
   // Same-document first joins must not independently seed separate Yjs histories.
   // Authorization and version reads occur in the serialized admission turn.
   await prior;
   if(stopped||socket.destroyed)return refuse(socket,503);
   const snapshot=await documents.read(credentials,tenantId,documentId);
   if(stopped||socket.destroyed)return refuse(socket,503);
   if(snapshot.visibility!=='public'||snapshot.document.mode!=='collaboration'||
      snapshot.document.lifecycle!=='draft')return refuse(socket);
   let room=rooms.get(key);
   if(room&&room.version!==snapshot.version)endRoom(room);
   room=rooms.get(key);
   if(!room) {
    if(rooms.size>=maxRooms)return refuse(socket,503);
    const persisted=await documents.collaborationState(credentials,tenantId,documentId);
    if(stopped||socket.destroyed)return refuse(socket,503);
    // Other document keys initialize independently; recheck after the awaited read.
    if(rooms.size>=maxRooms)return refuse(socket,503);
    if(persisted && (persisted.version!==snapshot.version||typeof persisted.state!=='string'))
     return refuse(socket);
    const shared=createPublicSharedDraft({
     document:snapshot.document,classification:'public',
     ...(persisted?{initialState:new Uint8Array(Buffer.from(persisted.state,'base64url'))}:{})
    });
    // Compare the exact editor representation: JSONB key order and redundant
    // empty/adjacent text runs are not faithfully represented by ProseMirror.
    // Actual text, identities, references, structure and formatting must agree.
    const projected=editorToLegal(legalToEditor(snapshot.document),snapshot.document);
    if(canonicalize(shared.snapshot().content)!==canonicalize(projected.content)) {
     shared.close();return refuse(socket);
    }
    room={key,tenantId,documentId,shared,document:snapshot.document,version:snapshot.version,
      clients:new Set(),pending:0,chain:Promise.resolve(),closed:false};
    rooms.set(key,room);
   }
   if(room.clients.size>=maxClientsPerRoom)return refuse(socket,503);
   if(socket.destroyed)return;
   wss.handleUpgrade(req,socket,head,ws=>{
    if(stopped||room.closed){ws.terminate();return;}
    const client={ws,credentials};
    room.clients.add(client);
    ws.on('message',(message,isBinary)=>{
     if(room.pending>=maxPending||room.closed){drop(ws,1013);return;}
     room.pending++;
     room.chain=room.chain.then(async()=>{
      if(ws.readyState===WebSocket.OPEN)await handleMessage(room,client,message,isBinary);
     }).catch(()=>{room.clients.delete(client);drop(ws);}).finally(()=>{
      room.pending--;
     });
    });
    ws.on('close',()=>{
     room.clients.delete(client);
     if(!room.clients.size)endRoom(room);
    });
    ws.on('error',()=>{});
    try{ws.send(binary(FRAME_SNAPSHOT,room.shared.encodeState()),{binary:true});}
    catch{drop(ws,1011);}
   });
  } catch {refuse(socket);}
  finally {
   admissions.delete(socket);
   releaseAdmission?.();
   if(ticket&&joining.get(admissionKey)===ticket)joining.delete(admissionKey);
  }
 }
 server.on('upgrade',onUpgrade);
 return Object.freeze({
  close() {
   if(stopped)return;
   stopped=true;server.off('upgrade',onUpgrade);
   for(const socket of admissions)refuse(socket,503);
   for(const room of [...rooms.values()])endRoom(room);
   wss.close();
  },
  stats() {return {rooms:rooms.size,connections:[...rooms.values()].reduce((n,r)=>n+r.clients.size,0)};}
 });
}
