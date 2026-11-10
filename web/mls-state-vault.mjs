// Endpoint-only durable coordinator. Device/key authorization is supplied by the
// embedding client; this module never stores an unwrapped key or sends requests.
const enc=new TextEncoder(),dec=new TextDecoder('utf-8',{fatal:true});
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const MAX_CIPHER=24_000_016,MAX_INBOX=2_000_000;
export class MlsStateError extends Error{constructor(code){super(code);this.code=code;}}
const fail=code=>new MlsStateError(code);
function scopeValue(scope){
 if(!scope || Object.keys(scope).sort().join(',')!=='accountId,deviceId,tenantId' || ![scope.tenantId,scope.accountId,scope.deviceId].every(v=>typeof v==='string'&&uuid.test(v)))throw fail('MLS_STATE_SCOPE');
 return Object.freeze({tenantId:scope.tenantId,accountId:scope.accountId,deviceId:scope.deviceId});
}
const slot=scope=>JSON.stringify(['quill-mls-state-v1',scope.tenantId,scope.accountId,scope.deviceId]);
function pins(identity,signatureKey){
 if(!(identity instanceof Uint8Array)||identity.length<1||identity.length>512||!(signatureKey instanceof Uint8Array)||signatureKey.length!==32)throw fail('MLS_STATE_DEVICE');
 return {identity:identity.slice(),signatureKey:signatureKey.slice()};
}
const equal=(a,b)=>a instanceof Uint8Array&&b instanceof Uint8Array&&a.length===b.length&&a.every((v,i)=>v===b[i]);
function counter(value){return Number.isInteger(value)&&value>0&&value<=0xffffffff;}
function bytesInput(value,max){if(!(value instanceof Uint8Array)||!value.length||value.length>max)throw fail('MLS_OPERATION_REJECTED');return value.slice();}
function groupInput(value){if(!counter(value))throw fail('MLS_OPERATION_REJECTED');return value;}
function pinJson(value){if(!Array.isArray(value)||!value.length||value.length>1000)throw fail('MLS_OPERATION_REJECTED');let result;try{result=JSON.stringify(value);}catch{throw fail('MLS_OPERATION_REJECTED');}if(result.length>1_000_000)throw fail('MLS_OPERATION_REJECTED');return result;}

function inspect(marker,record,pin){
 if(marker===undefined&&record===undefined)return 0;
 if(!marker||!record)throw fail('MLS_STATE_MISSING');
 if(marker.version!==1||record.version!==1||!counter(marker.generation)||record.generation!==marker.generation)throw fail('MLS_STATE_ROLLBACK');
 if(!equal(marker.identity,pin.identity)||!equal(marker.signatureKey,pin.signatureKey))throw fail('MLS_STATE_DEVICE');
 if(!(record.nonce instanceof Uint8Array)||record.nonce.length!==12||!(record.ciphertext instanceof Uint8Array)||record.ciphertext.length<16||record.ciphertext.length>MAX_CIPHER)throw fail('MLS_STATE_CORRUPT');
 return marker.generation;
}
export async function openMlsStateStore({database='quill-mls-state-v1'}={}){
 if(typeof database!=='string'||!/^quill-mls-[a-z0-9-]{1,64}$/.test(database))throw fail('MLS_STATE_STORAGE');
 const db=await new Promise((resolve,reject)=>{
  const request=indexedDB.open(database,1);let failed=false;
  const timer=setTimeout(()=>{failed=true;reject(fail('MLS_STATE_STORAGE'));},10000);
  request.onupgradeneeded=()=>{request.result.createObjectStore('continuity');request.result.createObjectStore('checkpoints');};
  request.onsuccess=()=>{clearTimeout(timer);if(failed){request.result.close();return;}resolve(request.result);};
  request.onerror=request.onblocked=()=>{clearTimeout(timer);failed=true;reject(fail('MLS_STATE_STORAGE'));};
 });
 db.onversionchange=()=>db.close();
 function transaction(scope,pin,write){
  return new Promise((resolve,reject)=>{
   let tx,record,marker,ready=0,result,failure;
   try{
    tx=db.transaction(['continuity','checkpoints'],write?'readwrite':'readonly');
    const id=slot(scope),markers=tx.objectStore('continuity'),records=tx.objectStore('checkpoints');
    const completeRead=()=>{
     if(++ready!==2)return;
     try{
      const generation=inspect(marker,record,pin);
      if(!write){result=generation?{generation,nonce:record.nonce,ciphertext:record.ciphertext}:null;return;}
      if(generation!==write.expectedGeneration)throw fail('MLS_STATE_CONFLICT');
      markers.put({version:1,generation:write.generation,identity:pin.identity,signatureKey:pin.signatureKey},id);
      records.put({version:1,generation:write.generation,nonce:write.nonce,ciphertext:write.ciphertext},id);
      result={generation:write.generation};
     }catch(error){failure=error instanceof MlsStateError?error:fail('MLS_STATE_STORAGE');tx.abort();}
    };
    const a=markers.get(id),b=records.get(id);
    a.onsuccess=()=>{marker=a.result;completeRead();};b.onsuccess=()=>{record=b.result;completeRead();};
    tx.oncomplete=()=>resolve(result);tx.onabort=()=>reject(failure??fail('MLS_STATE_STORAGE'));
   }catch{reject(fail('MLS_STATE_STORAGE'));}
  });
 }
 return Object.freeze({
  load(scope,pin){return transaction(scopeValue(scope),pins(pin.identity,pin.signatureKey));},
  save(scope,pin,checkpoint,expectedGeneration){
   if(!Number.isInteger(expectedGeneration)||expectedGeneration<0||expectedGeneration>=0xffffffff||checkpoint.generation!==expectedGeneration+1)throw fail('MLS_STATE_GENERATION');
   const record={generation:checkpoint.generation,nonce:checkpoint.nonce,ciphertext:checkpoint.ciphertext};
   inspect({version:1,generation:record.generation,...pin},{version:1,...record},pin);
   return transaction(scopeValue(scope),pins(pin.identity,pin.signatureKey),{...record,nonce:record.nonce.slice(),ciphertext:record.ciphertext.slice(),expectedGeneration});
  },
  close(){db.close();},
 });
}
function encodeBytes(bytes){
 let text='';for(let i=0;i<bytes.length;i+=8192)text+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(text);
}
function decodeBytes(value){
 if(typeof value!=='string'||value.length>Math.ceil(MAX_INBOX*4/3)+4||value.length%4!==0||!/^[A-Za-z0-9+/]*={0,2}$/.test(value))throw fail('MLS_STATE_CORRUPT');
 const bytes=Uint8Array.from(atob(value),c=>c.charCodeAt(0));if(encodeBytes(bytes)!==value)throw fail('MLS_STATE_CORRUPT');return bytes;
}
function byteLength(value){return value.length/4*3-(value.endsWith('==')?2:value.endsWith('=')?1:0);}
function byteSize(inbox,outbox){return inbox.reduce((n,item)=>n+byteLength(item.bytes),0)+outbox.reduce((n,item)=>n+item.frames.reduce((m,frame)=>m+byteLength(frame.bytes),0),0);}
function readApplication(bytes){
 let data;try{data=JSON.parse(dec.decode(bytes));}catch{throw fail('MLS_STATE_CORRUPT');}
 if(!data||Object.keys(data).sort().join(',')!=='inbox,outbox,version'||data.version!==1||!Array.isArray(data.inbox)||!Array.isArray(data.outbox)||data.inbox.length+data.outbox.length>1000)throw fail('MLS_STATE_CORRUPT');
 const ids=new Set();
 for(const item of data.inbox){
  if(!item||Object.keys(item).sort().join(',')!=='bytes,group,id,sender'||typeof item.id!=='string'||!uuid.test(item.id)||ids.has(item.id)||!counter(item.group))throw fail('MLS_STATE_CORRUPT');
  ids.add(item.id);decodeBytes(item.bytes);const sender=decodeBytes(item.sender);
  if(!sender.length||sender.length>512)throw fail('MLS_STATE_CORRUPT');
 }
 for(const item of data.outbox){
  const kinds={keyPackage:['key-package'],encrypt:['application'],add:['commit','welcome'],remove:['commit']}[item?.kind];
  if(!item||Object.keys(item).sort().join(',')!=='frames,group,id,kind,recipient'||typeof item.id!=='string'||!uuid.test(item.id)||ids.has(item.id)||!kinds||!Array.isArray(item.frames)||item.frames.length!==kinds.length||!(item.kind==='keyPackage'?item.group===0:counter(item.group)))throw fail('MLS_STATE_CORRUPT');
  ids.add(item.id);const recipient=decodeBytes(item.recipient);if(recipient.length>512||(['add','remove'].includes(item.kind)&&!recipient.length))throw fail('MLS_STATE_CORRUPT');
  for(let i=0;i<kinds.length;i++)if(!item.frames[i]||Object.keys(item.frames[i]).sort().join(',')!=='bytes,kind'||item.frames[i].kind!==kinds[i]||decodeBytes(item.frames[i].bytes).length<1)throw fail('MLS_STATE_CORRUPT');
 }
 if(byteSize(data.inbox,data.outbox)>MAX_INBOX)throw fail('MLS_STATE_CAPACITY');
 return {inbox:data.inbox,outbox:data.outbox};
}
function coordinator({endpoint,key,scope,pin,store,generation,inbox,outbox}){
 let queue=Promise.resolve(),locked=false;
 function serial(action){const work=queue.then(()=>{if(locked)throw fail('MLS_STATE_LOCKED');return action();});queue=work.catch(()=>{});return work;}
 function lock(){locked=true;try{endpoint.free();}catch{}inbox=[];outbox=[];}
 function protocolFailure(error){if(error!=='MLS_OPERATION_REJECTED'){lock();throw fail('MLS_STATE_LOCKED');}throw fail('MLS_OPERATION_REJECTED');}
 async function persist(nextInbox=inbox,nextOutbox=outbox){
  if(generation>=0xffffffff){lock();throw fail('MLS_STATE_GENERATION');}
  if(nextInbox.length+nextOutbox.length>1000||byteSize(nextInbox,nextOutbox)>MAX_INBOX){lock();throw fail('MLS_STATE_CAPACITY');}
  let sealed;
  try{
   sealed=await endpoint.sealCheckpoint(key,JSON.stringify(scope),generation+1,enc.encode(JSON.stringify({version:1,inbox:nextInbox,outbox:nextOutbox})));
   await store.save(scope,pin,{generation:sealed.generation,nonce:sealed.nonce,ciphertext:sealed.ciphertext},generation);
   generation++;inbox=nextInbox;outbox=nextOutbox;
  }catch(error){lock();throw error instanceof MlsStateError?error:fail('MLS_STATE_STORAGE');}
  finally{sealed?.free();}
 }
 async function mutate(action){let result;try{result=action();}catch(error){protocolFailure(error);}await persist();return result;}
 const event=item=>({id:item.id,group:item.group,sender:decodeBytes(item.sender),bytes:decodeBytes(item.bytes)});
 const outgoing=item=>({id:item.id,kind:item.kind,group:item.group,recipient:decodeBytes(item.recipient),frames:item.frames.map(frame=>({kind:frame.kind,bytes:decodeBytes(frame.bytes)}))});
 async function send(kind,group,recipient,action){
  let frames;try{frames=action();}catch(error){protocolFailure(error);}
  const item={id:crypto.randomUUID(),kind,group,recipient:encodeBytes(recipient),frames:frames.map(frame=>({kind:frame.kind,bytes:encodeBytes(frame.bytes)}))};
  await persist(inbox,[...outbox,item]);return outgoing(item);
 }
 return Object.freeze({
  get signatureKey(){return pin.signatureKey.slice();},
  groups(){return serial(()=>JSON.parse(endpoint.groupInventory()));},
  async createGroup(id){id=bytesInput(id,512);return serial(()=>mutate(()=>endpoint.createGroup(id)));},
  keyPackage(){return serial(()=>send('keyPackage',0,new Uint8Array(),()=>[{kind:'key-package',bytes:endpoint.keyPackage()}]));},
  async join(welcome,id,roster){welcome=bytesInput(welcome,2_000_000);id=bytesInput(id,512);const approved=pinJson(roster);return serial(()=>mutate(()=>endpoint.join(welcome,id,approved)));},
  async add(group,keyPackage,identity,signatureKey){group=groupInput(group);keyPackage=bytesInput(keyPackage,65536);identity=bytesInput(identity,512);signatureKey=bytesInput(signatureKey,32);return serial(()=>send('add',group,identity,()=>{const result=endpoint.add(group,keyPackage,identity,signatureKey);try{return [{kind:'commit',bytes:result.commit},{kind:'welcome',bytes:result.welcome}];}finally{result.free();}}));},
  async remove(group,identity){group=groupInput(group);identity=bytesInput(identity,512);return serial(()=>send('remove',group,identity,()=>[{kind:'commit',bytes:endpoint.remove(group,identity)}]));},
  async mergePending(group){group=groupInput(group);return serial(()=>{if(outbox.some(item=>item.group===group&&['add','remove'].includes(item.kind)))throw fail('MLS_COMMIT_UNDELIVERED');return mutate(()=>endpoint.mergePending(group));});},
  async encrypt(group,bytes){group=groupInput(group);bytes=bytesInput(bytes,1_000_000);return serial(()=>send('encrypt',group,new Uint8Array(),()=>[{kind:'application',bytes:endpoint.encrypt(group,bytes)}]));},
  async receive(group,wire,roster){group=groupInput(group);wire=bytesInput(wire,2_000_000);const approved=pinJson(roster);return serial(async()=>{
   let result;try{result=endpoint.receive(group,wire,approved);}catch(error){protocolFailure(error);}
   let item;try{if(result.application)item={id:crypto.randomUUID(),group,sender:encodeBytes(result.sender),bytes:encodeBytes(result.bytes)};}finally{result.free();}
   await persist(item?[...inbox,item]:inbox);return item?event(item):null;
  });},
  pending(){return serial(()=>inbox.map(event));},
  outgoing(){return serial(()=>outbox.map(outgoing));},
  acknowledge(id){return serial(async()=>{if(typeof id!=='string'||!uuid.test(id))throw fail('MLS_STATE_CORRUPT');if(!inbox.some(item=>item.id===id))return {acknowledged:false};await persist(inbox.filter(item=>item.id!==id));return {acknowledged:true};});},
  acknowledgeSent(id){return serial(async()=>{if(typeof id!=='string'||!uuid.test(id))throw fail('MLS_STATE_CORRUPT');if(!outbox.some(item=>item.id===id))return {acknowledged:false};await persist(inbox,outbox.filter(item=>item.id!==id));return {acknowledged:true};});},
  close(){return queue.then(()=>{if(!locked)lock();});},
 });
}
export async function initializeMlsState({module,endpoint,key,scope,identity,store}){
 scope=scopeValue(scope);const pin=pins(identity,endpoint.signatureKey());let sealed,opened,moved;
 try{
  const sealing=endpoint.sealCheckpoint(key,JSON.stringify(scope),1,enc.encode(JSON.stringify({version:1,inbox:[],outbox:[]})));
  endpoint.free();
  sealed=await sealing;
  // Verify the external identity pin before creating a durable record and
  // transfer ownership to a fresh object; old raw handles become unusable.
  opened=await module.BrowserEndpoint.restoreCheckpoint(key,JSON.stringify(scope),1,sealed.nonce,sealed.ciphertext,pin.identity,pin.signatureKey);
  moved=opened.takeEndpoint();
  await store.save(scope,pin,{generation:sealed.generation,nonce:sealed.nonce,ciphertext:sealed.ciphertext},0);
  return coordinator({endpoint:moved,key,scope,pin,store,generation:1,inbox:[],outbox:[]});
 }catch(error){moved?.free();throw error instanceof MlsStateError?error:fail('MLS_STATE_STORAGE');}
 finally{opened?.free();sealed?.free();}
}
export async function reopenMlsState({module,key,scope,identity,signatureKey,store}){
 scope=scopeValue(scope);const pin=pins(identity,signatureKey);const record=await store.load(scope,pin);if(!record)throw fail('MLS_STATE_MISSING');
 let opened,moved;
 try{
  opened=await module.BrowserEndpoint.restoreCheckpoint(key,JSON.stringify(scope),record.generation,record.nonce,record.ciphertext,pin.identity,pin.signatureKey);
  const {inbox,outbox}=readApplication(opened.applicationState);moved=opened.takeEndpoint();
  return coordinator({endpoint:moved,key,scope,pin,store,generation:record.generation,inbox,outbox});
 }catch(error){moved?.free();throw error instanceof MlsStateError?error:fail('MLS_STATE_CORRUPT');}
 finally{opened?.free();}
}
