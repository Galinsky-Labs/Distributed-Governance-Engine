// End-to-end private workspace journey with the REAL compiled OpenMLS endpoint
// (dist/mls, built by `npm run build:mls`), the durable vault coordinator, the
// production HTTP routes and the TLS 1.3 private WebSocket relay. Skipped, with
// an explicit reason, when the Wasm module has not been built.
import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomBytes,randomUUID,webcrypto} from 'node:crypto';
import {createServer} from 'node:https';
import {PGlite} from '@electric-sql/pglite';
import {WebSocket} from 'ws';
import * as Y from 'yjs';
import {createIdentityStore,applyIdentityMigrations} from '../server/identity-store.mjs';
import {createPlatform} from '../server/platform.mjs';
import {nodeListener} from '../server/application.mjs';
import {createRequestBudget} from '../server/account-http.mjs';
import {routeUpgrades,attachPrivateWorkspaceHub} from '../server/private-workspace.mjs';
import {createPrivateWorkspaceClient,createPrivateApi,memoryLocalStore} from '../web/private-workspace-client.mjs';
import {openPrivateYjsUpdate} from '../src/private-collaboration-crypto.mjs';

const wasm=new URL('../dist/mls/quill_mls_bg.wasm',import.meta.url);
const skip=existsSync(wasm)?false:'dist/mls is not built (run `npm run build:mls` with the pinned Rust 1.94.0 / wasm-bindgen 0.2.130 toolchain)';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label,timeout=15000){
 const end=Date.now()+timeout;
 for(;;){const v=await fn();if(v)return v;if(Date.now()>end)throw Error('Timed out: '+label);await sleep(50);}
}
function memoryVault(){
 const records=new Map();const slot=s=>s.tenantId+s.accountId+s.deviceId;
 return {async load(scope){return records.get(slot(scope))??null;},
  async save(scope,_pin,cp,expected){const prior=records.get(slot(scope));if((prior?.generation??0)!==expected)throw Error('MLS_STATE_CONFLICT');
   records.set(slot(scope),{generation:cp.generation,nonce:cp.nonce.slice(),ciphertext:cp.ciphertext.slice()});return {generation:cp.generation};},
  records};
}
function textOf(ydoc){return ydoc.getXmlFragment('prosemirror').toString();}
function insertText(ydoc,text){
 const fragment=ydoc.getXmlFragment('prosemirror');
 const find=node=>{for(const child of node.toArray()){if(child instanceof Y.XmlText)return child;if(child instanceof Y.XmlElement){const f=find(child);if(f)return f;}}return null;};
 const found=find(fragment);
 if(found){found.insert(found.length,text);return;}
 const paragraph=fragment.toArray().find(c=>c instanceof Y.XmlElement&&c.nodeName==='paragraph');
 paragraph.insert(0,[new Y.XmlText(text)]);
}

test('two accounts enroll, pin, share, converge; removal locks the removed device out of new epochs',{skip,timeout:120000},async()=>{
 const canary='CANARY-'+randomUUID(),canary2='LATER-CANARY-'+randomUUID(),canary3='MEMBER-CANARY-'+randomUUID();
 const logs=[];const original={log:console.log,error:console.error,warn:console.warn,info:console.info};
 for(const name of Object.keys(original))console[name]=(...args)=>{logs.push(args.map(String).join(' '));};
 const tmp=mkdtempSync(join(tmpdir(),'dge-private-mls-'));
 const db=await PGlite.create();
 const relay=[];let server,hub,upgrades;const clients=[],sessions=[];
 try{
  await applyIdentityMigrations(fn=>db.transaction(fn));
  assert.equal(spawnSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(tmp,'key.pem'),'-out',join(tmp,'cert.pem'),'-subj','/CN=localhost','-addext','subjectAltName=IP:127.0.0.1','-days','1'],{stdio:'ignore'}).status,0);
  let listener;
  server=createServer({key:readFileSync(join(tmp,'key.pem')),cert:readFileSync(join(tmp,'cert.pem')),minVersion:'TLSv1.3'},(q,r)=>listener(q,r));
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const origin='https://127.0.0.1:'+server.address().port;
  const transaction=fn=>db.transaction(async tx=>{await tx.exec('SET LOCAL ROLE dge_identity_runtime');return fn(tx);});
  const identity=createIdentityStore({transaction,origin,sessionKey:randomBytes(32),stateKey:randomBytes(32),
   passkeyAttestationPolicy:{id:'test-v1',allowedFormats:['none'],allowedAaguids:['00000000-0000-0000-0000-000000000000']},
   verifyPasskeyRegistration:async({response})=>({verified:true,credential:{id:response.credentialId,publicKey:randomBytes(32).toString('base64url'),counter:0,transports:['internal'],backedUp:false,attestationFormat:'none',aaguid:'00000000-0000-0000-0000-000000000000'}}),
   verifyPasskeyAuthentication:async({response})=>({verified:true,userVerified:true,credentialId:response.credentialId,newCounter:response.newCounter})});
  const platform=createPlatform({identity,transaction,login:{},origin,privateWorkspaces:true,budget:createRequestBudget({perPeer:10000,globalLimit:1000000})});
  listener=nodeListener({application:platform.application,origin,bodyLimit:platform.bodyLimit});
  upgrades=routeUpgrades(server);
  hub=attachPrivateWorkspaceHub({server:upgrades.privateServer,origin,services:platform.services.privateWorkspace});
  const mls=await import('../dist/mls/quill_mls.js');mls.initSync({module:await readFile(wasm)});

  const login=async subject=>({...await identity.establishSession({issuer:'https://idp.example',subject,authenticatedAt:Date.now(),authenticationMethods:['pwd','mfa']}),origin});
  const owner=await login('owner'),member=await login('member');
  const {tenantId}=await identity.createTenant(owner);
  const invite=await identity.invite(owner,tenantId,member.accountId,'editor');
  await identity.acceptInvitation(member,tenantId,invite.invitationToken);
  function participant(who){
   const cookie='__Host-dge_session='+who.sessionToken+'; __Host-dge_csrf='+who.csrfToken;
   const fetcher=async(path,init)=>platform.application(new Request(origin+path,{...init,headers:{...init.headers,cookie,origin}}),{peerAddress:'127.0.0.1'});
   class RecordingSocket extends WebSocket{
    constructor(url,protocol){super(url,protocol,{headers:{cookie,origin},rejectUnauthorized:false});this.addEventListener('message',e=>relay.push(String(e.data)));}
    send(data){relay.push(String(data));super.send(data);}
   }
   const local=memoryLocalStore(),vault=memoryVault();
   const client=createPrivateWorkspaceClient({api:createPrivateApi({fetcher,cookie:()=>cookie}),mls,stateStore:vault,local,tenantId,accountId:who.accountId,origin,WebSocketCtor:RecordingSocket,webCrypto:webcrypto,pollMs:150});
   const stepUp=async()=>{
    const credentialId=randomBytes(16).toString('base64url');
    const e=await identity.beginPasskeyEnrollment(who);await identity.finishPasskeyEnrollment(who,e.challenge,{credentialId});
    const a=await identity.beginPasskeyAuthentication(who);await identity.finishPasskeyAuthentication(who,a.challenge,{credentialId,newCounter:1});
   };
   clients.push(client);
   return {client,local,vault,stepUp,who};
  }
  const A=participant(owner),B=participant(member);
  // Enrollment requires a real passkey step-up; without it the service refuses.
  await assert.rejects(A.client.enroll({stepUp:async()=>{}}),e=>e.code==='PASSKEY_STEP_UP_REQUIRED');
  const A2=participant(owner);
  const aDevice=await A2.client.enroll({stepUp:A2.stepUp});
  const bDevice=await B.client.enroll({stepUp:B.stepUp});
  assert.match(aDevice.safetyNumber,/^(\d{5} ){11}\d{5}$/);
  const alice=A2;

  const {documentId}=await alice.client.createDocument('Board minutes '+canary);
  const errors=[];const aSession=await alice.client.openDocument(documentId,{onError:e=>errors.push('A:'+(e.code??e.message))});sessions.push(aSession);
  assert.match(aSession.base.metadata.title,new RegExp(canary));
  insertText(aSession.ydoc,'Confidential resolution '+canary);
  await aSession.flush();

  // Adding a member whose device was never compared out of band is refused.
  await assert.rejects(aSession.addMember(member.accountId),e=>e.code==='KEY_APPROVAL_REQUIRED'&&e.details[0].status==='new');
  const seenByAlice=(await alice.client.directory()).find(d=>d.deviceId===bDevice.deviceId);
  assert.equal(seenByAlice.safetyNumber,bDevice.safetyNumber,'safety numbers agree out of band');
  await alice.client.approveDevice(seenByAlice);
  await aSession.addMember(member.accountId);
  assert.equal(aSession.epoch,1);assert.equal(aSession.keyEpoch,1);

  // Bob must likewise approve Alice's device before accepting the Welcome.
  await assert.rejects(B.client.openDocument(documentId),e=>e.code==='KEY_APPROVAL_REQUIRED');
  const seenByBob=(await B.client.directory()).find(d=>d.deviceId===aDevice.deviceId);
  assert.equal(seenByBob.safetyNumber,aDevice.safetyNumber);
  await B.client.approveDevice(seenByBob);
  const bSession=await B.client.openDocument(documentId,{onError:e=>errors.push('B:'+(e.code??e.message))});sessions.push(bSession);
  assert.ok(textOf(bSession.ydoc).includes(canary),'member decrypts the rekeyed snapshot');

  // Both edit concurrently over the WSS relay and converge.
  insertText(bSession.ydoc,' bob-'+canary3);insertText(aSession.ydoc,' alice-edit');
  await until(()=>textOf(aSession.ydoc).includes('bob-'+canary3)&&textOf(bSession.ydoc).includes('alice-edit'),'convergence '+errors.join(','));
  assert.equal(textOf(aSession.ydoc),textOf(bSession.ydoc));
  assert.ok(relay.some(m=>m.includes('"kind":"update"')),'edits travelled through the private relay');

  // Key-change warning: a second key for Bob (new device) and a substituted key.
  const B2=participant(member);await B2.client.enroll({stepUp:B2.stepUp});
  const statuses=Object.fromEntries((await alice.client.directory()).map(d=>[d.deviceId,d.status]));
  assert.equal(statuses[bDevice.deviceId],'approved');assert.equal(statuses[B2.client.device.deviceId],'added');
  const originalKey=(await db.query('SELECT signature_key FROM dge_private.device_keys WHERE device_id=$1',[bDevice.deviceId])).rows[0].signature_key;
  await db.query('UPDATE dge_private.device_keys SET signature_key=$1 WHERE device_id=$2',[randomBytes(32),bDevice.deviceId]);
  const substituted=(await alice.client.directory()).find(d=>d.deviceId===bDevice.deviceId);
  assert.equal(substituted.status,'changed');assert.notEqual(substituted.safetyNumber,bDevice.safetyNumber);
  await db.query('UPDATE dge_private.device_keys SET signature_key=$1 WHERE device_id=$2',[originalKey,bDevice.deviceId]);

  // Removal: an admin device commits the removal and re-encrypts for the new epoch.
  const bobEpochOneKey=await B.local.get('key:'+tenantId+':'+member.accountId+':'+documentId+':1:update');
  assert.ok(bobEpochOneKey);
  await aSession.removeMember(member.accountId);
  assert.equal(aSession.epoch,2);assert.equal(aSession.keyEpoch,2);
  await until(()=>bSession.removed,'removed device processes its eviction');
  insertText(aSession.ydoc,' '+canary2);await aSession.flush();
  await until(async()=>(await db.query('SELECT count(*)::int AS n FROM dge_private.update_frames WHERE epoch=2')).rows[0].n>0,'new epoch frame stored');
  const frame=(await db.query('SELECT * FROM dge_private.update_frames WHERE epoch=2 ORDER BY position DESC LIMIT 1')).rows[0];
  const envelope={version:1,cipher:'AES-256-GCM',epoch:2,senderDeviceId:frame.sender_device_id,sequence:Number(frame.sender_sequence),
   nonce:Buffer.from(frame.nonce).toString('base64url'),ciphertext:Buffer.from(frame.ciphertext).toString('base64url')};
  // The removed device never derives an epoch-2 key and its old key fails authentication.
  assert.equal(await B.local.get('key:'+tenantId+':'+member.accountId+':'+documentId+':2:update'),undefined);
  for(const epoch of [1,2])
   await assert.rejects(openPrivateYjsUpdate({key:bobEpochOneKey,context:{tenantId,workspaceId:tenantId,documentId,senderDeviceId:envelope.senderDeviceId,epoch},envelope:{...envelope,epoch},webCrypto:webcrypto}));
  assert.equal(textOf(bSession.ydoc).includes(canary2),false);
  assert.deepEqual(errors.filter(e=>!e.startsWith('B:')),[]);
  // ...and the service refuses it ciphertext and snapshots after removal.
  await assert.rejects(B.client.openDocument(documentId),e=>['PRIVATE_ACCESS_REMOVED','PRIVATE_DEVICE_NOT_AUTHORIZED'].includes(e.code));

  // Canary strings never reach the database, logs or relay frames.
  const tables=(await db.query("SELECT table_schema||'.'||table_name AS t FROM information_schema.tables WHERE table_schema LIKE 'dge_%' AND table_type='BASE TABLE'")).rows;
  const needles=[canary,canary2,canary3].flatMap(c=>[c,Buffer.from(c).toString('hex'),Buffer.from(c).toString('base64'),Buffer.from(c).toString('base64url')]);
  for(const {t} of tables){
   const text=JSON.stringify((await db.query('SELECT * FROM '+t)).rows,(k,v)=>v instanceof Uint8Array?Buffer.from(v).toString('latin1')+Buffer.from(v).toString('hex'):v);
   for(const needle of needles)assert.equal(text.includes(needle),false,'canary in '+t);
  }
  for(const needle of needles){
   assert.equal(relay.some(m=>m.includes(needle)),false,'canary in relay frame');
   assert.equal(logs.some(m=>m.includes(needle)),false,'canary in logs');
  }
  assert.ok(relay.length>0&&tables.length>10);
 }finally{
  for(const name of Object.keys(original))console[name]=original[name];
  for(const s of sessions)s.close();
  for(const c of clients)await c.close().catch(()=>{});
  hub?.close();upgrades?.close();
  await new Promise(r=>{if(!server)return r();server.close(r);server.closeAllConnections();});
  await db.close();rmSync(tmp,{recursive:true,force:true});
 }
});
