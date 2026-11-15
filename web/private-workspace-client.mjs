/**
 * Endpoint-side private workspace client (DCE-003/DCE-008).
 *
 * Plaintext, MLS private state and exported epoch keys exist only here, at the
 * authorized endpoint. The service receives: public device keys and RFC 9420
 * key packages, MLS Commit/Welcome bytes, AES-256-GCM snapshot envelopes and
 * AES-256-GCM Yjs frames. Content keys are the RFC 9420 MLS exporter outputs of
 * the current epoch (labels in EXPORT_LABELS), imported by the Wasm endpoint as
 * NON-extractable WebCrypto keys; snapshots use the existing private-crypto
 * envelope and frames the existing private-collaboration-crypto codec.
 *
 * Device keys of other members are pinned only after explicit local approval
 * (safety-number comparison). Any unknown, added or changed device key stops
 * group processing with a visible KEY_APPROVAL_REQUIRED warning.
 */
import * as Y from 'yjs';
import {prosemirrorToYDoc,yDocToProsemirror} from 'y-prosemirror';
import {createLegalDocument,validateLegalDocument} from '../src/legal-structure.mjs';
import {legalToEditor,editorToLegal,editorSchema} from '../editor/model.mjs';
import {encryptLocalDraftBytes,decryptLocalDraftBytes} from '../src/private-crypto.mjs';
import {sealPrivateYjsUpdate,openPrivateYjsUpdate,PRIVATE_UPDATE_MAX_BYTES} from '../src/private-collaboration-crypto.mjs';
import {initializeMlsState,reopenMlsState} from './mls-state-vault.mjs';
import {browserCSRF} from './account-api.mjs';
import {EXPORT_LABELS,exporterContext,deviceIdentity,deviceKeyThumbprint,deviceSafetyNumber,privateGroupIdAsync,base64url,fromBase64url,parseDeviceIdentity} from '../src/private-workspace-protocol.mjs';

export class PrivateWorkspaceError extends Error{
 constructor(code,status=0,details=null){super(code);this.code=code;this.status=status;this.details=details;}
}
const fail=(code,details=null)=>new PrivateWorkspaceError(code,0,details);
const UUID=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const enc=new TextEncoder(),dec=new TextDecoder('utf-8',{fatal:true});
const SNAPSHOT_FORMAT='dge-private-snapshot-v1';
const equalBytes=(a,b)=>a.length===b.length&&a.every((v,i)=>v===b[i]);

/** Same-origin JSON API with CSRF and an optional endpoint-device selector header. */
export function createPrivateApi({fetcher=(...args)=>fetch(...args),cookie=()=>document.cookie}={}){
 return async(path,{method='GET',body,device}={})=>{
  if(typeof path!=='string'||!path.startsWith('/api/')||path.includes('\\')||path.startsWith('//'))throw Error('Same-origin API path required');
  const headers={accept:'application/json'};
  if(method!=='GET'){headers['content-type']='application/json';headers['x-dge-csrf']=browserCSRF(cookie());}
  if(device!==undefined){if(!UUID.test(device))throw fail('INVALID_DEVICE');headers['x-dge-device']=device;}
  const response=await fetcher(path,{method,headers,credentials:'same-origin',cache:'no-store',...(body!==undefined?{body:JSON.stringify(body)}:{})});
  let result;
  try{result=await response.json();}catch{throw new PrivateWorkspaceError('SERVICE_UNAVAILABLE',response.status);}
  if(!response.ok)throw new PrivateWorkspaceError(result?.error??'SERVICE_UNAVAILABLE',response.status);
  return result;
 };
}

/** Browser-local persistence (IndexedDB) for CryptoKeys (structured clone) and public pins. */
export async function openLocalStore(name='quill-private-workspace-v1'){
 const db=await new Promise((resolve,reject)=>{
  const request=indexedDB.open(name,1);
  request.onupgradeneeded=()=>request.result.createObjectStore('kv');
  request.onsuccess=()=>resolve(request.result);
  request.onerror=request.onblocked=()=>reject(fail('LOCAL_STORAGE_UNAVAILABLE'));
 });
 const run=(mode,fn)=>new Promise((resolve,reject)=>{
  const tx=db.transaction('kv',mode),request=fn(tx.objectStore('kv'));
  tx.oncomplete=()=>resolve(request.result);tx.onabort=tx.onerror=()=>reject(fail('LOCAL_STORAGE_UNAVAILABLE'));
 });
 return Object.freeze({
  get:key=>run('readonly',s=>s.get(key)),
  set:(key,value)=>run('readwrite',s=>s.put(value,key)).then(()=>undefined),
  delete:key=>run('readwrite',s=>s.delete(key)).then(()=>undefined),
  close(){db.close();}
 });
}
export function memoryLocalStore(){
 const map=new Map();
 return Object.freeze({get:async k=>map.get(k),set:async(k,v)=>{map.set(k,v);},delete:async k=>{map.delete(k);},close(){},entries:()=>[...map.entries()]});
}

function decodeEntry(entry){
 const identity=fromBase64url(entry.identity,512),signatureKey=fromBase64url(entry.signatureKey,32);
 if(signatureKey.length!==32)throw fail('INVALID_DEVICE_KEY');
 const parsed=parseDeviceIdentity(identity);
 // The identity must name the account the directory claims owns the device.
 if(!parsed||parsed.accountId!==entry.accountId)throw fail('INVALID_DEVICE_IDENTITY');
 return {deviceId:entry.deviceId,accountId:entry.accountId,identity,signatureKey};
}

/**
 * Local trust-on-explicit-approval pins. Status values:
 *  own       this endpoint's device
 *  approved  pinned with exactly this identity and key
 *  new       no device of this account has been approved before
 *  added     the account has approved devices; this one is additional
 *  changed   a pinned device ID or identity now presents a DIFFERENT key
 */
export function createPinStore(local,scope){
 const slot='pins:'+scope;
 const read=async()=>(await local.get(slot))??{};
 return Object.freeze({
  async review(entries,ownDeviceId){
   const pins=await read(),out=[];
   for(const raw of entries){
    const entry=decodeEntry(raw);
    const safetyNumber=await deviceSafetyNumber(entry.identity,entry.signatureKey);
    let status;
    if(entry.deviceId===ownDeviceId)status='own';
    else{
     const pin=pins[entry.deviceId];
     const sameIdentity=Object.entries(pins).find(([,p])=>p.identity===base64url(entry.identity));
     if(pin&&pin.identity===base64url(entry.identity)&&pin.signatureKey===base64url(entry.signatureKey)&&pin.accountId===entry.accountId)status='approved';
     else if(pin||(sameIdentity&&sameIdentity[0]!==entry.deviceId))status='changed';
     else status=Object.values(pins).some(p=>p.accountId===entry.accountId)?'added':'new';
    }
    out.push({...raw,safetyNumber,status});
   }
   return out;
  },
  async approve(raw){
   const entry=decodeEntry(raw),pins=await read();
   pins[entry.deviceId]={accountId:entry.accountId,identity:base64url(entry.identity),signatureKey:base64url(entry.signatureKey),
    safetyNumber:await deviceSafetyNumber(entry.identity,entry.signatureKey),approvedAt:new Date().toISOString()};
   await local.set(slot,pins);
  },
  async pinned(){return read();}
 });
}

function verifyUpdate(doc,update,base){
 const trial=new Y.Doc();
 try{Y.applyUpdate(trial,Y.encodeStateAsUpdate(doc));Y.applyUpdate(trial,update);editorToLegal(yDocToProsemirror(editorSchema,trial),base);}
 finally{trial.destroy();}
}

export function createPrivateWorkspaceClient({
 api,mls,stateStore,local,tenantId,accountId,origin,
 WebSocketCtor=globalThis.WebSocket,webCrypto=globalThis.crypto,pollMs=2000
}){
 if(!UUID.test(tenantId??'')||!UUID.test(accountId??'')||typeof api!=='function'||!mls?.BrowserEndpoint||!local||!stateStore)
  throw Error('Private workspace client configuration required');
 const scopeKey=tenantId+':'+accountId;
 const pins=createPinStore(local,scopeKey);
 let device=null,state=null;
 const base='/api/workspaces/'+tenantId;
 const subtle=webCrypto.subtle;

 async function wrappingKey(){
  let key=await local.get('wrap:'+scopeKey);
  if(!key){
   key=await subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']);
   await local.set('wrap:'+scopeKey,key);
  }
  return key;
 }
 async function flushKeyPackages(){
  for(const item of await state.outgoing()){
   if(item.kind!=='keyPackage')continue;
   try{await api(base+'/private-devices/'+device.deviceId+'/key-packages',{method:'POST',body:{packages:[base64url(item.frames[0].bytes)]}});}
   catch(error){if(error.code!=='KEY_PACKAGE_REUSED')throw error;}
   await state.acknowledgeSent(item.id);
  }
 }
 async function replenish(target=6){
  await flushKeyPackages();
  const own=(await api(base+'/private-devices')).items.find(d=>d.deviceId===device.deviceId);
  if(!own)throw fail('DEVICE_NOT_PUBLISHED');
  for(let i=own.availableKeyPackages;i<target;i++)await state.keyPackage();
  await flushKeyPackages();
 }
 async function deviceRecord(){return local.get('device:'+scopeKey);}

 const groupCache=new Map();
 async function groupInfo(documentId){
  const info=await api(base+'/private-groups/'+documentId);
  groupCache.set(documentId,info);
  return info;
 }
 async function handleFor(groupId){
  const found=(await state.groups()).find(g=>equalBytes(Uint8Array.from(g.id),groupId));
  return found??null;
 }
 /** Exact MLS roster pins for a list of device IDs; every non-own device must be approved. */
 async function rosterPins(info,deviceIds){
  const members=new Map(info.members.map(m=>[m.deviceId,m]));
  const entries=deviceIds.map(id=>{const m=members.get(id);if(!m)throw fail('UNKNOWN_ROSTER_DEVICE');return m;});
  const reviewed=await pins.review(entries,device.deviceId);
  const unapproved=reviewed.filter(r=>r.status!=='own'&&r.status!=='approved');
  if(unapproved.length)throw fail('KEY_APPROVAL_REQUIRED',unapproved);
  return entries.map(e=>({identity:[...fromBase64url(e.identity,512)],signature_key:[...fromBase64url(e.signatureKey,32)]}));
 }
 const keySlot=(documentId,epoch,purpose)=>'key:'+scopeKey+':'+documentId+':'+epoch+':'+purpose;
 async function cacheEpochKeys(documentId,handle){
  const groups=await state.groups(),group=groups.find(g=>g.handle===handle);
  if(!group?.active)return null;
  const epoch=Number(group.epoch),context=exporterContext(tenantId,documentId);
  for(const purpose of ['snapshot','update'])
   if(!await local.get(keySlot(documentId,epoch,purpose)))
    await local.set(keySlot(documentId,epoch,purpose),await state.exportKey(handle,EXPORT_LABELS[purpose],context));
  return epoch;
 }
 const epochKey=(documentId,epoch,purpose)=>local.get(keySlot(documentId,epoch,purpose));

 /**
  * Bring this endpoint's MLS group for a document up to the service's ordered
  * epoch: finish an interrupted own commit, join from a Welcome, and process
  * commits strictly in order with approved roster pins.
  */
 async function syncGroup(documentId){
  const groupId=await privateGroupIdAsync(tenantId,documentId,subtle);
  let info=await groupInfo(documentId);
  let current=await handleFor(groupId);
  if(current)await resumeOwnCommits(documentId,current.handle,info);
  const cursorSlot='cursor:'+scopeKey+':'+documentId;
  let after=(await local.get(cursorSlot))??0,removed=false;
  for(;;){
   const page=await api(base+'/private-groups/'+documentId+'/messages?deviceId='+device.deviceId+'&after='+after+'&limit=50');
   removed=page.removed;
   for(const item of page.items){
    current=await handleFor(groupId);
    if(item.kind==='welcome'){
     if(!current){
      if(!info.members.some(m=>item.roster.includes(m.deviceId)))info=await groupInfo(documentId);
      const handle=await state.join(fromBase64url(item.payload),groupId,await rosterPins(info,item.roster));
      await cacheEpochKeys(documentId,handle);
     }
    }else if(current&&current.active&&Number(current.epoch)===item.epoch&&item.senderDeviceId!==device.deviceId){
     if(!item.roster.every(id=>info.members.some(m=>m.deviceId===id)))info=await groupInfo(documentId);
     // Pins are the RESULTING roster (also for our own removal): an unexpected
     // or substituted member in the new ratchet tree is rejected by the endpoint.
     const pinsAfter=await rosterPins(info,item.roster);
     await state.receive(current.handle,fromBase64url(item.payload),pinsAfter);
     await cacheEpochKeys(documentId,current.handle);
    }
    after=item.position;await local.set(cursorSlot,after);
   }
   if(page.nextCursor===null)break;
  }
  current=await handleFor(groupId);
  return {info:await groupInfo(documentId),handle:current?.handle??null,epoch:current?Number(current.epoch):null,
   active:!!current?.active,removed:removed||(current&&!current.active)};
 }
 async function resumeOwnCommits(documentId,handle,info){
  for(const item of await state.outgoing()){
   if(item.group!==handle||!['add','remove'].includes(item.kind))continue;
   const meta=await local.get('pending:'+item.id);
   if(!meta)throw fail('PENDING_COMMIT_METADATA_MISSING');
   await postCommit(documentId,handle,item,meta);
  }
 }
 async function postCommit(documentId,handle,item,meta){
  const commit=item.frames.find(f=>f.kind==='commit').bytes,welcome=item.frames.find(f=>f.kind==='welcome')?.bytes??null;
  try{
   await api(base+'/private-groups/'+documentId+'/messages',{method:'POST',body:{deviceId:device.deviceId,epoch:meta.epoch,
    commit:base64url(commit),welcome:welcome?base64url(welcome):null,add:meta.add,remove:meta.remove,commandId:item.id}});
  }catch(error){
   // A competing commit won this epoch; the pending local commit cannot be
   // merged and the endpoint must not advance on it.
   if(error.code==='PRIVATE_EPOCH_CONFLICT')throw fail('MEMBERSHIP_CHANGE_CONFLICT');
   throw error;
  }
  await state.acknowledgeSent(item.id);
  await state.mergePending(handle);
  await local.delete('pending:'+item.id);
  await cacheEpochKeys(documentId,handle);
 }

 async function sealSnapshot(documentId,epoch,payload){
  const key=await epochKey(documentId,epoch,'snapshot');
  if(!key)throw fail('EPOCH_KEY_UNAVAILABLE');
  const sealed=await encryptLocalDraftBytes(key,enc.encode(JSON.stringify(payload)),{tenantId,workspaceId:tenantId,documentId,epoch},webCrypto);
  return {version:1,cipher:'AES-256-GCM',keyEpoch:epoch,nonce:sealed.nonce,ciphertext:sealed.ciphertext};
 }
 async function openSnapshot(documentId,snapshot){
  const key=await epochKey(documentId,snapshot.keyEpoch,'snapshot');
  if(!key)throw fail('EPOCH_KEY_UNAVAILABLE');
  const bytes=await decryptLocalDraftBytes(key,{version:1,cipher:snapshot.cipher,nonce:snapshot.nonce,ciphertext:snapshot.ciphertext},
   {tenantId,workspaceId:tenantId,documentId,epoch:snapshot.keyEpoch},webCrypto);
  const value=JSON.parse(dec.decode(bytes));
  if(!value||value.format!==SNAPSHOT_FORMAT||typeof value.state!=='string'||!Number.isSafeInteger(value.cursor))throw fail('INVALID_PRIVATE_SNAPSHOT');
  const legal=validateLegalDocument(value.base);
  if(legal.id!==documentId||legal.tenantId!==tenantId)throw fail('INVALID_PRIVATE_SNAPSHOT');
  return {base:legal,state:fromBase64url(value.state,3_000_000),cursor:value.cursor};
 }

 const client={
  get device(){return device;},
  pins,
  /** Reopens this browser's enrolled endpoint for the workspace, if any. */
  async open(){
   const record=await deviceRecord();
   if(!record)return null;
   const devices=(await api('/api/devices')).items;
   if(!devices.some(d=>d.id===record.deviceId))throw fail('DEVICE_REVOKED');
   state=await reopenMlsState({module:mls,key:await wrappingKey(),scope:{tenantId,accountId,deviceId:record.deviceId},
    identity:fromBase64url(record.identity),signatureKey:fromBase64url(record.signatureKey),store:stateStore});
   device=record;
   await replenish();
   return client.describeOwnDevice();
  },
  /**
   * Creates a new endpoint key, authorizes it with the account's fresh passkey
   * step-up (stepUp must complete a WebAuthn assertion), and publishes only
   * public material. Account recovery sessions are refused by the service.
   */
  async enroll({stepUp}){
   if(await deviceRecord())throw fail('DEVICE_ALREADY_ENROLLED');
   const installationId=webCrypto.randomUUID(),identity=deviceIdentity(accountId,installationId);
   const raw=new mls.BrowserEndpoint(identity),signatureKey=raw.signatureKey();
   try{
    const thumbprint=await deviceKeyThumbprint(signatureKey,subtle);
    await stepUp();
    await api('/api/devices',{method:'POST',body:{keyThumbprint:thumbprint}});
    const authorized=(await api('/api/devices')).items.find(d=>d.keyThumbprint===thumbprint);
    if(!authorized)throw fail('DEVICE_NOT_AUTHORIZED');
    const record={deviceId:authorized.id,identity:base64url(identity),signatureKey:base64url(signatureKey)};
    state=await initializeMlsState({module:mls,endpoint:raw,key:await wrappingKey(),scope:{tenantId,accountId,deviceId:record.deviceId},identity,store:stateStore});
    await local.set('device:'+scopeKey,record);
    device=record;
   }catch(error){try{raw.free();}catch{}throw error;}
   await api(base+'/private-devices',{method:'POST',body:{deviceId:device.deviceId,identity:device.identity,signatureKey:device.signatureKey}});
   await replenish();
   return client.describeOwnDevice();
  },
  async describeOwnDevice(){
   return {deviceId:device.deviceId,safetyNumber:await deviceSafetyNumber(fromBase64url(device.identity),fromBase64url(device.signatureKey))};
  },
  /** Directory entries of workspace members with local approval status and safety numbers. */
  async directory(){return pins.review((await api(base+'/private-devices')).items,device?.deviceId);},
  approveDevice:entry=>pins.approve(entry),
  async documents(){
   const items=(await api(base+'/private-groups')).items;
   return items.map(item=>({...item,member:!!device&&item.myDevices.includes(device.deviceId)}));
  },
  async createDocument(title){
   if(typeof title!=='string'||!title.trim()||title.length>200)throw fail('INVALID_TITLE');
   const documentId=webCrypto.randomUUID(),groupId=await privateGroupIdAsync(tenantId,documentId,subtle);
   const handle=await state.createGroup(groupId);
   await api(base+'/private-groups',{method:'POST',body:{documentId,groupId:base64url(groupId),deviceId:device.deviceId}});
   const epoch=await cacheEpochKeys(documentId,handle);
   const legal=createLegalDocument({id:documentId,tenantId,title:title.trim()});
   const ydoc=prosemirrorToYDoc(legalToEditor(legal));
   try{
    const envelope=await sealSnapshot(documentId,epoch,{format:SNAPSHOT_FORMAT,base:legal,state:base64url(Y.encodeStateAsUpdate(ydoc)),cursor:0});
    await api(base+'/private-documents',{method:'POST',device:device.deviceId,body:{documentId,envelope,commandId:webCrypto.randomUUID()}});
   }finally{ydoc.destroy();}
   return {documentId};
  },
  syncGroup,
  /** Opens an encrypted editing session; see PrivateDocumentSession below. */
  openDocument:(documentId,options={})=>openSession(documentId,options),
  async close(){await state?.close();},
 };

 async function openSession(documentId,{onStatus=()=>{},onRemote=()=>{},onMembership=()=>{},onError=()=>{}}={}){
  if(!UUID.test(documentId))throw fail('INVALID_DOCUMENT_ID');
  let sync=await syncGroup(documentId);
  if(!sync.active)throw fail(sync.removed?'PRIVATE_ACCESS_REMOVED':'PRIVATE_WELCOME_PENDING');
  const ydoc=new Y.Doc(),acked=new Y.Doc();
  let legal=null,keyEpoch=null,cursor=0,closed=false,socket=null,inFlight=null,timer=null,removed=false,frames=0,version=null,busy=Promise.resolve();
  const seqSlot=()=>'seq:'+scopeKey+':'+documentId+':'+keyEpoch;
  async function loadSnapshot(){
   const snapshot=await api(base+'/private-documents/'+documentId,{device:device.deviceId});
   const opened=await openSnapshot(documentId,snapshot);
   legal=legal??opened.base;
   Y.applyUpdate(ydoc,opened.state,'remote');Y.applyUpdate(acked,opened.state,'remote');
   keyEpoch=snapshot.keyEpoch;version=snapshot.version;cursor=Math.max(cursor,opened.cursor);frames=0;
  }
  async function applyFrame(position,frame){
   if(frame.epoch!==keyEpoch)return;
   const info=groupCache.get(documentId);
   // Frames authenticate group membership (AES-GCM under the epoch key), not the
   // individual sender; the claimed sender must still be a current roster device.
   if(!info?.members.some(m=>m.deviceId===frame.senderDeviceId&&m.active))throw fail('UNKNOWN_FRAME_SENDER');
   const key=await epochKey(documentId,keyEpoch,'update');
   const opened=await openPrivateYjsUpdate({key,context:{tenantId,workspaceId:tenantId,documentId,senderDeviceId:frame.senderDeviceId,epoch:keyEpoch},envelope:frame,webCrypto});
   verifyUpdate(ydoc,opened.update,legal);
   Y.applyUpdate(acked,opened.update,'remote');Y.applyUpdate(ydoc,opened.update,'remote');
   cursor=Math.max(cursor,position);frames++;onRemote();
  }
  async function pullHttp(){
   for(;;){
    const page=await api(base+'/private-documents/'+documentId+'/updates?recipientDeviceId='+device.deviceId+'&after='+cursor+'&limit=50');
    if(page.keyEpoch!==keyEpoch)return false;
    for(const item of page.items){const {position,...frame}=item;await applyFrame(position,frame);}
    if(page.nextCursor===null)return true;
   }
  }
  async function nextSequence(){
   const next=((await local.get(seqSlot()))??0)+1;
   await local.set(seqSlot(),next);return next;
  }
  function remaining(){
   if(Y.equalSnapshots(Y.snapshot(ydoc),Y.snapshot(acked)))return null;
   return Y.encodeStateAsUpdate(ydoc,Y.encodeStateVector(acked));
  }
  async function sendPending(){
   if(closed||removed||inFlight||keyEpoch===null)return;
   const update=remaining();
   if(!update||update.byteLength<=2)return;
   if(update.byteLength>PRIVATE_UPDATE_MAX_BYTES){await saveSnapshot();return;}
   const key=await epochKey(documentId,keyEpoch,'update');
   if(!key)return;
   const frame=await sealPrivateYjsUpdate({key,context:{tenantId,workspaceId:tenantId,documentId,senderDeviceId:device.deviceId,epoch:keyEpoch},
    update,sequence:await nextSequence(),webCrypto});
   inFlight={update,frame};
   if(socket?.readyState===1){socket.send(JSON.stringify({kind:'update',frame}));return;}
   try{
    const saved=await api(base+'/private-documents/'+documentId+'/updates',{method:'POST',body:frame});
    acknowledge(saved.frame.position);
   }catch(error){inFlight=null;throw error;}
  }
  function acknowledge(_position){
   if(!inFlight)return;
   // The pull cursor advances only over frames actually applied here; an own
   // acknowledgement must not skip a concurrent frame not yet received.
   Y.applyUpdate(acked,inFlight.update,'confirmed');inFlight=null;
   onStatus('Encrypted edit saved.');
   queue(sendPending);
  }
  async function saveSnapshot(){
   const envelope=await sealSnapshot(documentId,keyEpoch,{format:SNAPSHOT_FORMAT,base:legal,state:base64url(Y.encodeStateAsUpdate(ydoc)),cursor});
   const saved=await api(base+'/private-documents/'+documentId,{method:'PUT',device:device.deviceId,body:{envelope,expectedVersion:version,commandId:webCrypto.randomUUID()}});
   version=saved.version;Y.applyUpdate(acked,Y.encodeStateAsUpdate(ydoc),'confirmed');frames=0;
  }
  /** Re-encrypt the complete state for the group's new epoch (after add/remove). */
  async function rekey(){
   const info=sync.info;
   if(sync.epoch===null||info.keyEpoch===null||sync.epoch<=info.keyEpoch||sync.epoch!==info.epoch)return false;
   if(keyEpoch!==info.keyEpoch)await loadSnapshot();
   await pullHttp();
   if(inFlight&&socket?.readyState!==1)inFlight=null;
   const previous=keyEpoch;keyEpoch=sync.epoch;
   try{await saveSnapshot();}catch(error){keyEpoch=previous;if(['PRIVATE_VERSION_CONFLICT','PRIVATE_REKEY_REQUIRED','PRIVATE_DEVICE_NOT_AUTHORIZED'].includes(error.code))return false;throw error;}
   onStatus('Re-encrypted for membership epoch '+keyEpoch+'.');
   connect();
   return true;
  }
  function connect(){
   if(closed||removed||!WebSocketCtor||!origin)return;
   try{socket?.close();}catch{}
   const site=new URL(origin);
   const ws=new WebSocketCtor('wss://'+site.host+'/ws/private/'+tenantId+'/'+documentId+'/'+device.deviceId,'dge-private-v1');
   socket=ws;
   ws.addEventListener('message',event=>queue(async()=>{
    if(ws!==socket)return;
    const message=JSON.parse(typeof event.data==='string'?event.data:dec.decode(event.data));
    if(message.kind==='ready'){
     if(message.keyEpoch!==keyEpoch)return refresh();
     ws.send(JSON.stringify({kind:'pull',after:cursor,limit:10}));
     inFlight=null;queue(sendPending);
    }else if(message.kind==='updates'){
     if(message.keyEpoch!==keyEpoch)return refresh();
     for(const item of message.items)await applyFrame(item.position,item.frame);
     if(message.nextCursor!==null)ws.send(JSON.stringify({kind:'pull',after:cursor,limit:10}));
    }else if(message.kind==='update')await applyFrame(message.position,message.frame);
    else if(message.kind==='ack')acknowledge(message.position);
   }));
   ws.addEventListener('close',()=>{if(ws===socket){socket=null;inFlight=null;}});
   ws.addEventListener('error',()=>{});
  }
  // All protocol work for a session is strictly serialized. run() rejects to
  // its caller; queue() is for background triggers and reports via onError.
  function run(task){const result=busy.then(()=>closed?undefined:task());busy=result.catch(()=>{});return result;}
  function queue(task){
   run(task).catch(error=>{
    if(closed)return;
    if(['PRIVATE_DEVICE_NOT_AUTHORIZED','PRIVATE_ACCESS_REMOVED','PRIVATE_EPOCH_CHANGED'].includes(error?.code))return queue(refresh);
    onError(error);
   });
  }
  /** Poll the ordered mailbox; process commits, rekey, reload on epoch change. */
  async function refresh(){
   if(closed)return;
   sync=await syncGroup(documentId);
   if(!sync.active){
    removed=true;try{socket?.close();}catch{}socket=null;
    onMembership({removed:true});onStatus('This device was removed from the document. New edits can no longer be decrypted here.');
    return;
   }
   onMembership({epoch:sync.epoch,members:sync.info.members});
   if(sync.info.keyEpoch!==keyEpoch&&sync.info.keyEpoch!==null&&await epochKey(documentId,sync.info.keyEpoch,'snapshot')){
    await loadSnapshot();connect();
   }
   if(sync.epoch>sync.info.keyEpoch)await rekey();
   if(!socket)connect();
   // Catch up on frames appended over HTTP or via another relay instance:
   // realtime fanout is a latency optimization, the ordered ledger is authority.
   if(socket?.readyState===1)socket.send(JSON.stringify({kind:'pull',after:cursor,limit:10}));
   else if(keyEpoch===sync.info.keyEpoch)await pullHttp();
   if(frames>=50&&keyEpoch===sync.info.epoch)await saveSnapshot().catch(()=>{});
   await sendPending();
  }
  async function memberDevices(accountId){
   const reviewed=await client.directory();
   const entries=reviewed.filter(d=>d.accountId===accountId);
   if(!entries.length)throw fail('NO_ENROLLED_DEVICES');
   const blocked=entries.filter(e=>!['approved','own'].includes(e.status));
   if(blocked.length)throw fail('KEY_APPROVAL_REQUIRED',blocked);
   return entries;
  }
  async function change(kind,target){
   const handle=sync.handle;
   const item=kind==='add'
    ?await state.add(handle,fromBase64url(target.keyPackage,65536),fromBase64url(target.identity),fromBase64url(target.signatureKey))
    :await state.remove(handle,fromBase64url(target.identity));
   const meta={epoch:sync.epoch,add:kind==='add'?target.deviceId:null,remove:kind==='remove'?target.deviceId:null};
   await local.set('pending:'+item.id,meta);
   await postCommit(documentId,handle,item,meta);
   sync=await syncGroup(documentId);
  }
  const session={
   ydoc,
   get base(){return legal;},
   get keyEpoch(){return keyEpoch;},
   get epoch(){return sync.epoch;},
   get removed(){return removed;},
   members:()=>sync.info.members,
   refresh:()=>run(refresh),
   flush:()=>run(sendPending),
   async addMember(accountId){
    return run(async()=>{
     sync=await syncGroup(documentId);
     const present=new Set(sync.info.members.filter(m=>m.active).map(m=>m.deviceId));
     for(const entry of await memberDevices(accountId)){
      if(present.has(entry.deviceId))continue;
      const claimed=await api(base+'/private-devices/'+entry.deviceId+'/key-packages/claim',{method:'POST',body:{}});
      // The claimed package must carry exactly the approved identity and key;
      // the endpoint re-verifies this inside the signed key package.
      if(claimed.identity!==entry.identity||claimed.signatureKey!==entry.signatureKey||claimed.accountId!==entry.accountId)throw fail('KEY_PACKAGE_MISMATCH');
      await change('add',claimed);
     }
     await rekey();
    });
   },
   async removeMember(accountId){
    return run(async()=>{
     sync=await syncGroup(documentId);
     for(const member of sync.info.members.filter(m=>m.active&&m.accountId===accountId&&m.deviceId!==device.deviceId))await change('remove',member);
     await rekey();
    });
   },
   /** Admin duty: remove roster devices whose account left the workspace or was revoked. */
   async removeStaleDevices(){
    return run(async()=>{
     sync=await syncGroup(documentId);
     let changed=false;
     for(const member of sync.info.members.filter(m=>m.active&&m.stale&&m.deviceId!==device.deviceId)){await change('remove',member);changed=true;}
     if(changed)await rekey();
     return changed;
    });
   },
   close(){
    if(closed)return;closed=true;clearInterval(timer);
    try{socket?.close();}catch{}
    ydoc.off('update',onLocal);ydoc.destroy();acked.destroy();
   }
  };
  const onLocal=(_update,source)=>{if(source==='remote'||source==='confirmed'||closed)return;onStatus('Encrypting and saving edit.');queue(sendPending);};
  ydoc.on('update',onLocal);
  if(sync.info.keyEpoch===null)throw fail('PRIVATE_DOCUMENT_NOT_FOUND');
  // A newly admitted device can read only once a member re-encrypts the
  // document for an epoch this device belongs to.
  if(!await epochKey(documentId,sync.info.keyEpoch,'snapshot')){ydoc.destroy();acked.destroy();throw fail('PRIVATE_REKEY_PENDING');}
  await loadSnapshot();
  await pullHttp();
  if(sync.epoch>sync.info.keyEpoch)await rekey();
  connect();
  timer=setInterval(()=>queue(refresh),pollMs);
  timer.unref?.();
  return session;
 }
 return client;
}
