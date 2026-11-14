// Private workspace service: device directory, single-use key packages, ordered
// handshake mailbox, roster-bound access and tenant isolation. MLS bytes here
// are opaque random stand-ins; the wasm-backed journey is in
// private-workspace-mls.test.mjs.
import {test,before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID,createHash,webcrypto} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {createIdentityStore,applyIdentityMigrations,AccessError} from '../server/identity-store.mjs';
import {createPrivateWorkspaceServices,privateWorkspacesFlag,routeUpgrades} from '../server/private-workspace.mjs';
import {createPlatform} from '../server/platform.mjs';
import {deviceIdentity,deviceKeyThumbprintHex,privateGroupId,deviceSafetyNumber,deviceKeyThumbprint} from '../src/private-workspace-protocol.mjs';
import {sealPrivateYjsUpdate} from '../src/private-collaboration-crypto.mjs';
import {encryptLocalDraftBytes} from '../src/private-crypto.mjs';

let db,store,services,time;
const origin='https://quill.example',sessionKey=randomBytes(32),stateKey=randomBytes(32);
const transaction=fn=>db.transaction(async tx=>{await tx.exec('SET LOCAL ROLE dge_identity_runtime');return fn(tx);});
const policy=Object.freeze({id:'test-v1',allowedFormats:['none'],allowedAaguids:['00000000-0000-0000-0000-000000000000']});
const options=()=>({transaction,sessionKey,stateKey,origin,clock:()=>time,passkeyAttestationPolicy:policy,
 verifyPasskeyRegistration:async({response})=>({verified:true,credential:{id:response.credentialId,publicKey:randomBytes(32).toString('base64url'),counter:0,transports:['internal'],backedUp:false,attestationFormat:'none',aaguid:'00000000-0000-0000-0000-000000000000'}}),
 verifyPasskeyAuthentication:async({response})=>({verified:true,userVerified:true,credentialId:response.credentialId,newCounter:response.newCounter})});
const b64=b=>Buffer.from(b).toString('base64url');
const code=c=>e=>e?.code===c||e?.message===c;
before(async()=>{db=await PGlite.create();await applyIdentityMigrations(fn=>db.transaction(fn));});
after(async()=>{await db?.close();});
beforeEach(async()=>{
 await db.exec('TRUNCATE dge_identity.accounts,dge_identity.tenants,dge_identity.login_challenges CASCADE');
 time=Date.now();store=createIdentityStore(options());
 services=createPrivateWorkspaceServices({identity:store,clock:()=>time,limits:{workspace:{maxActivePackages:4,maxMessagesPerGroup:12,keyPackageTtlMs:3600000}}});
});
const account=async subject=>({...await store.establishSession({issuer:'https://idp.example',subject,authenticatedAt:time,authenticationMethods:['pwd','mfa']}),origin});
async function stepUp(who){
 const credentialId=randomBytes(16).toString('base64url');
 const e=await store.beginPasskeyEnrollment(who);await store.finishPasskeyEnrollment(who,e.challenge,{credentialId});
 const a=await store.beginPasskeyAuthentication(who);await store.finishPasskeyAuthentication(who,a.challenge,{credentialId,newCounter:1});
}
/** Full enrollment: passkey step-up -> authorized_devices -> published MLS key. */
async function enroll(who,tenantId){
 const signatureKey=randomBytes(32),identity=deviceIdentity(who.accountId,randomUUID());
 await stepUp(who);
 await store.authorizeDevice(who,deviceKeyThumbprintHex(signatureKey,createHash));
 const deviceId=(await store.devices(who)).items.find(d=>d.keyThumbprint===deviceKeyThumbprintHex(signatureKey,createHash)).id;
 await services.workspace.publishDevice(who,tenantId,{deviceId,identity:b64(identity),signatureKey:b64(signatureKey)});
 return {deviceId,identity,signatureKey};
}
async function workspace(){
 const owner=await account('owner'),member=await account('member');
 const {tenantId}=await store.createTenant(owner);
 const {invitationToken}=await store.invite(owner,tenantId,member.accountId,'editor');
 await store.acceptInvitation(member,tenantId,invitationToken);
 return {owner,member,tenantId};
}
const commit=(deviceId,epoch,change)=>({deviceId,epoch,commit:b64(randomBytes(64)),welcome:change.add?b64(randomBytes(96)):null,
 add:change.add??null,remove:change.remove??null,commandId:randomUUID()});
const envelope=epoch=>({version:1,cipher:'AES-256-GCM',keyEpoch:epoch,nonce:b64(randomBytes(12)),ciphertext:b64(randomBytes(64))});
const frame=(epoch,senderDeviceId,sequence)=>({version:1,cipher:'AES-256-GCM',epoch,senderDeviceId,sequence,nonce:b64(randomBytes(12)),ciphertext:b64(randomBytes(40))});
async function privateDocument(owner,tenantId,device){
 const documentId=randomUUID();
 await services.workspace.createGroup(owner,tenantId,{documentId,groupId:b64(privateGroupId(tenantId,documentId,createHash)),deviceId:device.deviceId});
 await services.documents.create(owner,tenantId,{documentId,commandId:randomUUID(),envelope:envelope(0)},{deviceId:device.deviceId});
 return documentId;
}

test('PRIVATE_WORKSPACES flag fails closed on unknown values',()=>{
 assert.equal(privateWorkspacesFlag(undefined),false);assert.equal(privateWorkspacesFlag('disabled'),false);
 assert.equal(privateWorkspacesFlag('enabled'),true);assert.throws(()=>privateWorkspacesFlag('yes'));
});

test('device enrollment needs a fresh passkey step-up and binds exactly one immutable key',async()=>{
 const {owner,member,tenantId}=await workspace();
 const signatureKey=randomBytes(32),thumbprint=deviceKeyThumbprintHex(signatureKey,createHash);
 assert.equal(thumbprint,await deviceKeyThumbprint(new Uint8Array(signatureKey),webcrypto.subtle));
 await assert.rejects(store.authorizeDevice(owner,thumbprint),code('PASSKEY_STEP_UP_REQUIRED'));
 await stepUp(owner);await store.authorizeDevice(owner,thumbprint);
 const deviceId=(await store.devices(owner)).items[0].id;
 const identity=deviceIdentity(owner.accountId,randomUUID());
 await assert.rejects(services.workspace.publishDevice(owner,tenantId,{deviceId,identity:b64(identity),signatureKey:b64(randomBytes(32))}),code('DEVICE_KEY_MISMATCH'));
 await assert.rejects(services.workspace.publishDevice(owner,tenantId,{deviceId,identity:b64(deviceIdentity(member.accountId,randomUUID())),signatureKey:b64(signatureKey)}),code('INVALID_DEVICE_IDENTITY'));
 await assert.rejects(services.workspace.publishDevice(member,tenantId,{deviceId,identity:b64(deviceIdentity(member.accountId,randomUUID())),signatureKey:b64(signatureKey)}),code('PRIVATE_DEVICE_NOT_AUTHORIZED'));
 // A key cannot be bound long after the step-up that authorized the device.
 time+=11*60000;
 await assert.rejects(services.workspace.publishDevice(owner,tenantId,{deviceId,identity:b64(identity),signatureKey:b64(signatureKey)}),code('PASSKEY_STEP_UP_REQUIRED'));
 time-=11*60000;
 assert.deepEqual(await services.workspace.publishDevice(owner,tenantId,{deviceId,identity:b64(identity),signatureKey:b64(signatureKey)}),{deviceId,published:true});
 assert.deepEqual(await services.workspace.publishDevice(owner,tenantId,{deviceId,identity:b64(identity),signatureKey:b64(signatureKey)}),{deviceId,published:false});
 await assert.rejects(services.workspace.publishDevice(owner,tenantId,{deviceId,identity:b64(deviceIdentity(owner.accountId,randomUUID())),signatureKey:b64(signatureKey)}),code('DEVICE_KEY_IMMUTABLE'));
 await assert.rejects(transaction(tx=>tx.query('UPDATE dge_private.device_keys SET signature_key=$1',[randomBytes(32)])),/permission denied/);
 const listed=(await services.workspace.directory(member,tenantId)).items;
 assert.equal(listed.length,1);assert.equal(listed[0].signatureKey,b64(signatureKey));
 const safety=await deviceSafetyNumber(identity,new Uint8Array(signatureKey),webcrypto.subtle);
 assert.match(safety,/^(\d{5} ){11}\d{5}$/);
 assert.notEqual(safety,await deviceSafetyNumber(identity,new Uint8Array(randomBytes(32)),webcrypto.subtle));
});

test('login recovery never authorizes or publishes a device',async()=>{
 const {owner,tenantId}=await workspace();
 const {recoveryCodes}=await store.issueRecoveryCodes(owner);
 const recovered={...await store.recoverAccount(owner.accountId,recoveryCodes[0]),origin};
 await assert.rejects(store.authorizeDevice(recovered,'a'.repeat(64)),e=>e instanceof AccessError);
 await assert.rejects(services.workspace.publishDevice(recovered,tenantId,{deviceId:randomUUID(),identity:b64(deviceIdentity(owner.accountId,randomUUID())),signatureKey:b64(randomBytes(32))}),e=>e instanceof AccessError);
 assert.equal((await db.query('SELECT count(*)::int AS n FROM dge_identity.authorized_devices')).rows[0].n,0);
});

test('key packages are bounded, expire, and are consumed exactly once',async()=>{
 const {owner,member,tenantId}=await workspace();
 const device=await enroll(member,tenantId);
 const packages=[randomBytes(200),randomBytes(201),randomBytes(202)].map(b64);
 await assert.rejects(services.workspace.publishKeyPackages(owner,tenantId,device.deviceId,{packages}),code('PRIVATE_DEVICE_NOT_AUTHORIZED'));
 assert.equal((await services.workspace.publishKeyPackages(member,tenantId,device.deviceId,{packages})).available,3);
 await assert.rejects(services.workspace.publishKeyPackages(member,tenantId,device.deviceId,{packages:[b64(randomBytes(9)),b64(randomBytes(9))]}),code('KEY_PACKAGE_LIMIT_REACHED'));
 await assert.rejects(services.workspace.publishKeyPackages(member,tenantId,device.deviceId,{packages:[packages[0]]}),code('KEY_PACKAGE_REUSED'));
 const claims=await Promise.all([1,2,3].map(()=>services.workspace.claimKeyPackage(owner,tenantId,device.deviceId,{})));
 assert.deepEqual(claims.map(c=>c.keyPackage).sort(),[...packages].sort());
 assert.equal(new Set(claims.map(c=>c.keyPackageId)).size,3);
 await assert.rejects(services.workspace.claimKeyPackage(owner,tenantId,device.deviceId,{}),code('KEY_PACKAGE_UNAVAILABLE'));
 await assert.rejects(db.query('UPDATE dge_private.key_packages SET consumed_at=NULL,consumed_tenant_id=NULL,consumed_by=NULL'),/single-use/);
 await services.workspace.publishKeyPackages(member,tenantId,device.deviceId,{packages:[b64(randomBytes(50))]});
 time+=2*3600000;
 await assert.rejects(services.workspace.claimKeyPackage(owner,tenantId,device.deviceId,{}),code('KEY_PACKAGE_UNAVAILABLE'));
 assert.equal((await services.workspace.directory(owner,tenantId)).items[0].availableKeyPackages,0);
});

test('mailbox is ordered per epoch, replay-safe, bounded and recipient scoped',async()=>{
 const {owner,member,tenantId}=await workspace();
 const a=await enroll(owner,tenantId),b=await enroll(member,tenantId);
 const documentId=await privateDocument(owner,tenantId,a);
 const add=commit(a.deviceId,0,{add:b.deviceId});
 const first=await services.workspace.postCommit(owner,tenantId,documentId,add);
 assert.deepEqual(first,{position:1,epoch:1,roster:[a.deviceId,b.deviceId].sort(),replayed:false});
 assert.equal((await services.workspace.postCommit(owner,tenantId,documentId,add)).replayed,true);
 await assert.rejects(services.workspace.postCommit(owner,tenantId,documentId,{...add,commit:b64(randomBytes(64))}),code('COMMAND_REUSED'));
 // A competing commit built on the superseded epoch is refused: one order only.
 await assert.rejects(services.workspace.postCommit(owner,tenantId,documentId,commit(a.deviceId,0,{remove:b.deviceId})),code('PRIVATE_EPOCH_CONFLICT'));
 await assert.rejects(services.workspace.postCommit(owner,tenantId,documentId,commit(a.deviceId,1,{add:b.deviceId})),code('PRIVATE_DEVICE_ALREADY_MEMBER'));
 // A non-admin, non-creator member device cannot change membership.
 await assert.rejects(services.workspace.postCommit(member,tenantId,documentId,commit(b.deviceId,1,{remove:a.deviceId})),code('PRIVATE_MEMBERSHIP_ADMIN_REQUIRED'));
 const own=await services.workspace.messages(owner,tenantId,documentId,{deviceId:a.deviceId});
 assert.deepEqual(own.items.map(m=>[m.position,m.kind,m.epoch]),[[1,'commit',0]]);
 const theirs=await services.workspace.messages(member,tenantId,documentId,{deviceId:b.deviceId});
 // b was admitted at epoch 1: it gets its Welcome, not the commit that admitted it.
 assert.deepEqual(theirs.items.map(m=>[m.position,m.kind,m.epoch,m.recipientDeviceId]),[[2,'welcome',1,b.deviceId]]);
 assert.equal(theirs.items[0].payload,add.welcome);
 await assert.rejects(services.workspace.messages(owner,tenantId,documentId,{deviceId:b.deviceId}),code('PRIVATE_DEVICE_NOT_AUTHORIZED'));
 await db.query('UPDATE dge_private.group_messages SET payload=$1 WHERE position=2',[randomBytes(96)]);
 await assert.rejects(services.workspace.messages(member,tenantId,documentId,{deviceId:b.deviceId}),code('PRIVATE_MAILBOX_INTEGRITY_ERROR'));
 // Bounded mailbox (12 messages in this test): each admission is commit+Welcome.
 let epoch=1;
 for(let i=0;i<5;i++){const d=await enroll(member,tenantId);await services.workspace.postCommit(owner,tenantId,documentId,commit(a.deviceId,epoch++,{add:d.deviceId}));}
 const last=await enroll(member,tenantId);
 await assert.rejects(services.workspace.postCommit(owner,tenantId,documentId,commit(a.deviceId,epoch,{add:last.deviceId})),code('PRIVATE_MAILBOX_LIMIT_REACHED'));
 // The refused command rolled back atomically: epoch and roster are unchanged.
 const state=await services.workspace.group(owner,tenantId,documentId);
 assert.equal(state.epoch,6);assert.equal(state.members.length,7);
});

test('removal: removed devices lose ciphertext access; stale writes stop until rekey',async()=>{
 const {owner,member,tenantId}=await workspace();
 const a=await enroll(owner,tenantId),b=await enroll(member,tenantId);
 const documentId=await privateDocument(owner,tenantId,a);
 await services.workspace.postCommit(owner,tenantId,documentId,commit(a.deviceId,0,{add:b.deviceId}));
 // epoch 1 exists but the document is still keyed at 0: appends wait for a rekey.
 await assert.rejects(services.ledger.append(owner,tenantId,documentId,frame(0,a.deviceId,1)),code('PRIVATE_DEVICE_NOT_AUTHORIZED'));
 await assert.rejects(services.documents.save(owner,tenantId,documentId,{envelope:envelope(0),expectedVersion:1,commandId:randomUUID()},{deviceId:a.deviceId}),code('PRIVATE_DEVICE_NOT_AUTHORIZED'));
 await assert.rejects(services.documents.save(owner,tenantId,documentId,{envelope:envelope(2),expectedVersion:1,commandId:randomUUID()},{deviceId:a.deviceId}),code('PRIVATE_DEVICE_NOT_AUTHORIZED'));
 await services.documents.save(owner,tenantId,documentId,{envelope:envelope(1),expectedVersion:1,commandId:randomUUID()},{deviceId:a.deviceId});
 await services.ledger.append(member,tenantId,documentId,frame(1,b.deviceId,1));
 assert.equal((await services.documents.read(member,tenantId,documentId,{deviceId:b.deviceId})).keyEpoch,1);
 // The device id is only a selector: another account cannot claim it.
 await assert.rejects(services.documents.read(owner,tenantId,documentId,{deviceId:b.deviceId}),code('PRIVATE_DEVICE_NOT_AUTHORIZED'));
 await assert.rejects(services.documents.read(member,tenantId,documentId),code('PRIVATE_DEVICE_NOT_AUTHORIZED'));
 await services.workspace.postCommit(owner,tenantId,documentId,commit(a.deviceId,1,{remove:b.deviceId}));
 await assert.rejects(services.documents.read(member,tenantId,documentId,{deviceId:b.deviceId}),code('PRIVATE_DEVICE_NOT_AUTHORIZED'));
 await assert.rejects(services.ledger.list(member,tenantId,documentId,{recipientDeviceId:b.deviceId}),code('PRIVATE_DEVICE_NOT_AUTHORIZED'));
 await assert.rejects(services.ledger.append(member,tenantId,documentId,frame(1,b.deviceId,2)),code('PRIVATE_DEVICE_NOT_AUTHORIZED'));
 await services.documents.save(owner,tenantId,documentId,{envelope:envelope(2),expectedVersion:2,commandId:randomUUID()},{deviceId:a.deviceId});
 const c=await enroll(owner,tenantId);
 await services.workspace.postCommit(owner,tenantId,documentId,commit(a.deviceId,2,{add:c.deviceId}));
 // The removed device can fetch its removal commit, but nothing after it.
 const removedView=await services.workspace.messages(member,tenantId,documentId,{deviceId:b.deviceId});
 assert.equal(removedView.removed,true);
 assert.deepEqual(removedView.items.filter(m=>m.kind==='commit').map(m=>m.epoch),[1]);
 await assert.rejects(services.workspace.postCommit(owner,tenantId,documentId,commit(a.deviceId,3,{add:b.deviceId})),code('PRIVATE_DEVICE_PREVIOUSLY_REMOVED'));
});

test('workspace removal or device revocation denies access before the MLS removal commit',async()=>{
 const {owner,member,tenantId}=await workspace();
 const a=await enroll(owner,tenantId),b=await enroll(member,tenantId);
 const documentId=await privateDocument(owner,tenantId,a);
 await services.workspace.postCommit(owner,tenantId,documentId,commit(a.deviceId,0,{add:b.deviceId}));
 await services.documents.save(owner,tenantId,documentId,{envelope:envelope(1),expectedVersion:1,commandId:randomUUID()},{deviceId:a.deviceId});
 await store.revokeDevice(member,b.deviceId);
 await assert.rejects(services.ledger.list(member,tenantId,documentId,{recipientDeviceId:b.deviceId}),code('PRIVATE_DEVICE_NOT_AUTHORIZED'));
 assert.equal((await services.workspace.group(owner,tenantId,documentId)).members.find(m=>m.deviceId===b.deviceId).stale,true);
 const c=await enroll(member,tenantId);
 await services.workspace.postCommit(owner,tenantId,documentId,commit(a.deviceId,1,{add:c.deviceId}));
 await store.changeMember(owner,tenantId,member.accountId,null);
 await assert.rejects(services.documents.read(member,tenantId,documentId,{deviceId:c.deviceId}),e=>e instanceof AccessError);
 const roster=(await services.workspace.group(owner,tenantId,documentId)).members;
 assert.deepEqual(roster.filter(m=>m.stale).map(m=>m.deviceId).sort(),[b.deviceId,c.deviceId].sort());
 // Removed workspace members disappear from the directory and cannot be (re)added.
 assert.deepEqual((await services.workspace.directory(owner,tenantId)).items.map(d=>d.deviceId),[a.deviceId]);
 await services.workspace.postCommit(owner,tenantId,documentId,commit(a.deviceId,2,{remove:c.deviceId}));
 await services.workspace.postCommit(owner,tenantId,documentId,commit(a.deviceId,3,{remove:b.deviceId}));
 assert.deepEqual((await services.workspace.group(owner,tenantId,documentId)).members.filter(m=>m.active).map(m=>m.deviceId),[a.deviceId]);
});

test('directory, groups, mailbox and ciphertext are isolated between workspaces',async()=>{
 const {owner,member,tenantId}=await workspace();
 const outsider=await account('outsider');const other=(await store.createTenant(outsider)).tenantId;
 const a=await enroll(owner,tenantId),x=await enroll(outsider,other);
 const documentId=await privateDocument(owner,tenantId,a);
 await assert.rejects(services.workspace.directory(outsider,tenantId),e=>e instanceof AccessError);
 await assert.rejects(services.workspace.group(outsider,other,documentId),code('PRIVATE_DOCUMENT_NOT_FOUND'));
 await assert.rejects(services.workspace.messages(outsider,other,documentId,{deviceId:x.deviceId}),code('PRIVATE_DEVICE_NOT_AUTHORIZED'));
 await assert.rejects(services.documents.read(outsider,other,documentId,{deviceId:x.deviceId}),code('PRIVATE_DOCUMENT_NOT_FOUND'));
 await assert.rejects(services.workspace.claimKeyPackage(outsider,other,a.deviceId,{}),code('PRIVATE_DEVICE_NOT_FOUND'));
 await assert.rejects(services.workspace.postCommit(owner,tenantId,documentId,commit(a.deviceId,0,{add:x.deviceId})),code('PRIVATE_DEVICE_NOT_FOUND'));
 assert.deepEqual((await services.workspace.groups(outsider,other)).items,[]);
 // Member without a roster device sees no private document listing.
 assert.deepEqual((await services.workspace.groups(member,tenantId)).items,[]);
 assert.equal((await services.workspace.groups(owner,tenantId)).items.length,1);
 await transaction(async tx=>{
  await tx.query("SELECT set_config('dge.tenant_id',$1,true)",[other]);
  for(const table of ['groups','group_members','group_messages','documents','versions'])
   assert.equal((await tx.query('SELECT count(*)::int AS n FROM dge_private.'+table)).rows[0].n,0,table);
  await assert.rejects(tx.query('INSERT INTO dge_private.groups(tenant_id,document_id,group_id,epoch,created_by,creator_device_id,created_at) VALUES($1,$2,$3,0,$4,$5,now())',[tenantId,randomUUID(),randomBytes(32),owner.accountId,a.deviceId]),/row-level security/);
 });
});

test('platform mounts private routes behind the flag with wasm-only CSP relaxation',async()=>{
 const make=privateWorkspaces=>createPlatform({identity:store,transaction,login:{},origin,clock:()=>time,privateWorkspaces});
 const enabled=make(true),disabled=make(false);
 const {owner,tenantId}=await workspace();
 const request=(app,path)=>app.application(new Request(origin+path,{headers:{cookie:'__Host-dge_session='+owner.sessionToken}}),{peerAddress:'127.0.0.1'});
 const on=await request(enabled,'/api/workspaces/'+tenantId+'/private-devices');
 assert.equal(on.status,200);assert.deepEqual(await on.json(),{items:[]});
 assert.equal((await request(disabled,'/api/workspaces/'+tenantId+'/private-devices')).status,404);
 const csp=(await request(enabled,'/healthz')).headers.get('content-security-policy');
 assert.match(csp,/script-src 'self' 'wasm-unsafe-eval';/);assert.doesNotMatch(csp,/'unsafe-eval'/);
 assert.match((await request(disabled,'/healthz')).headers.get('content-security-policy'),/script-src 'self';/);
 assert.equal((await request(disabled,'/mls/quill_mls_bg.wasm')).status,404);
 assert.ok(enabled.bodyLimit('/api/workspaces/'+tenantId+'/private-groups/'+randomUUID()+'/messages')>2_000_000);
 assert.ok(enabled.services.privateWorkspace.ledger);
 // A claimed device that is not the caller's own is a clean 403, never a 5xx.
 const a=await enroll(owner,tenantId);
 const documentId=randomUUID();
 await enabled.services.privateWorkspace.workspace.createGroup(owner,tenantId,{documentId,groupId:b64(privateGroupId(tenantId,documentId,createHash)),deviceId:a.deviceId});
 await enabled.services.privateWorkspace.documents.create(owner,tenantId,{documentId,commandId:randomUUID(),envelope:envelope(0)},{deviceId:a.deviceId});
 const other=await account('member');
 const foreign=await enabled.application(new Request(origin+'/api/workspaces/'+tenantId+'/private-documents/'+documentId+'/updates?recipientDeviceId='+a.deviceId,{headers:{cookie:'__Host-dge_session='+other.sessionToken}}),{peerAddress:'127.0.0.1'});
 assert.equal(foreign.status,403);
 const claimed=await enabled.application(new Request(origin+'/api/workspaces/'+tenantId+'/private-documents/'+documentId,{headers:{cookie:'__Host-dge_session='+other.sessionToken,'x-dge-device':a.deviceId}}),{peerAddress:'127.0.0.1'});
 assert.equal(claimed.status,403);
 assert.equal(disabled.services.privateWorkspace,undefined);
});

test('upgrade router gives each hub its own namespace',()=>{
 const listeners=new Map(),server={on:(n,f)=>listeners.set(n,f),off:()=>listeners.delete('upgrade')};
 const router=routeUpgrades(server);const seen=[];
 router.privateServer.on('upgrade',req=>seen.push('private:'+req.url));
 router.publicServer.on('upgrade',req=>seen.push('public:'+req.url));
 assert.equal(router.privateServer.listenerCount('upgrade'),1);
 listeners.get('upgrade')({url:'/ws/private/a'},{});listeners.get('upgrade')({url:'/ws/public/b'},{});
 assert.deepEqual(seen,['private:/ws/private/a','public:/ws/public/b']);
 router.close();assert.equal(listeners.size,0);
});

test('ciphertext canary never appears in any stored row',async()=>{
 const canary='PRIVATE-CANARY-'+randomUUID();
 const {owner,tenantId}=await workspace();
 const a=await enroll(owner,tenantId);
 const documentId=randomUUID();
 await services.workspace.createGroup(owner,tenantId,{documentId,groupId:b64(privateGroupId(tenantId,documentId,createHash)),deviceId:a.deviceId});
 const key=await webcrypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']);
 const sealed=await encryptLocalDraftBytes(key,new TextEncoder().encode(JSON.stringify({title:canary,body:canary})),{tenantId,workspaceId:tenantId,documentId,epoch:0},webcrypto);
 await services.documents.create(owner,tenantId,{documentId,commandId:randomUUID(),envelope:{version:1,cipher:'AES-256-GCM',keyEpoch:0,nonce:sealed.nonce,ciphertext:sealed.ciphertext}},{deviceId:a.deviceId});
 const update=await sealPrivateYjsUpdate({key,context:{tenantId,workspaceId:tenantId,documentId,senderDeviceId:a.deviceId,epoch:0},update:new TextEncoder().encode(canary),sequence:1,webCrypto:webcrypto});
 await services.ledger.append(owner,tenantId,documentId,update);
 const dump=(await db.query("SELECT table_schema||'.'||table_name AS t FROM information_schema.tables WHERE table_schema IN ('dge_private','dge_identity') AND table_type='BASE TABLE'")).rows;
 const needles=[canary,Buffer.from(canary).toString('hex'),Buffer.from(canary).toString('base64'),Buffer.from(canary).toString('base64url')];
 for(const {t} of dump){
  const text=JSON.stringify((await db.query('SELECT * FROM '+t)).rows,(k,v)=>v instanceof Uint8Array?Buffer.from(v).toString('latin1')+Buffer.from(v).toString('hex'):v);
  for(const needle of needles)assert.equal(text.includes(needle),false,t);
 }
});
