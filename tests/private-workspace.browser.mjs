// Real-browser private workspace journey: two isolated browser profiles with
// virtual passkeys, the compiled OpenMLS Wasm endpoint, IndexedDB vault state,
// the production routes/relay from createPlatform and the private page UI.
import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import puppeteer from 'puppeteer-core';
import {accountFixture} from './support/account-fixture.mjs';
import {createPasskeyVerifiers} from '../server/passkey-verifier.mjs';

const binary=process.env.DGE_BROWSER_EXECUTABLE;
if(!binary)throw Error('DGE_BROWSER_EXECUTABLE is required');
const built=['dist/mls/quill_mls_bg.wasm','dist/mls/quill_mls.js','dist/private.js','dist/private.html','dist/app.css'].every(f=>existsSync(new URL('../'+f,import.meta.url)));
const skip=built?false:'Build first: npm run build && npm run build:mls && node scripts/build-private-workspace.mjs';
// Chromium's virtual CTAP2 model; never a production hardware policy.
const policy={id:'virtual-authenticator-test-only',allowedFormats:['none'],allowedAaguids:['01020304-0506-0708-0102-030405060708']};

async function click(page,text){
 await page.waitForFunction(text=>[...document.querySelectorAll('button')].some(x=>x.textContent===text&&!x.disabled),{},text);
 const element=await page.evaluateHandle(text=>[...document.querySelectorAll('button')].find(x=>x.textContent===text&&!x.disabled),text);
 await element.asElement().click();await element.dispose();
}
const status=(page,text)=>page.waitForFunction(text=>[...document.querySelectorAll('[role="status"]')].some(x=>x.textContent.includes(text)),{timeout:20000},text);
async function person(browser,origin,subject){
 const context=await browser.createBrowserContext(),page=await context.newPage();page.setDefaultTimeout(20000);
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const cdp=await page.createCDPSession();await cdp.send('WebAuthn.enable');
 await cdp.send('WebAuthn.addVirtualAuthenticator',{options:{protocol:'ctap2',transport:'internal',hasResidentKey:true,hasUserVerification:true,isUserVerified:true,automaticPresenceSimulation:true}});
 await page.goto(origin+'/account');await page.click('a.button-link[href="/auth/start"]');
 await page.waitForSelector('input[name="subject"]');await page.type('input[name="subject"]',subject);await click(page,'Continue fixture login');
 await page.waitForSelector('.account-id');
 const accountId=await page.$eval('.account-id',x=>x.textContent);
 await click(page,'Add a passkey');await status(page,'Passkey added.');
 return {page,accountId,errors};
}
const api=(page,path,body)=>page.evaluate(async(path,body)=>{
 const csrf=document.cookie.split(';').map(s=>s.trim()).find(s=>s.startsWith('__Host-dge_csrf=')).slice(16);
 const response=await fetch(path,{method:body?'POST':'GET',headers:{'content-type':'application/json','x-dge-csrf':csrf},body:body?JSON.stringify(body):undefined});
 return {status:response.status,body:await response.json()};
},path,body);
const editorText=page=>page.$eval('.private-editor .ProseMirror',x=>x.textContent);

test('two accounts share a private document, converge, and a removed member cannot decrypt new edits',{skip,timeout:180000},async()=>{
 const fixture=await accountFixture({hostname:'localhost',perPeerBudget:5000,passkeyConfiguration:{...createPasskeyVerifiers(),passkeyAttestationPolicy:policy}});
 let browser;
 const canary='BOARD-CANARY-'+Math.random().toString(36).slice(2),later='AFTER-REMOVAL-'+Math.random().toString(36).slice(2);
 try{
  browser=await puppeteer.launch({executablePath:binary,headless:true,acceptInsecureCerts:true,args:['--no-sandbox','--disable-dev-shm-usage']});
  const alice=await person(browser,fixture.origin,'alice'),bob=await person(browser,fixture.origin,'bob');
  await click(alice.page,'Create workspace');
  await alice.page.waitForFunction(()=>document.querySelector('[aria-label="Your workspace"]')?.value);
  const tenantId=await alice.page.$eval('[aria-label="Your workspace"]',x=>x.value);
  const invite=await api(alice.page,'/api/workspaces/'+tenantId+'/invitations',{accountId:bob.accountId,role:'editor'});
  assert.equal(invite.status,201);
  assert.equal((await api(bob.page,'/api/workspaces/'+tenantId+'/join',{invitationToken:invite.body.invitationToken})).status,200);

  // Device enrollment: fresh passkey assertion, then the safety number is shown.
  for(const who of [alice,bob]){
   await who.page.goto(fixture.origin+'/private');
   await click(who.page,'Enroll this device');
   await who.page.waitForSelector('.own-safety-number');
   who.safety=await who.page.$eval('.own-safety-number',x=>x.textContent);
   assert.match(who.safety,/^(\d{5} ){11}\d{5}$/);
  }
  assert.notEqual(alice.safety,bob.safety);

  // Alice creates a private document and writes into the encrypted editor.
  await alice.page.type('.private-create input','Minutes '+canary);
  await click(alice.page,'Create private document');
  await alice.page.waitForSelector('.private-editor .ProseMirror[contenteditable="true"]');
  await alice.page.click('.private-editor .ProseMirror');await alice.page.keyboard.type('Resolution text '+canary);
  await status(alice.page,'Encrypted edit saved.');

  // Adding Bob is refused until Alice compares and approves Bob's safety number.
  await alice.page.select('.private-membership select',bob.accountId);
  await click(alice.page,'Add to document');
  await alice.page.waitForSelector('[aria-label="Device key approvals required"]');
  const shown=await alice.page.$eval('[aria-label="Device key approvals required"] .safety-number',x=>x.textContent);
  assert.equal(shown,bob.safety,'Alice sees exactly the safety number Bob reads out');
  await click(alice.page,'Approve device');
  await click(alice.page,'Add to document');
  await status(alice.page,'Member added.');

  // Bob opens it: he must approve Alice's device before accepting the Welcome.
  await bob.page.reload();await bob.page.waitForSelector('.own-safety-number');
  await bob.page.waitForSelector('.private-document-list button');
  await bob.page.click('.private-document-list button');
  await bob.page.waitForSelector('[aria-label="Device key approvals required"]');
  assert.equal(await bob.page.$eval('[aria-label="Device key approvals required"] .safety-number',x=>x.textContent),alice.safety);
  await click(bob.page,'Approve device');
  await bob.page.waitForFunction(()=>!document.querySelector('[aria-label="Device key approvals required"]'));
  await bob.page.click('.private-document-list button');
  await bob.page.waitForFunction(c=>document.querySelector('.private-editor .ProseMirror')?.textContent.includes(c),{},canary);
  assert.match(await bob.page.$eval('.private-title',x=>x.textContent),new RegExp(canary));

  // Both edit; the documents converge through the encrypted relay.
  await bob.page.click('.private-editor .ProseMirror');await bob.page.keyboard.press('End');await bob.page.keyboard.type(' bob-was-here');
  await alice.page.click('.private-editor .ProseMirror');await alice.page.keyboard.press('End');await alice.page.keyboard.type(' alice-agrees');
  for(const who of [alice,bob])
   await who.page.waitForFunction(()=>{const t=document.querySelector('.private-editor .ProseMirror')?.textContent??'';return t.includes('bob-was-here')&&t.includes('alice-agrees');},{timeout:30000});
  await alice.page.waitForFunction(async()=>true);
  await new Promise(r=>setTimeout(r,500));
  assert.equal(await editorText(alice.page),await editorText(bob.page));

  // Alice removes Bob: removal commit + re-encryption for the new epoch.
  await click(alice.page,'Remove from document');
  await status(alice.page,'Member removed.');
  await bob.page.waitForFunction(()=>[...document.querySelectorAll('[role="alert"]')].some(x=>x.textContent.includes('removed from the document')),{timeout:30000});
  await alice.page.click('.private-editor .ProseMirror');await alice.page.keyboard.press('End');await alice.page.keyboard.type(' '+later);
  await status(alice.page,'Encrypted edit saved.');
  await new Promise(r=>setTimeout(r,3000));
  assert.equal((await editorText(bob.page)).includes(later),false);

  // Bob's browser holds no key for the new epoch, and its old keys fail on the new frame.
  const documentId=(await fixture.db.query('SELECT document_id FROM dge_private.groups')).rows[0].document_id;
  const groupEpoch=(await fixture.db.query('SELECT epoch FROM dge_private.groups')).rows[0].epoch;
  const frame=(await fixture.db.query('SELECT * FROM dge_private.update_frames WHERE epoch=$1 ORDER BY position DESC LIMIT 1',[groupEpoch])).rows[0];
  assert.ok(frame,'new-epoch ciphertext exists');
  const attempt=await bob.page.evaluate(async({documentId,tenantId,epoch,sender,sequence,nonce,ciphertext})=>{
   const db=await new Promise((res,rej)=>{const r=indexedDB.open('quill-private-workspace-v1');r.onsuccess=()=>res(r.result);r.onerror=rej;});
   const all=await new Promise(res=>{const out=[];const c=db.transaction('kv').objectStore('kv').openCursor();c.onsuccess=()=>{const x=c.result;if(!x)return res(out);out.push([x.key,x.value]);x.continue();};});
   const keys=all.filter(([k])=>String(k).startsWith('key:')&&String(k).includes(documentId));
   const results=[];
   for(const [name,key] of keys){
    for(const e of [epoch,Number(name.split(':')[4])]){
     const aad=new TextEncoder().encode(JSON.stringify(['dge-private-yjs-update-v1','AES-256-GCM',tenantId,tenantId,documentId,e,sender,sequence]));
     try{await crypto.subtle.decrypt({name:'AES-GCM',iv:new Uint8Array(nonce),additionalData:aad,tagLength:128},key,new Uint8Array(ciphertext));results.push('DECRYPTED');}catch{results.push('refused');}
    }
   }
   return {epochs:keys.map(([k])=>Number(String(k).split(':')[4])),results};
  },{documentId,tenantId,epoch:groupEpoch,sender:frame.sender_device_id,sequence:Number(frame.sender_sequence),nonce:[...frame.nonce],ciphertext:[...frame.ciphertext]});
  assert.ok(attempt.epochs.length>0);
  assert.equal(attempt.epochs.includes(groupEpoch),false,'removed browser never derived the new epoch key');
  assert.ok(attempt.results.every(r=>r==='refused'));
  const denied=await api(bob.page,'/api/workspaces/'+tenantId+'/private-documents/'+documentId+'/updates?recipientDeviceId='+frame.sender_device_id);
  assert.equal(denied.status,403);

  // No plaintext title or content reached the service's database.
  for(const t of ['dge_private.versions','dge_private.update_frames','dge_private.group_messages','dge_private.key_packages','dge_private.device_keys']){
   const text=JSON.stringify((await fixture.db.query('SELECT * FROM '+t)).rows,(k,v)=>v instanceof Uint8Array?Buffer.from(v).toString('latin1'):v);
   for(const needle of [canary,later,'bob-was-here','alice-agrees'])assert.equal(text.includes(needle),false,t);
  }
  assert.deepEqual([...alice.errors,...bob.errors],[]);
 }finally{await browser?.close();await fixture.close();}
});
