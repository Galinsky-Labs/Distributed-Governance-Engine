import test from 'node:test';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import {mlsFixture} from './support/mls-fixture.mjs';
const binary=process.env.DGE_BROWSER_EXECUTABLE;
if(!binary)throw Error('DGE_BROWSER_EXECUTABLE is required');
test('three isolated browser endpoints authenticate MLS messages and exclude a removed device',{timeout:90000},async()=>{
 const fixture=await mlsFixture();let browser;
 try{
  browser=await puppeteer.launch({executablePath:binary,headless:true,acceptInsecureCerts:true,args:['--no-sandbox','--disable-dev-shm-usage']});
  const peers=[];
  for(const name of ['alice-device','bob-device','carol-device']){
   const context=await browser.createBrowserContext(),page=await context.newPage();
   await page.goto(fixture.origin);
   const publicData=await page.evaluate(async name=>{
    const {default:init,BrowserEndpoint}=await import('/quill_mls.js');await init();
    window.endpoint=new BrowserEndpoint(new TextEncoder().encode(name));
    return {identity:Array.from(new TextEncoder().encode(name)),signature_key:Array.from(endpoint.signatureKey()),package:Array.from(endpoint.keyPackage())};
   },name);
   peers.push({page,...publicData});
  }
  const [alice,bob,carol]=peers;
  let pins=[alice,bob].map(({identity,signature_key})=>({identity,signature_key}));
  const addition=await alice.page.evaluate(bob=>{
   window.group=endpoint.createGroup(new TextEncoder().encode('workspace:document'));
   const added=endpoint.add(group,new Uint8Array(bob.package),new Uint8Array(bob.identity),new Uint8Array(bob.signature_key));
   const result={commit:Array.from(added.commit),welcome:Array.from(added.welcome)};added.free();endpoint.mergePending(group);return result;
  },{package:bob.package,identity:bob.identity,signature_key:bob.signature_key});
  await bob.page.evaluate(({welcome,pins})=>{window.group=endpoint.join(new Uint8Array(welcome),new TextEncoder().encode('workspace:document'),JSON.stringify(pins));},{welcome:addition.welcome,pins});
  const encrypted=await alice.page.evaluate(()=>Array.from(endpoint.encrypt(group,new TextEncoder().encode('Confidential MLS canary'))));
  assert.equal(await bob.page.evaluate(({encrypted,pins})=>{
   const altered=new Uint8Array(encrypted);altered[altered.length-1]^=1;
   try{endpoint.receive(group,altered,JSON.stringify(pins));return false;}catch{}
   const valid=endpoint.receive(group,new Uint8Array(encrypted),JSON.stringify(pins));
   const correct=valid.application && new TextDecoder().decode(valid.bytes)==='Confidential MLS canary';valid.free();
   try{endpoint.receive(group,new Uint8Array(encrypted),JSON.stringify(pins));return false;}catch{}
   return correct;
  },{encrypted,pins}),true);
  const addition2=await alice.page.evaluate(carol=>{
   const added=endpoint.add(group,new Uint8Array(carol.package),new Uint8Array(carol.identity),new Uint8Array(carol.signature_key));
   const result={commit:Array.from(added.commit),welcome:Array.from(added.welcome)};added.free();endpoint.mergePending(group);return result;
  },{package:carol.package,identity:carol.identity,signature_key:carol.signature_key});
  const oldPins=pins;pins=[...pins,{identity:carol.identity,signature_key:carol.signature_key}];
  assert.equal(await bob.page.evaluate(({commit,oldPins,pins})=>{
   try{endpoint.receive(group,new Uint8Array(commit),JSON.stringify(oldPins));return false;}catch{}
   const result=endpoint.receive(group,new Uint8Array(commit),JSON.stringify(pins));const okay=!result.application;result.free();return okay;
  },{commit:addition2.commit,oldPins,pins}),true);
  await carol.page.evaluate(({welcome,pins})=>{window.group=endpoint.join(new Uint8Array(welcome),new TextEncoder().encode('workspace:document'),JSON.stringify(pins));},{welcome:addition2.welcome,pins});
  const removal=await alice.page.evaluate(identity=>{const message=Array.from(endpoint.remove(group,new Uint8Array(identity)));endpoint.mergePending(group);return message;},bob.identity);
  pins=pins.filter(pin=>String(pin.identity)!==String(bob.identity));
  for(const peer of [bob,carol])await peer.page.evaluate(({removal,pins})=>{endpoint.receive(group,new Uint8Array(removal),JSON.stringify(pins)).free();},{removal,pins});
  assert.equal(await bob.page.evaluate(()=>endpoint.active(group)),false);
  const future=await alice.page.evaluate(()=>Array.from(endpoint.encrypt(group,new TextEncoder().encode('Future epoch canary'))));
  assert.equal(await carol.page.evaluate(({future,pins})=>{const received=endpoint.receive(group,new Uint8Array(future),JSON.stringify(pins));const matches=new TextDecoder().decode(received.bytes)==='Future epoch canary';received.free();return matches;},{future,pins}),true);
  assert.equal(await bob.page.evaluate(({future,pins})=>{try{endpoint.receive(group,new Uint8Array(future),JSON.stringify(pins));return false;}catch{return true;}},{future,pins}),true);
  for(const peer of peers)assert.equal(await peer.page.evaluate(()=>{endpoint.close(group);try{endpoint.encrypt(group,new Uint8Array([1]));return false;}catch{endpoint.free();return true;}}),true);
 }finally{await browser?.close();await fixture.close();}
});

test('browser checkpoint encryption survives context loss and binds key, device scope and trusted generation',{timeout:90000},async()=>{
 const fixture=await mlsFixture();let browser;
 try{
  browser=await puppeteer.launch({executablePath:binary,headless:true,acceptInsecureCerts:true,args:['--no-sandbox','--disable-dev-shm-usage']});
  const context=await browser.createBrowserContext(),other=await browser.createBrowserContext();
  let alice=await context.newPage();const bob=await other.newPage();
  const setup=async(page,name)=>{
   await page.goto(fixture.origin);
   return page.evaluate(async name=>{
    window.mls=await import('/quill_mls.js');await mls.default();window.endpoint=new mls.BrowserEndpoint(new TextEncoder().encode(name));
    return {identity:Array.from(new TextEncoder().encode(name)),signature_key:Array.from(endpoint.signatureKey()),package:Array.from(endpoint.keyPackage())};
   },name);
  };
  const a=await setup(alice,'alice-device'),b=await setup(bob,'bob-device');
  const pins=[a,b].map(({identity,signature_key})=>({identity,signature_key}));
  const addition=await alice.evaluate(b=>{
   window.group=endpoint.createGroup(new TextEncoder().encode('persisted-document'));
   const added=endpoint.add(group,new Uint8Array(b.package),new Uint8Array(b.identity),new Uint8Array(b.signature_key));
   const welcome=Array.from(added.welcome);added.free();endpoint.mergePending(group);return {welcome,group};
  },b);
  await bob.evaluate(({welcome,pins})=>{window.group=endpoint.join(new Uint8Array(welcome),new TextEncoder().encode('persisted-document'),JSON.stringify(pins));},{welcome:addition.welcome,pins});
  const scope={tenantId:'00000000-0000-4000-8000-000000000001',accountId:'00000000-0000-4000-8000-000000000002',deviceId:'00000000-0000-4000-8000-000000000003'};
  const saved=await alice.evaluate(async scope=>{
   window.wrapping=await crypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']);
   const application=new TextEncoder().encode('Confidential durable inbox canary');
   const first=Array.from(endpoint.encrypt(group,new TextEncoder().encode('first')));
   const old=await endpoint.sealCheckpoint(wrapping,JSON.stringify(scope),1,application);
   const oldRecord={generation:old.generation,nonce:Array.from(old.nonce),ciphertext:Array.from(old.ciphertext)};old.free();
   const second=Array.from(endpoint.encrypt(group,new TextEncoder().encode('second')));
   const current=await endpoint.sealCheckpoint(wrapping,JSON.stringify(scope),2,application);
   const record={generation:current.generation,nonce:Array.from(current.nonce),ciphertext:Array.from(current.ciphertext)};current.free();
   // Test-only key storage demonstrates native structured cloning. Production
   // key unlock/device authorization is separate and remains disabled.
   const db=await new Promise((resolve,reject)=>{const request=indexedDB.open('mls-checkpoint-test',1);request.onupgradeneeded=()=>request.result.createObjectStore('local');request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(Error('fixture storage failed'));});
   await new Promise((resolve,reject)=>{const tx=db.transaction('local','readwrite');tx.objectStore('local').put(wrapping,'key');tx.objectStore('local').put(record,'ciphertext');tx.objectStore('local').put(2,'trusted-generation');tx.oncomplete=resolve;tx.onabort=()=>reject(Error('fixture storage failed'));});db.close();
   endpoint.free();return {first,second,oldRecord,record};
  },scope);
  const canary=Array.from(new TextEncoder().encode('Confidential durable inbox canary'));
  assert.equal(saved.record.ciphertext.some((_,i)=>canary.every((byte,j)=>saved.record.ciphertext[i+j]===byte)),false);
  await bob.evaluate(({first,second,pins})=>{endpoint.receive(group,new Uint8Array(first),JSON.stringify(pins)).free();endpoint.receive(group,new Uint8Array(second),JSON.stringify(pins)).free();},{first:saved.first,second:saved.second,pins});
  await alice.close();alice=await context.newPage();await alice.goto(fixture.origin);
  const restored=await alice.evaluate(async({scope,a,group,oldRecord})=>{
   window.mls=await import('/quill_mls.js');await mls.default();
   const db=await new Promise((resolve,reject)=>{const request=indexedDB.open('mls-checkpoint-test',1);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(Error('fixture storage failed'));});
   const get=key=>new Promise((resolve,reject)=>{const request=db.transaction('local','readonly').objectStore('local').get(key);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(Error('fixture storage failed'));});
   const key=await get('key'),record=await get('ciphertext'),generation=await get('trusted-generation');db.close();
   const open=(record,keyValue=key,scopeValue=scope,gen=generation,pin=a.signature_key)=>mls.BrowserEndpoint.restoreCheckpoint(keyValue,JSON.stringify(scopeValue),gen,new Uint8Array(record.nonce),new Uint8Array(record.ciphertext),new Uint8Array(a.identity),new Uint8Array(pin));
   let rejected=0;
   const changed={...record,ciphertext:[...record.ciphertext]};changed.ciphertext[changed.ciphertext.length-1]^=1;
   const wrong=await crypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']);
   const extractable=await crypto.subtle.generateKey({name:'AES-GCM',length:256},true,['encrypt','decrypt']);
   const small=await crypto.subtle.generateKey({name:'AES-GCM',length:128},false,['encrypt','decrypt']);
   for(const attempt of [()=>open(oldRecord),()=>open(changed),()=>open(record,wrong),()=>open(record,extractable),()=>open(record,small),()=>open(record,key,{...scope,deviceId:'00000000-0000-4000-8000-000000000004'}),()=>open(record,key,scope,generation,Array(32).fill(0))]){
    try{const unexpected=await attempt();unexpected.free();}catch{rejected++;}
   }
   const opened=await open(record);const preserved=new TextDecoder().decode(opened.applicationState)==='Confidential durable inbox canary';
   window.endpoint=opened.takeEndpoint();opened.free();window.group=group;
   const next=Array.from(endpoint.encrypt(group,new TextEncoder().encode('after browser reload')));
   return {rejected,preserved,nonextractable:key.extractable===false,next,keyMatches:Array.from(endpoint.signatureKey()).every((byte,i)=>byte===a.signature_key[i])};
  },{scope,a,group:addition.group,oldRecord:saved.oldRecord});
  assert.equal(restored.rejected,7);assert.equal(restored.preserved,true);assert.equal(restored.nonextractable,true);assert.equal(restored.keyMatches,true);
  assert.equal(await bob.evaluate(({next,pins})=>{const message=endpoint.receive(group,new Uint8Array(next),JSON.stringify(pins));const matches=new TextDecoder().decode(message.bytes)==='after browser reload';message.free();return matches;},{next:restored.next,pins}),true);
 }finally{await browser?.close();await fixture.close();}
});

test('durable coordinator preserves inbox/outbox, fences concurrent writers and fails closed on storage loss',{timeout:90000},async()=>{
 const fixture=await mlsFixture();let browser;
 try{
  browser=await puppeteer.launch({executablePath:binary,headless:true,acceptInsecureCerts:true,args:['--no-sandbox','--disable-dev-shm-usage']});
  const ownerContext=await browser.createBrowserContext(),peerContext=await browser.createBrowserContext();
  const alice=await ownerContext.newPage(),bob=await peerContext.newPage();
  const base={tenantId:'00000000-0000-4000-8000-000000000011',accountId:'00000000-0000-4000-8000-000000000012',deviceId:'00000000-0000-4000-8000-000000000013'};
  const setup=async(page,name,scope)=>{
   await page.goto(fixture.origin);
   return page.evaluate(async({name,scope})=>{
    window.mls=await import('/quill_mls.js');await mls.default();window.vault=await import('/mls-state-vault.mjs');
    window.scope=scope;window.identity=new TextEncoder().encode(name);window.key=await crypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']);
    window.store=await vault.openMlsStateStore({database:'quill-mls-durable-test'});
    window.client=await vault.initializeMlsState({module:mls,endpoint:new mls.BrowserEndpoint(identity),key,scope,identity,store});
    window.signatureKey=client.signatureKey;
    window.initialRecord=await store.load(scope,{identity,signatureKey});
    window.reopen=()=>vault.reopenMlsState({module:mls,key,scope,identity,signatureKey,store});
    window.serialize=item=>({id:item.id,kind:item.kind,group:item.group,frames:item.frames.map(frame=>({kind:frame.kind,bytes:Array.from(frame.bytes)}))});
    // Independent native CryptoKey structured-clone fixture for another tab.
    const db=await new Promise((resolve,reject)=>{const request=indexedDB.open('quill-mls-fixture-unlock',1);request.onupgradeneeded=()=>request.result.createObjectStore('keys');request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(Error('fixture storage failed'));});
    await new Promise((resolve,reject)=>{const tx=db.transaction('keys','readwrite');tx.objectStore('keys').put(key,'key');tx.oncomplete=resolve;tx.onabort=()=>reject(Error('fixture storage failed'));});db.close();
    return {identity:Array.from(identity),signature_key:Array.from(signatureKey)};
   },{name,scope});
  };
  const a=await setup(alice,'durable-alice',base),b=await setup(bob,'durable-bob',{...base,deviceId:'00000000-0000-4000-8000-000000000014'}),pins=[a,b];
  const kp=await bob.evaluate(async()=>serialize(await client.keyPackage()));
  const admission=await alice.evaluate(async({kp,b})=>{
   window.group=await client.createGroup(new TextEncoder().encode('durable-workspace'));
   const added=await client.add(group,new Uint8Array(kp.frames[0].bytes),new Uint8Array(b.identity),new Uint8Array(b.signature_key));
   let blocked=false;try{await client.mergePending(group);}catch(error){blocked=error.code==='MLS_COMMIT_UNDELIVERED';}
   await client.close();window.client=await reopen();const pending=await client.outgoing(),groups=await client.groups();
   return {blocked,recovered:pending.length===1&&pending[0].id===added.id&&groups[0].pendingCommit,added:serialize(pending[0]),group};
  },{kp,b});
  assert.equal(admission.blocked,true);assert.equal(admission.recovered,true);
  await bob.evaluate(async({added,pins,kp})=>{await client.acknowledgeSent(kp.id);window.group=await client.join(new Uint8Array(added.frames.find(frame=>frame.kind==='welcome').bytes),new TextEncoder().encode('durable-workspace'),pins);},{added:admission.added,pins,kp});
  await alice.evaluate(async added=>{await client.acknowledgeSent(added.id);await client.mergePending(group);},admission.added);
  const encrypted=await alice.evaluate(async()=>{const input=new TextEncoder().encode('Durably received canary');const pending=client.encrypt(group,input);input.fill(0);return serialize(await pending);});
  const received=await bob.evaluate(async({encrypted,pins})=>{
   const approved=structuredClone(pins);const delivering=client.receive(group,new Uint8Array(encrypted.frames[0].bytes),approved);approved[0].signature_key[0]^=1;const event=await delivering;await client.close();window.client=await reopen();
   const pending=await client.pending();let replay=false;try{await client.receive(group,new Uint8Array(encrypted.frames[0].bytes),pins);}catch(error){replay=error.code==='MLS_OPERATION_REJECTED';}
   const valid=pending.length===1&&pending[0].id===event.id&&new TextDecoder().decode(pending[0].bytes)==='Durably received canary';
   await client.acknowledge(event.id);await client.close();window.client=await reopen();return {valid,replay,empty:(await client.pending()).length===0};
  },{encrypted,pins});
  assert.deepEqual(received,{valid:true,replay:true,empty:true});
  await alice.evaluate(async id=>client.acknowledgeSent(id),encrypted.id);
  // A second actual tab loads the same sealed state/key but owns an independent
  // Wasm ratchet. Only one IndexedDB compare-and-swap can release its new wire.
  const second=await ownerContext.newPage();await second.goto(fixture.origin);
  await second.evaluate(async({scope,a,group})=>{
   window.mls=await import('/quill_mls.js');await mls.default();window.vault=await import('/mls-state-vault.mjs');
   const db=await new Promise((resolve,reject)=>{const request=indexedDB.open('quill-mls-fixture-unlock',1);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(Error('fixture storage failed'));});
   const key=await new Promise((resolve,reject)=>{const request=db.transaction('keys','readonly').objectStore('keys').get('key');request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(Error('fixture storage failed'));});db.close();
   window.store=await vault.openMlsStateStore({database:'quill-mls-durable-test'});
   window.client=await vault.reopenMlsState({module:mls,key,scope,identity:new Uint8Array(a.identity),signatureKey:new Uint8Array(a.signature_key),store});window.group=group;
  },{scope:base,a,group:admission.group});
  const race=await Promise.all([alice,second].map((page,index)=>page.evaluate(async index=>{
   try{const item=await client.encrypt(group,new TextEncoder().encode(index===0?'race-a':'race-b'));return {ok:true,id:item.id,wire:Array.from(item.frames[0].bytes)};}
   catch(error){let locked=false;try{await client.encrypt(group,new Uint8Array([1]));}catch(next){locked=next.code==='MLS_STATE_LOCKED';}return {ok:false,code:error.code,locked};}
  },index)));
  assert.equal(race.filter(x=>x.ok).length,1);const loser=race.find(x=>!x.ok),winner=race.find(x=>x.ok);assert.equal(loser.code,'MLS_STATE_CONFLICT');assert.equal(loser.locked,true);
  assert.equal(await bob.evaluate(async({wire,pins})=>{const event=await client.receive(group,new Uint8Array(wire),pins);return ['race-a','race-b'].includes(new TextDecoder().decode(event.bytes));},{wire:winner.wire,pins}),true);
  // Close the real database connection to force checkpoint persistence failure.
  // No failed frame is returned, and reopening resumes from the durable ratchet.
  const repair=await alice.evaluate(async winner=>{
   await client.close();window.client=await reopen();await client.acknowledgeSent(winner.id);store.close();
   let failed=false,locked=false;try{await client.encrypt(group,new TextEncoder().encode('must never leave failed transaction'));}catch(error){failed=error.code==='MLS_STATE_STORAGE'&&!Object.hasOwn(error,'frames');}
   try{await client.encrypt(group,new Uint8Array([1]));}catch(error){locked=error.code==='MLS_STATE_LOCKED';}
   window.store=await vault.openMlsStateStore({database:'quill-mls-durable-test'});window.client=await reopen();
   const recovered=await client.encrypt(group,new TextEncoder().encode('after storage failure'));
   return {failed,locked,item:serialize(recovered)};
  },winner);
  assert.equal(repair.failed,true);assert.equal(repair.locked,true);
  assert.equal(await bob.evaluate(async({item,pins})=>{const event=await client.receive(group,new Uint8Array(item.frames[0].bytes),pins);return new TextDecoder().decode(event.bytes)==='after storage failure';},{item:repair.item,pins}),true);
  const rollback=await alice.evaluate(async()=>{
   await client.close();
   const db=await new Promise((resolve,reject)=>{const request=indexedDB.open('quill-mls-durable-test',1);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(Error('fixture storage failed'));});
   const id=JSON.stringify(['quill-mls-state-v1',scope.tenantId,scope.accountId,scope.deviceId]);
   const latest=await new Promise((resolve,reject)=>{const request=db.transaction('checkpoints','readonly').objectStore('checkpoints').get(id);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(Error('fixture storage failed'));});
   const put=record=>new Promise((resolve,reject)=>{const tx=db.transaction('checkpoints','readwrite');tx.objectStore('checkpoints').put(record,id);tx.oncomplete=resolve;tx.onabort=()=>reject(Error('fixture storage failed'));});
   let rejected=0;
   await put({version:1,...initialRecord});try{await reopen();}catch(error){if(error.code==='MLS_STATE_ROLLBACK')rejected++;}
   await put({version:1,...initialRecord,generation:latest.generation});try{await reopen();}catch(error){if(error.code==='MLS_STATE_CORRUPT')rejected++;}
   await put(latest);db.close();return rejected;
  });
  assert.equal(rollback,2);
 }finally{await browser?.close();await fixture.close();}
});
