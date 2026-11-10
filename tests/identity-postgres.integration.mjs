import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import pg from 'pg';
import {createDocumentStore} from '../server/document-store.mjs';
import {createLegalDocument} from '../src/legal-structure.mjs';
import {createProposalStore} from '../server/proposal-store.mjs';
import {createDiscussionStore} from '../server/discussion-store.mjs';
import {createIdentityStore,pgTransactions,applyIdentityMigrations,verifyIdentityRuntime,AccessError} from '../server/identity-store.mjs';

// Intentionally limited to a disposable loopback test database. Never accepts a production URL.
const url=new URL(process.env.DGE_TEST_DATABASE_URL??'');
if(!['127.0.0.1','localhost'].includes(url.hostname)||!/^\/[a-z0-9_]+_test$/.test(url.pathname))throw Error('Disposable loopback database ending in _test required');
const owner=new pg.Pool({connectionString:url.href,max:1});
let runtime;
after(async()=>{await runtime?.end();await owner.end();});
test('PostgreSQL enforces row permissions and serializes competing membership and invitation writes',async t=>{
  assert.deepEqual(await applyIdentityMigrations(pgTransactions(owner)),{applied:true});
  assert.deepEqual(await applyIdentityMigrations(pgTransactions(owner)),{applied:false});
  const login='dge_test_'+randomBytes(8).toString('hex'),password=randomBytes(32).toString('hex');
  await owner.query(`CREATE ROLE ${login} LOGIN PASSWORD '${password}' IN ROLE dge_identity_runtime`);
  const runtimeUrl=new URL(url);runtimeUrl.username=login;runtimeUrl.password=password;
  runtime=new pg.Pool({connectionString:runtimeUrl.href,max:4});
  assert.equal(await verifyIdentityRuntime(runtime),true);
  await assert.rejects(verifyIdentityRuntime(owner),/Unprivileged/);
  const flags=(await runtime.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];
  assert.deepEqual(flags,{rolsuper:false,rolbypassrls:false});
  const store=createIdentityStore({transaction:pgTransactions(runtime),sessionKey:randomBytes(32),stateKey:randomBytes(32),origin:'https://quill.example',
    passkeyAttestationPolicy:{id:'consumer-v1',allowedFormats:['none'],allowedAaguids:['00000000-0000-0000-0000-000000000000']},
    verifyPasskeyRegistration:async({response})=>({verified:response?.accepted===true,credential:{id:response?.credentialId,publicKey:randomBytes(32).toString('base64url'),counter:0,transports:['internal'],backedUp:false,attestationFormat:'none',aaguid:'00000000-0000-0000-0000-000000000000'}}),
    verifyPasskeyAuthentication:async({response})=>({verified:response?.accepted===true,userVerified:response?.userVerified===true,credentialId:response?.credentialId,newCounter:response?.newCounter})});
  const user=async()=>({...await store.establishSession({issuer:'https://test-provider.example',subject:randomUUID(),authenticatedAt:Date.now(),authenticationMethods:['pwd','mfa']}),origin:'https://quill.example'});
  const a=await user(),b=await user(),c=await user(),{tenantId}=await store.createTenant(a);let remainingOwner=a;
  const invitation=await store.invite(a,tenantId,b.accountId,'editor');
  await t.test('a one-use invitation has only one successful concurrent acceptance',async()=>{
    const results=await Promise.allSettled([store.acceptInvitation(b,tenantId,invitation.invitationToken),store.acceptInvitation(b,tenantId,invitation.invitationToken)]);
    assert.equal(results.filter(x=>x.status==='fulfilled').length,1);assert.ok(results.find(x=>x.status==='rejected').reason instanceof AccessError);
  });
  await store.changeMember(a,tenantId,b.accountId,'owner');
  await t.test('two owners cannot concurrently remove the final owner',async()=>{
    const results=await Promise.allSettled([store.changeMember(a,tenantId,a.accountId,null),store.changeMember(b,tenantId,b.accountId,null)]);
    assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
    const remaining=results[0].status==='fulfilled'?b:a;
    remainingOwner=remaining;
    const members=await store.members(remaining,tenantId);assert.equal(members.items.filter(x=>x.role==='owner').length,1);
    await assert.rejects(store.members(c,tenantId),AccessError);
    const removed=remaining===a?b:a;await assert.rejects(store.members(removed,tenantId),AccessError);
  });
  await t.test('invitation acceptance and cancellation serialize without a half-authorized membership',async()=>{
    const pending=await store.invite(remainingOwner,tenantId,c.accountId,'editor');
    const results=await Promise.allSettled([store.acceptInvitation(c,tenantId,pending.invitationToken),store.revokeInvitation(remainingOwner,tenantId,pending.invitationId)]);
    assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
    const members=await store.members(remainingOwner,tenantId);assert.equal(members.items.some(x=>x.accountId===c.accountId),results[0].status==='fulfilled');
    const record=(await owner.query('SELECT consumed_at,revoked_at FROM dge_identity.invitations WHERE id=$1',[pending.invitationId])).rows[0];assert.notEqual(Boolean(record.consumed_at),Boolean(record.revoked_at));
  });
  await t.test('a recovery code creates one restricted session under concurrent redemption',async()=>{
    const recoveryUser=await user(),codes=await store.issueRecoveryCodes(recoveryUser);
    const results=await Promise.allSettled([
      store.recoverAccount(recoveryUser.accountId,codes.recoveryCodes[0]),
      store.recoverAccount(recoveryUser.accountId,codes.recoveryCodes[0]),
    ]);
    assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
    assert.ok(results.find(x=>x.status==='rejected').reason instanceof AccessError);
    const recovered=results.find(x=>x.status==='fulfilled').value;
    assert.equal((await store.sessionInfo(recovered.sessionToken)).recoveryRestricted,true);
    await assert.rejects(store.createTenant({...recovered,origin:'https://quill.example'}),AccessError);
    await assert.rejects(store.withTenant({...recovered,origin:'https://quill.example'},tenantId,{},async()=>true),AccessError);
    const rotationUser=await user();
    await Promise.all([store.issueRecoveryCodes(rotationUser),store.issueRecoveryCodes(rotationUser)]);
    const active=(await owner.query('SELECT count(*)::int AS n FROM dge_identity.recovery_codes WHERE account_id=$1 AND consumed_at IS NULL AND revoked_at IS NULL',[rotationUser.accountId])).rows[0].n;
    assert.equal(active,8);
    await store.logout({...recovered,origin:'https://quill.example'});
  });
  await t.test('a passkey challenge is consumed once and only fresh user verification authorizes a device',async()=>{
    const passkeyUser=await user(),credentialId=randomBytes(32).toString('base64url');
    const enrollment=await store.beginPasskeyEnrollment(passkeyUser);
    const enrollResults=await Promise.allSettled([0,1].map(()=>store.finishPasskeyEnrollment(passkeyUser,enrollment.challenge,{accepted:true,credentialId})));
    assert.equal(enrollResults.filter(item=>item.status==='fulfilled').length,1);
    assert.ok(enrollResults.find(item=>item.status==='rejected').reason instanceof AccessError);
    await assert.rejects(store.authorizeDevice(passkeyUser,'a'.repeat(64)),AccessError);
    const authentication=await store.beginPasskeyAuthentication(passkeyUser);
    await store.finishPasskeyAuthentication(passkeyUser,authentication.challenge,{accepted:true,userVerified:true,credentialId,newCounter:1});
    await store.authorizeDevice(passkeyUser,'a'.repeat(64));
    assert.equal((await store.devices(passkeyUser)).items.length,1);
    const rollback=await store.beginPasskeyAuthentication(passkeyUser);
    await assert.rejects(store.finishPasskeyAuthentication(passkeyUser,rollback.challenge,{accepted:true,userVerified:true,credentialId,newCounter:1}),AccessError);
    const stored=(await store.passkeys(passkeyUser)).items[0];
    const race=await Promise.allSettled([store.revokePasskey(passkeyUser,stored.id),store.authorizeDevice(passkeyUser,'b'.repeat(64))]);
    assert.equal(race[0].status,'fulfilled');
    assert.equal((await store.devices(passkeyUser)).items.length,0);
    await assert.rejects(store.authorizeDevice(passkeyUser,'c'.repeat(64)),AccessError);
  });
  await t.test('provider restoration atomically replaces identity and revokes the restricted session',async()=>{
    const recoveryUser=await user(),credentialId=randomBytes(32).toString('base64url');
    const enrollment=await store.beginPasskeyEnrollment(recoveryUser);
    await store.finishPasskeyEnrollment(recoveryUser,enrollment.challenge,{accepted:true,credentialId});
    const codes=await store.issueRecoveryCodes(recoveryUser),recovered={...await store.recoverAccount(recoveryUser.accountId,codes.recoveryCodes[0]),origin:'https://quill.example'};
    const authentication=await store.beginPasskeyAuthentication(recovered);
    await store.finishPasskeyAuthentication(recovered,authentication.challenge,{accepted:true,userVerified:true,credentialId,newCounter:1});
    const restored=await store.restoreProviderIdentity(recovered,{issuer:'https://replacement-provider.example',subject:randomUUID(),authenticatedAt:Date.now(),authenticationMethods:['pwd','mfa']});
    assert.equal(restored.accountId,recoveryUser.accountId);
    await assert.rejects(store.account(recovered.sessionToken),AccessError);
    assert.equal((await store.account(restored.sessionToken)).accountId,recoveryUser.accountId);
    assert.equal((await owner.query("SELECT count(*)::int AS n FROM dge_identity.account_security_events WHERE account_id=$1 AND kind='provider-identity-restored'",[recoveryUser.accountId])).rows[0].n,1);
  });
  await t.test('parallel public-document saves reject lost edits and duplicate commands commit once',async()=>{
    const documents=createDocumentStore({identity:store,transaction:pgTransactions(runtime)});
    const document=createLegalDocument({id:randomUUID(),tenantId,title:'Parallel document'});
    const initial=await documents.create(remainingOwner,tenantId,{document,commandId:randomUUID(),disclosure:'publish-all-revisions-v1'});
    const edited=text=>({...structuredClone(document),revision:1,content:[{kind:'paragraph',id:document.content[0].id,inlines:[{kind:'text',text}]}]});
    const results=await Promise.allSettled(['A','B'].map(text=>documents.save(remainingOwner,tenantId,document.id,{document:edited(text),commandId:randomUUID(),expectedVersion:1})));
    assert.equal(results.filter(x=>x.status==='fulfilled').length,1);assert.equal(results.find(x=>x.status==='rejected').reason.code,'VERSION_CONFLICT');
    const current=await documents.read(remainingOwner,tenantId,document.id);assert.equal(current.version,2);assert.equal(current.previousDigest,initial.digest);
    const payload={document:{...structuredClone(current.document),revision:2},commandId:randomUUID(),expectedVersion:2};
    const duplicate=await Promise.all([documents.save(remainingOwner,tenantId,document.id,payload),documents.save(remainingOwner,tenantId,document.id,payload)]);
    assert.deepEqual(duplicate[0],duplicate[1]);assert.equal((await documents.history(document.id)).items.length,3);
  });
  await t.test('restoration races and retries on separate PostgreSQL connections preserve one new head',async()=>{
    const documents=createDocumentStore({identity:store,transaction:pgTransactions(runtime)}),document=createLegalDocument({id:randomUUID(),tenantId,title:'Restoration race'});
    const initial=await documents.create(remainingOwner,tenantId,{document,commandId:randomUUID(),disclosure:'publish-all-revisions-v1'});
    const current={...structuredClone(document),revision:1,metadata:{...document.metadata,title:'Changed title'}};
    await documents.save(remainingOwner,tenantId,document.id,{document:current,expectedVersion:1,commandId:randomUUID()});
    const restore={commandId:randomUUID(),expectedVersion:2,sourceVersion:1,sourceDigest:initial.digest,disclosure:'restore-public-revision-v1'};
    const results=await Promise.all([documents.restore(remainingOwner,tenantId,document.id,restore),documents.restore(remainingOwner,tenantId,document.id,restore)]);
    assert.deepEqual(results[0],results[1]);assert.equal(results[0].version,3);
    const source=(await documents.history(document.id)).items[1];
    const competing=await Promise.allSettled([
      documents.restore(remainingOwner,tenantId,document.id,{...restore,commandId:randomUUID(),expectedVersion:3,sourceVersion:2,sourceDigest:source.digest}),
      documents.save(remainingOwner,tenantId,document.id,{document:{...structuredClone(results[0].document),revision:3},commandId:randomUUID(),expectedVersion:3})
    ]);
    assert.equal(competing.filter(result=>result.status==='fulfilled').length,1);
    assert.equal(competing.find(result=>result.status==='rejected').reason.code,'VERSION_CONFLICT');
    assert.equal((await documents.read(remainingOwner,tenantId,document.id)).version,4);
    assert.equal((await documents.history(document.id)).items.length,4);
    assert.equal((await owner.query('SELECT count(*)::int n FROM dge_documents.anchor_outbox WHERE document_id=$1',[document.id])).rows[0].n,4);
  });
  await t.test('parallel proposal retries commit once and member removal fences later submissions',async()=>{
    const documents=createDocumentStore({identity:store,transaction:pgTransactions(runtime)}),proposals=createProposalStore({identity:store,transaction:pgTransactions(runtime)});
    const document=structuredClone(createLegalDocument({id:randomUUID(),tenantId,title:'Proposal race'}));document.content[0].inlines=[{kind:'text',text:'Report annually.'}];
    await documents.create(remainingOwner,tenantId,{document,commandId:randomUUID(),disclosure:'publish-all-revisions-v1'});
    const input={baseVersion:1,selection:{blockId:document.content[0].id,start:7,end:15,quote:'annually'},replacement:'quarterly',rationale:'Keep reporting current.',commandId:randomUUID(),disclosure:'publish-proposal-v1'};
    const duplicate=await Promise.all([proposals.create(remainingOwner,tenantId,document.id,input),proposals.create(remainingOwner,tenantId,document.id,input)]);assert.deepEqual(duplicate[0],duplicate[1]);
    assert.equal((await owner.query('SELECT count(*)::int AS n FROM dge_proposals.anchor_outbox WHERE document_id=$1',[document.id])).rows[0].n,1);
    const contributor=await user(),invitation=await store.invite(remainingOwner,tenantId,contributor.accountId,'participant');await store.acceptInvitation(contributor,tenantId,invitation.invitationToken);
    const race=await Promise.allSettled([proposals.create(contributor,tenantId,document.id,{...input,commandId:randomUUID()}),store.changeMember(remainingOwner,tenantId,contributor.accountId,null)]);assert.equal(race[1].status,'fulfilled');
    await assert.rejects(proposals.create(contributor,tenantId,document.id,{...input,commandId:randomUUID()}),AccessError);
    assert.equal((await proposals.list(document.id)).items.length,race[0].status==='fulfilled'?2:1);
  });
  await t.test('simultaneous argument vote changes conserve counts and duplicate requests count once',async()=>{
    const documents=createDocumentStore({identity:store,transaction:pgTransactions(runtime)}),proposals=createProposalStore({identity:store,transaction:pgTransactions(runtime)}),discussion=createDiscussionStore({identity:store,transaction:pgTransactions(runtime)});
    const document=structuredClone(createLegalDocument({id:randomUUID(),tenantId,title:'Point vote race'}));document.content[0].inlines=[{kind:'text',text:'Report annually.'}];await documents.create(remainingOwner,tenantId,{document,commandId:randomUUID(),disclosure:'publish-all-revisions-v1'});
    const p=await proposals.create(remainingOwner,tenantId,document.id,{baseVersion:1,selection:{blockId:document.content[0].id,start:7,end:15,quote:'annually'},replacement:'quarterly',rationale:'Timely reports.',commandId:randomUUID(),disclosure:'publish-proposal-v1'}),proposalId=p.proposal.id;
    const point=await discussion.create(remainingOwner,tenantId,document.id,proposalId,{position:'support',text:'Frequent reports aid oversight.',commandId:randomUUID(),disclosure:'publish-point-v1'});
    const voter=await user(),invite=await store.invite(remainingOwner,tenantId,voter.accountId,'participant');await store.acceptInvitation(voter,tenantId,invite.invitationToken);
    const firstRacePoint=await discussion.create(remainingOwner,tenantId,document.id,proposalId,{position:'oppose',text:'Concurrent first vote check.',commandId:randomUUID(),disclosure:'publish-point-v1'});
    const firstRace=await Promise.allSettled([1,-1].map(value=>discussion.vote(voter,tenantId,document.id,proposalId,firstRacePoint.point.id,{value,expectedVoteVersion:0,commandId:randomUUID()})));assert.equal(firstRace.filter(item=>item.status==='fulfilled').length,1);assert.equal(firstRace.find(item=>item.status==='rejected').reason.code,'POINT_VOTE_CONFLICT');
    const firstActual=(await discussion.mine(voter,tenantId,document.id,proposalId,{pointIds:[firstRacePoint.point.id]})).items[0],firstPublic=(await discussion.list(document.id,proposalId,{position:'oppose'})).items[0];assert.equal(firstActual.voteVersion,1);assert.equal(firstPublic.up,firstActual.value===1?1:0);assert.equal(firstPublic.down,firstActual.value===-1?1:0);
    const initial={value:1,expectedVoteVersion:0,commandId:randomUUID()};const duplicates=await Promise.all([discussion.vote(voter,tenantId,document.id,proposalId,point.point.id,initial),discussion.vote(voter,tenantId,document.id,proposalId,point.point.id,initial)]);assert.deepEqual(duplicates[0],duplicates[1]);assert.equal(duplicates[0].up,1);
    const race=await Promise.allSettled([-1,0].map(value=>discussion.vote(voter,tenantId,document.id,proposalId,point.point.id,{value,expectedVoteVersion:1,commandId:randomUUID()})));assert.equal(race.filter(item=>item.status==='fulfilled').length,1);assert.equal(race.find(item=>item.status==='rejected').reason.code,'POINT_VOTE_CONFLICT');
    const actual=(await discussion.mine(voter,tenantId,document.id,proposalId,{pointIds:[point.point.id]})).items[0],publicPoint=(await discussion.list(document.id,proposalId)).items.find(item=>item.point.id===point.point.id);assert.equal(publicPoint.up,actual.value===1?1:0);assert.equal(publicPoint.down,actual.value===-1?1:0);assert.equal(actual.voteVersion,2);
    assert.equal((await owner.query('SELECT count(*)::int AS n FROM dge_discussion.vote_events WHERE point_id=$1',[point.point.id])).rows[0].n,2);
  });
  await t.test('row security denies an unscoped pooled connection and session revocation survives reuse',async()=>{
    assert.equal((await runtime.query('SELECT id FROM dge_identity.tenants')).rows.length,0);
    await assert.rejects(runtime.query('DELETE FROM dge_identity.events'),/permission denied/);
    const fresh=await user();await store.logoutAll(fresh);await assert.rejects(store.account(fresh.sessionToken),AccessError);
  });
});
