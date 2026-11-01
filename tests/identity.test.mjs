import {test,before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,generateKeyPairSync,sign,createHash,randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import * as oidc from 'openid-client';
import {createIdentityStore,applyIdentityMigrations,AccessError,sessionCookie} from '../server/identity-store.mjs';
import {createOIDCLogin,discoverIdentityProvider} from '../server/oidc-login.mjs';

let db,store,time;
const sessionKey=randomBytes(32),stateKey=randomBytes(32),origin='https://quill.example';
const transaction=callback=>db.transaction(async tx=>{await tx.exec('SET LOCAL ROLE dge_identity_runtime');return callback(tx);});
const passkeyId=randomBytes(32).toString('base64url');
const passkeyAttestationPolicy=Object.freeze({id:'consumer-v1',allowedFormats:['none'],allowedAaguids:['00000000-0000-0000-0000-000000000000']});
const options=()=>({transaction,sessionKey,stateKey,origin,clock:()=>time,
  passkeyAttestationPolicy,
  verifyPasskeyRegistration:async({response})=>({verified:response?.accepted===true,credential:{id:response?.credentialId,publicKey:randomBytes(32).toString('base64url'),counter:0,transports:['internal'],backedUp:false,attestationFormat:'none',aaguid:'00000000-0000-0000-0000-000000000000'}}),
  verifyPasskeyAuthentication:async({response})=>({verified:response?.accepted===true,userVerified:response?.userVerified===true,credentialId:response?.credentialId,newCounter:response?.newCounter})});
before(async()=>{db=await PGlite.create();assert.deepEqual(await applyIdentityMigrations(fn=>db.transaction(fn)),{applied:true});assert.deepEqual(await applyIdentityMigrations(fn=>db.transaction(fn)),{applied:false});});
after(async()=>{await db?.close();});
beforeEach(async()=>{await db.exec('TRUNCATE dge_identity.accounts,dge_identity.tenants,dge_identity.login_challenges CASCADE');time=Date.now();store=createIdentityStore(options());});
const account=async(subject='owner',issuer='https://identity.example')=>({...await store.establishSession({issuer,subject,authenticatedAt:time,authenticationMethods:['pwd','mfa']}),origin});
const denied=promise=>assert.rejects(promise,error=>error instanceof AccessError);
const join=async(owner,tenantId,user,role='editor')=>{const {invitationToken}=await store.invite(owner,tenantId,user.accountId,role);await store.acceptInvitation(user,tenantId,invitationToken);};

test('sessions survive a new service instance; provider subjects never link across issuers',async()=>{
  const a=await account(),b=await account('owner','https://other.example'),again=await account();
  assert.equal(a.accountId,again.accountId);assert.notEqual(a.accountId,b.accountId);assert.notEqual(a.sessionToken,again.sessionToken);
  assert.deepEqual(await createIdentityStore(options()).account(a.sessionToken),{accountId:a.accountId});
  const rows=(await db.query('SELECT * FROM dge_identity.sessions')).rows;
  assert.equal(rows.length,3);assert.ok(rows.every(r=>r.token_digest.length===64));assert.ok(!JSON.stringify(rows).includes(a.sessionToken));assert.ok(!JSON.stringify(rows).includes(a.csrfToken));
});
test('ordinary database role cannot bypass organization row isolation',async()=>{
  const owner=await account(),a=await store.createTenant(owner),b=await store.createTenant(owner);
  await transaction(async tx=>{
    const role=(await tx.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];assert.deepEqual(role,{rolsuper:false,rolbypassrls:false});
    assert.equal((await tx.query('SELECT id FROM dge_identity.tenants')).rows.length,0);
    await tx.query("SELECT set_config('dge.tenant_id',$1,true)",[a.tenantId]);
    assert.deepEqual((await tx.query('SELECT id FROM dge_identity.tenants')).rows.map(x=>x.id),[a.tenantId]);
    assert.equal((await tx.query('SELECT * FROM dge_identity.memberships WHERE tenant_id=$1',[b.tenantId])).rows.length,0);
    await assert.rejects(tx.query('INSERT INTO dge_identity.tenants(id,created_at) VALUES($1,$2)',[randomUUID(),new Date(time)]),/row-level security/);
  });
  // SET LOCAL context must not bleed into a later transaction.
  await transaction(async tx=>assert.equal((await tx.query('SELECT id FROM dge_identity.tenants')).rows.length,0));
});
test('organization access rejects nonmembers and uses bounded member pages',async()=>{
  const owner=await account(),other=await account('other'),viewer=await account('viewer'),{tenantId}=await store.createTenant(owner);
  await denied(store.members(other,tenantId));await join(owner,tenantId,viewer,'viewer');
  const first=await store.members(viewer,tenantId,{limit:1}),second=await store.members(viewer,tenantId,{limit:1,after:first.nextCursor});
  assert.equal(first.items.length,1);assert.equal(second.items.length,1);assert.equal(second.nextCursor,null);assert.notEqual(first.items[0].accountId,second.items[0].accountId);
  await denied(store.members(owner,tenantId,{limit:100000}));
  await denied(store.invite(viewer,tenantId,other.accountId,'admin'));
});
test('state-changing methods require exact origin and the session-bound CSRF token',async()=>{
  const a=await account(),b=await account('other');
  for(const bad of [{...a,origin:'https://attacker.example'},{...a,origin:undefined},{...a,csrfToken:b.csrfToken},{...a,csrfToken:''}])await denied(store.createTenant(bad));
  assert.equal((await db.query('SELECT id FROM dge_identity.tenants')).rows.length,0);
  assert.ok(sessionCookie(a.sessionToken).includes('HttpOnly; Secure; SameSite=Lax'));
  assert.ok(!sessionCookie(a.sessionToken).includes('Domain='));assert.throws(()=>sessionCookie('x; injection'));
});
test('invitation is one-use and bound to both intended account and organization',async()=>{
  const owner=await account(),target=await account('target'),attacker=await account('attacker'),a=await store.createTenant(owner),b=await store.createTenant(owner);
  const invite=await store.invite(owner,a.tenantId,target.accountId,'editor');
  await denied(store.acceptInvitation(attacker,a.tenantId,invite.invitationToken));
  await denied(store.acceptInvitation(target,b.tenantId,invite.invitationToken));
  await store.acceptInvitation(target,a.tenantId,invite.invitationToken);
  await denied(store.acceptInvitation(target,a.tenantId,invite.invitationToken));
  assert.equal((await store.members(target,a.tenantId)).items.length,2);
});
test('removal takes effect on the next request and cancels older invitations',async()=>{
  const owner=await account(),target=await account('target'),{tenantId}=await store.createTenant(owner);await join(owner,tenantId,target);
  const older=await store.invite(owner,tenantId,target.accountId,'editor');await store.changeMember(owner,tenantId,target.accountId,null);
  await denied(store.members(target,tenantId));await denied(store.acceptInvitation(target,tenantId,older.invitationToken));
  assert.ok(await store.account(target.sessionToken)); // Other organizations/account remain available.
});
test('last-owner guard and admin privilege limits preserve authority',async()=>{
  const owner=await account(),admin=await account('admin'),editor=await account('editor'),{tenantId}=await store.createTenant(owner);
  await join(owner,tenantId,admin,'admin');await join(owner,tenantId,editor);
  await denied(store.changeMember(owner,tenantId,owner.accountId,null));
  await denied(store.changeMember(admin,tenantId,owner.accountId,'viewer'));
  await denied(store.changeMember(admin,tenantId,editor.accountId,'owner'));
  await store.changeMember(owner,tenantId,editor.accountId,'owner');await store.changeMember(owner,tenantId,owner.accountId,'viewer');
  const members=await store.members(editor,tenantId);assert.equal(members.items.filter(x=>x.role==='owner').length,1);
  await denied(store.changeMember(owner,tenantId,admin.accountId,null));
});
test('ordinary logout, all-session revocation, suspension and expiry are enforced from stored state',async()=>{
  const a=await account(),b=await account();await store.logout(a);await denied(store.account(a.sessionToken));assert.ok(await store.account(b.sessionToken));
  const c=await account();await store.logoutAll(b);await denied(store.account(b.sessionToken));await denied(store.account(c.sessionToken));
  const d=await account();time+=28800000;await denied(store.account(d.sessionToken));
  const e=await account();await db.query("UPDATE dge_identity.accounts SET status='suspended' WHERE id=$1",[e.accountId]);
  await denied(store.account(e.sessionToken));await denied(account());
});
test('provider assurance is reduced to bounded levels and gates recovery issuance',async()=>{
  const primary={...await store.establishSession({issuer:'https://identity.example',subject:'primary-only',authenticatedAt:time,authenticationMethods:['pwd']}),origin};
  assert.equal((await store.sessionInfo(primary.sessionToken)).authenticationAssurance,'primary');
  await denied(store.issueRecoveryCodes(primary));
  const hardware={...await store.establishSession({issuer:'https://identity.example',subject:'hardware',authenticatedAt:time,authenticationMethods:['pwd','mfa','hwk']}),origin};
  assert.equal((await store.sessionInfo(hardware.sessionToken)).authenticationAssurance,'hardware-bound');
  assert.equal((await store.issueRecoveryCodes(hardware)).recoveryCodes.length,8);
  for(const invalid of [null,[''],['x'.repeat(65)],Array(17).fill('mfa')])await denied(store.establishSession({issuer:'https://identity.example',subject:'invalid-assurance',authenticatedAt:time,authenticationMethods:invalid}));
});
test('single-use recovery codes revoke sessions and create a read-only recovery session',async()=>{
  const primary=await account(),second=await account();
  const issued=await store.issueRecoveryCodes(primary);
  assert.equal(issued.recoveryCodes.length,8);
  const snapshot=JSON.stringify((await db.query('SELECT * FROM dge_identity.recovery_codes')).rows);
  for(const code of issued.recoveryCodes)assert.ok(!snapshot.includes(code));
  const recovery=await store.recoverAccount(primary.accountId,issued.recoveryCodes[0]);
  await denied(store.account(primary.sessionToken));await denied(store.account(second.sessionToken));
  assert.deepEqual(await store.sessionInfo(recovery.sessionToken),{
    accountId:primary.accountId,expiresAt:recovery.expiresAt,authenticatedAt:new Date(time).toISOString(),authenticationMethod:'recovery',authenticationAssurance:'primary',passkeyStepUpExpiresAt:null,recoveryRestricted:true
  });
  await denied(store.createTenant({...recovery,origin}));
  await denied(store.withTenant({...recovery,origin},randomUUID(),{},async()=>true));
  await denied(store.recoverAccount(primary.accountId,issued.recoveryCodes[0]));
  await denied(store.recoverAccount(randomUUID(),issued.recoveryCodes[1]));
  await store.logout({...recovery,origin});await denied(store.account(recovery.sessionToken));
  assert.deepEqual((await db.query('SELECT kind FROM dge_identity.account_security_events ORDER BY occurred_at,id')).rows.map(x=>x.kind).sort(),['recovery-code-redeemed','recovery-codes-issued']);
});
test('rotating recovery codes revoke earlier unused codes and expiry fails closed',async()=>{
  const who=await account(),first=await store.issueRecoveryCodes(who),second=await store.issueRecoveryCodes(who);
  await denied(store.recoverAccount(who.accountId,first.recoveryCodes[0]));
  time+=30*86400000+1;await denied(store.recoverAccount(who.accountId,second.recoveryCodes[0]));
});
test('passkey challenges are session-bound, one-use, counter-checked and separate from device authorization',async()=>{
  const who=await account(),other=await account('other');
  const enrollment=await store.beginPasskeyEnrollment(who);
  assert.equal(enrollment.rpId,'quill.example');assert.equal(enrollment.excludeCredentials.length,0);
  await denied(store.finishPasskeyEnrollment(other,enrollment.challenge,{accepted:true,credentialId:passkeyId}));
  const enrolled=await store.finishPasskeyEnrollment(who,enrollment.challenge,{accepted:true,credentialId:passkeyId});
  assert.match(enrolled.credentialId,/^[a-f0-9-]{36}$/);await denied(store.finishPasskeyEnrollment(who,enrollment.challenge,{accepted:true,credentialId:passkeyId}));
  assert.equal(enrolled.attestationPolicyId,'consumer-v1');
  assert.deepEqual((await db.query('SELECT attestation_policy_id,attestation_format,aaguid::text FROM dge_identity.passkey_credentials')).rows,[{attestation_policy_id:'consumer-v1',attestation_format:'none',aaguid:'00000000-0000-0000-0000-000000000000'}]);
  await denied(store.authorizeDevice(who,'a'.repeat(64)));
  const authentication=await store.beginPasskeyAuthentication(who);
  assert.deepEqual(authentication.allowCredentials,[{id:passkeyId,transports:['internal']}]);
  await denied(store.finishPasskeyAuthentication(who,authentication.challenge,{accepted:true,userVerified:false,credentialId:passkeyId,newCounter:1}));
  const retry=await store.beginPasskeyAuthentication(who);
  await store.finishPasskeyAuthentication(who,retry.challenge,{accepted:true,userVerified:true,credentialId:passkeyId,newCounter:1});
  const authorized=await store.authorizeDevice(who,'a'.repeat(64));assert.equal(authorized.authorized,true);
  const devices=await store.devices(who);assert.equal(devices.items.length,1);assert.equal(devices.items[0].keyThumbprint,'a'.repeat(64));
  await store.revokeDevice(who,devices.items[0].id);assert.equal((await store.devices(who)).items.length,0);
  const rollback=await store.beginPasskeyAuthentication(who);
  await denied(store.finishPasskeyAuthentication(who,rollback.challenge,{accepted:true,userVerified:true,credentialId:passkeyId,newCounter:1}));
});
test('passkey enrollment requires immutable explicit attestation policy evidence',async()=>{
  const who=await account(),mutable={id:'strict-v1',allowedFormats:['none'],allowedAaguids:['00000000-0000-0000-0000-000000000000']};
  const strict=createIdentityStore({...options(),passkeyAttestationPolicy:mutable,
    verifyPasskeyRegistration:async({response,attestationPolicy})=>({verified:response?.accepted===true,credential:{id:response?.credentialId,publicKey:randomBytes(32).toString('base64url'),counter:0,transports:[],backedUp:false,attestationFormat:'packed',aaguid:attestationPolicy.allowedAaguids[0]}})});
  mutable.allowedFormats.push('packed');
  const challenge=await strict.beginPasskeyEnrollment(who);
  await assert.rejects(strict.finishPasskeyEnrollment(who,challenge.challenge,{accepted:true,credentialId:randomBytes(32).toString('base64url')}),error=>error instanceof AccessError&&error.code==='PASSKEY_ATTESTATION_POLICY_REJECTED');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM dge_identity.passkey_credentials')).rows[0].n,0);
  assert.throws(()=>createIdentityStore({...options(),passkeyAttestationPolicy:{id:'bad policy',allowedFormats:[],allowedAaguids:[]}}),/attestation policy/);
  const unavailable=createIdentityStore({...options(),verifyPasskeyRegistration:undefined,verifyPasskeyAuthentication:undefined,passkeyAttestationPolicy:undefined});
  await assert.rejects(unavailable.beginPasskeyEnrollment(who),error=>error instanceof AccessError&&error.code==='PASSKEY_VERIFIER_UNAVAILABLE');
});
test('passkey revocation clears its step-up and every linked authorized device',async()=>{
  const who=await account(),other=await account('other'),credentialId=randomBytes(32).toString('base64url');
  const enrollment=await store.beginPasskeyEnrollment(who),enrolled=await store.finishPasskeyEnrollment(who,enrollment.challenge,{accepted:true,credentialId});
  const authentication=await store.beginPasskeyAuthentication(who);
  await store.finishPasskeyAuthentication(who,authentication.challenge,{accepted:true,userVerified:true,credentialId,newCounter:1});
  await store.authorizeDevice(who,'c'.repeat(64));
  assert.equal((await store.passkeys(who)).items.length,1);
  await denied(store.revokePasskey(other,enrolled.credentialId));
  assert.deepEqual(await store.revokePasskey(who,enrolled.credentialId),{revoked:true,devicesRevoked:1});
  assert.equal((await store.passkeys(who)).items.length,0);assert.equal((await store.devices(who)).items.length,0);
  await denied(store.authorizeDevice(who,'d'.repeat(64)));await denied(store.beginPasskeyAuthentication(who));
  await denied(store.revokePasskey(who,enrolled.credentialId));
  assert.ok((await db.query("SELECT 1 FROM dge_identity.account_security_events WHERE account_id=$1 AND kind='passkey-revoked'",[who.accountId])).rows[0]);
});
test('recovery and primary-only sessions cannot enroll passkeys or authorize devices',async()=>{
  const primary={...await store.establishSession({issuer:'https://identity.example',subject:'primary-passkey',authenticatedAt:time,authenticationMethods:['pwd']}),origin};
  await denied(store.beginPasskeyEnrollment(primary));
  const who=await account(),codes=await store.issueRecoveryCodes(who),recovery={...await store.recoverAccount(who.accountId,codes.recoveryCodes[0]),origin};
  await denied(store.beginPasskeyEnrollment(recovery));await denied(store.beginPasskeyAuthentication(recovery));await denied(store.authorizeDevice(recovery,'b'.repeat(64)));
});
test('provider restoration requires the restricted session and its already-enrolled passkey',async()=>{
  const who=await account('provider-loss'),claimed=await account('claimed','https://replacement.example'),credentialId=randomBytes(32).toString('base64url'),enrollment=await store.beginPasskeyEnrollment(who);
  await denied(store.restoreProviderIdentity(who,{issuer:'https://replacement.example',subject:'replacement',authenticatedAt:time}));
  await store.finishPasskeyEnrollment(who,enrollment.challenge,{accepted:true,credentialId});
  const codes=await store.issueRecoveryCodes(who),recovery={...await store.recoverAccount(who.accountId,codes.recoveryCodes[0]),origin};
  await denied(store.restoreProviderIdentity(recovery,{issuer:'https://replacement.example',subject:'replacement',authenticatedAt:time}));
  const authentication=await store.beginPasskeyAuthentication(recovery);
  await store.finishPasskeyAuthentication(recovery,authentication.challenge,{accepted:true,userVerified:true,credentialId,newCounter:1});
  await denied(store.authorizeDevice(recovery,'b'.repeat(64)));
  await assert.rejects(store.restoreProviderIdentity(recovery,{issuer:'https://replacement.example',subject:'claimed',authenticatedAt:time}),error=>error instanceof AccessError&&error.code==='IDENTITY_ALREADY_LINKED');
  assert.equal((await store.sessionInfo(recovery.sessionToken)).recoveryRestricted,true);assert.ok(await store.account(claimed.sessionToken));
  const restored=await store.restoreProviderIdentity(recovery,{issuer:'https://replacement.example',subject:'replacement',authenticatedAt:time,authenticationMethods:['pwd','mfa']});
  assert.equal(restored.accountId,who.accountId);assert.equal(restored.authenticationMethod,'oidc');assert.equal(restored.authenticationAssurance,'multifactor');
  await denied(store.account(recovery.sessionToken));assert.equal((await store.account(restored.sessionToken)).accountId,who.accountId);
  assert.deepEqual((await db.query('SELECT issuer,subject FROM dge_identity.accounts WHERE id=$1',[who.accountId])).rows,[{issuer:'https://replacement.example',subject:'replacement'}]);
  assert.ok((await db.query("SELECT 1 FROM dge_identity.account_security_events WHERE account_id=$1 AND kind='provider-identity-restored'",[who.accountId])).rows[0]);
});
test('sensitive membership changes require login within five minutes',async()=>{
  const owner=await account(),target=await account('target'),{tenantId}=await store.createTenant(owner);time+=300001;
  assert.equal((await store.members(owner,tenantId)).items.length,1);await denied(store.invite(owner,tenantId,target.accountId,'viewer'));
  const fresh=await account();await store.invite(fresh,tenantId,target.accountId,'viewer');
});
test('new session creation does not reset the identity-provider authentication clock',async()=>{
  const earlier=time-299000,session={...await store.establishSession({issuer:'https://identity.example',subject:'earlier-auth',authenticatedAt:earlier}),origin};
  assert.ok(await store.createTenant(session));time+=1001;
  await denied(store.createTenant(session));assert.ok(await store.account(session.sessionToken));
  for(const authenticatedAt of [undefined,time-300001,time+30001,NaN])await denied(store.establishSession({issuer:'https://identity.example',subject:'invalid-time',authenticatedAt}));
});
test('a backward clock jump does not authorize a session issued in the future',async()=>{
  const session=await account();time-=1;await denied(store.account(session.sessionToken));
});
test('the 002 upgrade preserves old records, rejects their sessions, and leaves 001 unchanged',async()=>{
  const legacy=await PGlite.create();
  try{
    const {identityMigration}=await import('../server/identity-store.mjs'),{createHmac}=await import('node:crypto');await legacy.exec(await identityMigration());
    const id=randomUUID(),raw=randomBytes(32).toString('base64url'),digest=createHmac('sha256',sessionKey).update('session\0'+raw).digest('hex');
    await legacy.query('INSERT INTO dge_identity.accounts(id,issuer,subject,created_at) VALUES($1,$2,$3,$4)',[id,'https://identity.example','legacy',new Date(time)]);
    await legacy.query('INSERT INTO dge_identity.sessions(token_digest,account_id,auth_epoch,csrf_digest,created_at,expires_at) VALUES($1,$2,1,$3,$4,$5)',[digest,id,'0'.repeat(64),new Date(time),new Date(time+3600000)]);
    await applyIdentityMigrations(fn=>legacy.transaction(fn));
    const upgraded=createIdentityStore({...options(),transaction:fn=>legacy.transaction(async tx=>{await tx.exec('SET LOCAL ROLE dge_identity_runtime');return fn(tx);})});
    await denied(upgraded.account(raw));assert.equal((await legacy.query('SELECT id FROM dge_identity.accounts WHERE id=$1',[id])).rows.length,1);
    assert.equal((await legacy.query('SELECT count(*)::int AS n FROM dge_identity.sessions')).rows[0].n,1);
    await assert.rejects(legacy.query('INSERT INTO dge_identity.sessions(token_digest,account_id,auth_epoch,csrf_digest,created_at,expires_at) VALUES($1,$2,1,$3,$4,$5)',['1'.repeat(64),id,'0'.repeat(64),new Date(time),new Date(time+3600000)]),/authenticated_session_time/);
  }finally{await legacy.close();}
});
test('invitation expires without reauthorizing an account through a fresh login',async()=>{
  const owner=await account(),target=await account('target'),{tenantId}=await store.createTenant(owner),invite=await store.invite(owner,tenantId,target.accountId,'viewer');
  time+=86400001;const fresh=await account('target');await denied(store.acceptInvitation(fresh,tenantId,invite.invitationToken));
});
test('transaction rollback leaves no tenant, membership or audit event after a failed write',async()=>{
  const owner=await account();
  const broken=createIdentityStore({...options(),transaction:fn=>transaction(async tx=>fn({query:(sql,args)=>sql.startsWith('INSERT INTO dge_identity.events')?Promise.reject(Error('storage failed')):tx.query(sql,args)}))});
  await assert.rejects(broken.createTenant(owner),/storage failed/);
  for(const table of ['tenants','memberships','events'])assert.equal((await db.query('SELECT count(*)::int AS n FROM dge_identity.'+table)).rows[0].n,0);
});
test('runtime role cannot rewrite or delete membership audit events',async()=>{
  const owner=await account(),{tenantId}=await store.createTenant(owner);
  await assert.rejects(transaction(async tx=>{await tx.query("SELECT set_config('dge.tenant_id',$1,true)",[tenantId]);await tx.query('DELETE FROM dge_identity.events');}),/permission denied/);
});
test('login challenges are encrypted, browser-bound, expiring and consumed exactly once',async()=>{
  const state=randomBytes(32).toString('base64url'),browser=randomBytes(32).toString('base64url'),secret={verifier:'fixture-pkce-secret',nonce:'fixture-nonce'};
  await store.putLogin(state,browser,secret);
  const snapshot=JSON.stringify((await db.query('SELECT * FROM dge_identity.login_challenges')).rows);
  for(const value of [state,browser,secret.verifier,secret.nonce])assert.ok(!snapshot.includes(value));
  await denied(store.consumeLogin(state,randomBytes(32).toString('base64url')));
  assert.deepEqual(await store.consumeLogin(state,browser),secret);await denied(store.consumeLogin(state,browser));
  await store.putLogin(state,browser,secret);time+=600000;await denied(store.consumeLogin(state,browser));assert.equal(await store.pruneExpiredLogins(),1);
});
test('tampered login state does not decrypt or create a session',async()=>{
  const state=randomBytes(32).toString('base64url'),browser=randomBytes(32).toString('base64url');await store.putLogin(state,browser,{verifier:'never-log'});
  await db.query("UPDATE dge_identity.login_challenges SET sealed_state=repeat('A',100)");
  await assert.rejects(store.consumeLogin(state,browser));assert.equal((await db.query('SELECT count(*)::int AS n FROM dge_identity.sessions')).rows[0].n,0);
});
test('configuration fails closed for insecure origins, shared keys and excessive session duration',async()=>{
  for(const change of [{origin:'http://quill.example'},{origin:origin+'/'},{stateKey:sessionKey},{sessionKey:Buffer.alloc(0)},{sessionSeconds:999999}])assert.throws(()=>createIdentityStore({...options(),...change}));
  await assert.rejects(discoverIdentityProvider({issuer:'http://identity.example',clientId:'x',clientSecret:'fixture'}),/HTTPS/);
});
test('migration runner rejects edited history rather than silently accepting a different schema',async()=>{
  await db.query("UPDATE dge_identity.migrations SET checksum=repeat('0',64) WHERE version=1");
  try{await assert.rejects(applyIdentityMigrations(fn=>db.transaction(fn)),/checksum changed/);}
  finally{const {createHash}=await import('node:crypto');const {identityMigration}=await import('../server/identity-store.mjs');await db.query('UPDATE dge_identity.migrations SET checksum=$1 WHERE version=1',[createHash('sha256').update(await identityMigration()).digest('hex')]);}
});

// A synthetic OIDC provider exercises the real openid-client validation code.
// Keys and tokens below are created for this test process; no external account/provider is contacted.
const keys=generateKeyPairSync('rsa',{modulusLength:2048});
function provider(scenario={}) {
  let authorization;
  const issuer='https://provider.example',clientId='engine-test';
  const config=new oidc.Configuration({issuer,authorization_endpoint:issuer+'/authorize',token_endpoint:issuer+'/token',jwks_uri:issuer+'/jwks',id_token_signing_alg_values_supported:['RS256'],response_types_supported:['code']},clientId,'fixture-client-secret');
  config[oidc.customFetch]=async(url,init)=>{
    if(String(url)===issuer+'/jwks')return Response.json({keys:[{...keys.publicKey.export({format:'jwk'}),kid:'fixture-key',alg:'RS256',use:'sig'}]});
    assert.equal(String(url),issuer+'/token');const form=new URLSearchParams(init.body);
    assert.equal(form.get('code'),'test-code');assert.equal(createHash('sha256').update(form.get('code_verifier')).digest('base64url'),authorization.searchParams.get('code_challenge'));
    const now=Math.floor(Date.now()/1000),payload={iss:issuer,sub:'verified-user',aud:clientId,iat:now,exp:now+300,auth_time:now,nonce:authorization.searchParams.get('nonce'),amr:['pwd','mfa'],...scenario.claims};
    const unsigned=Buffer.from(JSON.stringify({alg:'RS256',kid:'fixture-key'})).toString('base64url')+'.'+Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature=sign('RSA-SHA256',Buffer.from(unsigned),keys.privateKey).toString('base64url');
    return Response.json({access_token:'unused-fixture-access-token',token_type:'Bearer',expires_in:300,id_token:unsigned+'.'+(scenario.badSignature?'invalid-signature':signature)});
  };
  const login=createOIDCLogin({store,configuration:config,redirectUri:origin+'/auth/callback'});
  return {login,async start(){const result=await login.start();authorization=new URL(result.authorizationUrl);return {state:authorization.searchParams.get('state'),browser:result.cookie.match(/^__Host-dge_login=([^;]+)/)[1],authorization};}};
}
test('OIDC rejects ambiguous callbacks before consuming browser-bound login state',async()=>{
  const {login,start}=provider(),pending=await start();
  const base=origin+'/auth/callback?code=test-code&state='+pending.state;
  for(const invalid of [
    base+'&code=second-code',
    base+'&error=access_denied',
    base+'&error_description=injected',
    base+'&iss='+encodeURIComponent('https://impostor.example'),
    base+'&iss='+encodeURIComponent('https://provider.example')+'&iss='+encodeURIComponent('https://provider.example'),
    base+'&unused='+ 'x'.repeat(9000),
    origin+'/auth/callback?state='+pending.state
  ])await denied(login.complete(invalid,pending.browser));
  const good=await login.complete(base,pending.browser);
  assert.ok(await store.account(good.sessionToken));
});
test('OIDC accepts an exact configured authorization response issuer',async()=>{
  const {login,start}=provider(),pending=await start();
  const callback=origin+'/auth/callback?code=test-code&state='+pending.state+'&iss='+encodeURIComponent('https://provider.example');
  const authenticated=await login.complete(callback,pending.browser);
  assert.ok(await store.account(authenticated.sessionToken));
});
test('OIDC code flow validates signature, issuer, audience, nonce, state and PKCE before session creation',async()=>{
  const {login,start}=provider(),pending=await start();assert.equal(pending.authorization.searchParams.get('code_challenge_method'),'S256');
  const callback=origin+'/auth/callback?code=test-code&state='+pending.state;
  await denied(login.complete(callback,randomBytes(32).toString('base64url')));
  const session=await login.complete(callback,pending.browser);assert.ok(session.cookie.startsWith('__Host-dge_session='));assert.ok(!Object.hasOwn(session,'access_token'));
  assert.ok(await store.account(session.sessionToken));await denied(login.complete(callback,pending.browser));
});
for(const [name,scenario] of Object.entries({nonce:{claims:{nonce:'wrong'}},issuer:{claims:{iss:'https://impostor.example'}},audience:{claims:{aud:'another-app'}},expiry:{claims:{exp:1}},oldLogin:{claims:{auth_time:1}},signature:{badSignature:true}})){
  test('OIDC rejects invalid '+name+' without issuing a session',async()=>{
    const {login,start}=provider(scenario),pending=await start();await assert.rejects(login.complete(origin+'/auth/callback?code=test-code&state='+pending.state,pending.browser));
    assert.equal((await db.query('SELECT count(*)::int AS n FROM dge_identity.sessions')).rows[0].n,0);
  });
}
test('OIDC callback cannot change configured origin/path or repeat state parameters',async()=>{
  const {login,start}=provider(),p=await start();
  for(const callback of ['not-a-url','https://attacker.example/auth/callback?state='+p.state,origin+'/elsewhere?state='+p.state,origin+'/auth/callback?state='+p.state+'&state='+p.state])await denied(login.complete(callback,p.browser));
});
