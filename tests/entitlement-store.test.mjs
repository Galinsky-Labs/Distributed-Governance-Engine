import {before,after,beforeEach,test} from "node:test";
import assert from "node:assert/strict";
import {randomUUID,randomBytes} from "node:crypto";
import {PGlite} from "@electric-sql/pglite";
import {createIdentityStore,applyIdentityMigrations} from "../server/identity-store.mjs";
import {createLegalDocument} from "../src/legal-structure.mjs";
import {createDocumentStore} from "../server/document-store.mjs";
import {createProposalStore} from "../server/proposal-store.mjs";
import {createDecisionStore} from "../server/decision-store.mjs";
import {createSettingsStore} from "../server/settings-store.mjs";
import {createEntitlementStore,subjectOf} from "../server/entitlement-store.mjs";
import {createBillingRoutes} from "../server/billing-http.mjs";
import {createAccountHandler} from "../server/account-http.mjs";
import {changePlatformAdmin} from "../scripts/grant-platform-admin.mjs";

const origin="https://quill.example";
let db,identity,settings,entitlements,documents,plain,tenantId,owner,editor,participant,admin,outsider,now,platformVersion;
const transaction=fn=>db.transaction(async tx=>{await tx.exec("SET LOCAL ROLE dge_identity_runtime");return fn(tx);});
const user=async()=>({...await identity.establishSession({issuer:"https://provider.example",subject:randomUUID(),authenticatedAt:Date.now()}),origin});
const asWorker=fn=>transaction(async tx=>{await tx.query("SELECT set_config('dge.worker','billing',true)");return fn(tx);});
const newDocument=(title="Entitlement test")=>{
  const document=structuredClone(createLegalDocument({id:randomUUID(),tenantId,title}));
  document.content[0].inlines=[{kind:"text",text:"The agency shall report annually."}];
  return document;
};
const create=(who=owner,store=documents,commandId=randomUUID(),document=newDocument())=>
  store.create(who,tenantId,{document,commandId,disclosure:"publish-all-revisions-v1"});
const platformChange=async changes=>{
  const result=await settings.change(admin,{scope:"platform"},{changes,expectedVersion:platformVersion,reason:"Pricing policy change"});
  platformVersion=result.version;
};
const buyCredits=(subject,quantity,key=randomUUID())=>asWorker(tx=>entitlements.within.purchaseCredits(tx,subject,{quantity,provenance:"credit-pack",provenanceRef:"test:"+key,idempotencyKey:"checkout:"+key,at:new Date(now)}));
const credits=async subject=>(await asWorker(tx=>tx.query("SELECT credits FROM dge_billing.balances WHERE subject=$1",[subject.key]))).rows[0]?.credits??0;
const usageCount=async()=>(await asWorker(tx=>tx.query("SELECT count(*)::int AS n FROM dge_billing.usage"))).rows[0].n;
const documentCount=async()=>(await db.query("SELECT count(*)::int AS n FROM dge_documents.documents")).rows[0].n;
const grant=(input,who=admin)=>entitlements.createGrant(who,{period:"none",provenance:"administrator",reason:"Pilot programme",idempotencyKey:randomUUID(),...input});

before(async()=>{db=await PGlite.create();await applyIdentityMigrations(fn=>db.transaction(fn));});
after(async()=>db?.close());
beforeEach(async()=>{
  await db.exec("TRUNCATE dge_identity.accounts,dge_identity.tenants,dge_identity.login_challenges CASCADE");
  now=Date.UTC(2026,2,4,15);platformVersion=0;
  identity=createIdentityStore({transaction,origin,sessionKey:randomBytes(32),stateKey:randomBytes(32)});
  settings=createSettingsStore({identity,transaction});
  entitlements=createEntitlementStore({identity,transaction,settings,clock:()=>now});
  documents=createDocumentStore({identity,transaction,entitlements});
  plain=createDocumentStore({identity,transaction});
  [owner,editor,participant,admin,outsider]=await Promise.all([user(),user(),user(),user(),user()]);
  ({tenantId}=await identity.createTenant(owner));
  for(const [who,role] of [[editor,"editor"],[participant,"participant"]]){
    const invite=await identity.invite(owner,tenantId,who.accountId,role);
    await identity.acceptInvitation(who,tenantId,invite.invitationToken);
  }
  await changePlatformAdmin(fn=>db.transaction(fn),{action:"grant",accountId:admin.accountId,reason:"Billing operations"});
});

test("without the hook document creation is unchanged and records no entitlement usage",async()=>{
  for(let i=0;i<3;i++)assert.equal((await create(owner,plain)).version,1);
  assert.equal(await usageCount(),0);
  assert.throws(()=>createDocumentStore({identity,transaction,entitlements:{}}),/Invalid entitlement hook/);
});

test("creation reserves the weekly allowance, then fails closed with no document when nothing covers it",async()=>{
  const first=await create();
  assert.equal(first.version,1);
  await assert.rejects(create(),{code:"ENTITLEMENT_REQUIRED",status:402});
  assert.equal(await documentCount(),1);
  assert.equal(await usageCount(),1);
  const status=await entitlements.status(owner);
  assert.deepEqual([status.allowance.limit,status.allowance.used,status.allowance.remaining],[1,1,0]);
  assert.deepEqual(status.paidOffer,{reason:"no-entitlement",automaticCharge:false});
  // Another member has their own weekly allowance.
  assert.equal((await create(editor)).version,1);
});

test("concurrent creations never spend more credits than exist",async()=>{
  await platformChange({"quotas.weeklyFreeDocuments":0});
  const subject=subjectOf({accountId:owner.accountId});
  await buyCredits(subject,3);
  const results=await Promise.allSettled(Array.from({length:6},()=>create()));
  assert.equal(results.filter(r=>r.status==="fulfilled").length,3);
  assert(results.filter(r=>r.status==="rejected").every(r=>r.reason.code==="ENTITLEMENT_REQUIRED"));
  assert.equal(await credits(subject),0);
  assert.equal(await documentCount(),3);
  const ledger=(await asWorker(tx=>tx.query("SELECT kind,delta,balance_after FROM dge_billing.credit_ledger ORDER BY created_at,balance_after DESC"))).rows;
  assert.deepEqual(ledger.map(e=>[e.kind,e.delta,e.balance_after]),[["purchase",3,3],["reserve",-1,2],["reserve",-1,1],["reserve",-1,0]]);
  // Workspace credits are used after the creator's own credits.
  await buyCredits(subjectOf({tenantId}),1);
  await create(editor);
  assert.equal(await credits(subjectOf({tenantId})),0);
  await assert.rejects(create(editor),{code:"ENTITLEMENT_REQUIRED"});
});

test("weekly boundaries follow the configured time zone across a daylight-saving change",async()=>{
  await platformChange({"quotas.weekTimeZone":"America/New_York"});
  now=Date.UTC(2026,2,9,3,30);// Sunday 8 March 2026, 23:30 EDT (clocks moved forward that morning)
  await create();
  now=Date.UTC(2026,2,9,3,59,59);
  await assert.rejects(create(),{code:"ENTITLEMENT_REQUIRED"});
  assert.equal((await entitlements.status(owner)).allowance.resetsAt,"2026-03-09T04:00:00.000Z");
  now=Date.UTC(2026,2,9,4,0,0);// Monday 00:00 local
  await create();
  assert.equal((await entitlements.status(owner)).allowance.periodStart,"2026-03-09T04:00:00.000Z");
  // In UTC the same instants would fall in one week; the zone decides.
  await platformChange({"quotas.weekTimeZone":"UTC"});
  now=Date.UTC(2026,2,9,4,30);
  await assert.rejects(create(),{code:"ENTITLEMENT_REQUIRED"});
});

test("a failed creation leaves no charge and an administrator refund happens exactly once",async()=>{
  await platformChange({"quotas.weeklyFreeDocuments":0});
  const subject=subjectOf({accountId:owner.accountId});
  await buyCredits(subject,2);
  const full=createDocumentStore({identity,transaction,entitlements,maxStoredBytes:1});
  await assert.rejects(create(owner,full),{code:"STORAGE_LIMIT_REACHED"});
  const existing=newDocument();
  await create(owner,documents,randomUUID(),existing);
  await assert.rejects(create(owner,documents,randomUUID(),existing),{code:"DOCUMENT_ID_EXISTS"});
  assert.equal(await credits(subject),1);
  assert.equal(await usageCount(),1);
  const [usage]=(await entitlements.tenantStatus(owner,tenantId)).usage;
  assert.equal(usage.source,"credits");
  const refunds=await Promise.all([1,2,3].map(()=>entitlements.refundCreation(admin,{usageId:usage.id,reason:"Import failed after commit"})));
  assert.equal(refunds.filter(r=>r.refunded).length,1);
  assert.equal(refunds.filter(r=>r.alreadyRefunded).length,2);
  assert.equal(await credits(subject),2);
  assert.equal((await asWorker(tx=>tx.query("SELECT count(*)::int AS n FROM dge_billing.credit_ledger WHERE kind='refund'"))).rows[0].n,1);
  assert.equal((await entitlements.tenantStatus(owner,tenantId)).usage[0].refundedAt,new Date(now).toISOString());
  await assert.rejects(entitlements.refundCreation(owner,{usageId:usage.id,reason:"Self service"}),{code:"PLATFORM_ADMIN_REQUIRED"});
  await assert.rejects(asWorker(tx=>tx.query("DELETE FROM dge_billing.usage_refunds")),/permission denied/);
  await assert.rejects(db.query("DELETE FROM dge_billing.usage_refunds"),/Append-only/);
  await assert.rejects(db.query("UPDATE dge_billing.grants SET quantity=99"),/append-only/);
  await assert.rejects(asWorker(tx=>tx.query("UPDATE dge_billing.credit_ledger SET delta=5")));
});

test("idempotency keys replay identical requests and reject different reuse",async()=>{
  const commandId=randomUUID(),document=newDocument();
  const first=await create(owner,documents,commandId,document);
  assert.deepEqual(await create(owner,documents,commandId,document),first);
  assert.equal(await usageCount(),1);
  const key=randomUUID();
  const subject={kind:"account",id:editor.accountId};
  const created=await grant({subject,quantity:5,period:"month",idempotencyKey:key});
  assert.equal(created.replayed,false);
  const again=await grant({subject,quantity:5,period:"month",idempotencyKey:key});
  assert.deepEqual([again.replayed,again.grant.id],[true,created.grant.id]);
  await assert.rejects(grant({subject,quantity:6,period:"month",idempotencyKey:key}),{code:"IDEMPOTENCY_KEY_REUSED",status:409});
  const purchase=randomUUID(),account=subjectOf({accountId:owner.accountId});
  await buyCredits(account,2,purchase);
  await buyCredits(account,2,purchase);
  assert.equal(await credits(account),2);
  await assert.rejects(buyCredits(account,3,purchase),{code:"IDEMPOTENCY_KEY_REUSED"});
  await assert.rejects(buyCredits(subjectOf({accountId:editor.accountId}),2,purchase),{code:"IDEMPOTENCY_KEY_REUSED"});
});

test("verified-official grants are unlimited by default, cap monthly when configured and expire with the term",async()=>{
  await platformChange({"quotas.weeklyFreeDocuments":0,"officials.heavyUseMonthlyThreshold":3});
  await assert.rejects(grant({subject:{kind:"account",id:owner.accountId},period:"none",provenance:"verified-official"}),{code:"OFFICIAL_GRANT_REQUIRES_MONTHLY_TERM"});
  const term=new Date(Date.UTC(2026,3,15)).toISOString();
  const official=(await grant({subject:{kind:"account",id:owner.accountId},period:"month",provenance:"verified-official",expiresAt:term,reason:"Verified county commissioner"})).grant;
  assert.equal(official.unlimited,true);
  for(let i=0;i<3;i++)await create();
  let status=await entitlements.status(owner);
  assert.equal(status.official.usedThisMonth,3);
  assert.deepEqual(status.paidOffer,{reason:"official-heavy-use",automaticCharge:false});
  await create();// heavy use only produces an offer; creation continues
  await platformChange({"officials.grantPolicy":{mode:"monthly-cap",monthlyCap:4}});
  await assert.rejects(create(),{code:"ENTITLEMENT_REQUIRED"});
  status=await entitlements.status(owner);
  assert.deepEqual(status.paidOffer,{reason:"official-monthly-cap-reached",automaticCharge:false});
  now=Date.UTC(2026,3,2,12);// next month: the cap resets
  await create();
  now=Date.UTC(2026,3,15,0,0,1);
  await assert.rejects(create(),{code:"ENTITLEMENT_REQUIRED"});
  status=await entitlements.status(owner);
  assert.equal(status.grants.find(g=>g.id===official.id).state,"expired");
  assert.equal(status.official,null);
  assert.equal(await documentCount(),5);
});

test("paid/free policy changes and expiring subscriptions never remove reading, discussion or voting",async()=>{
  const first=await create();
  await platformChange({"quotas.weeklyFreeDocuments":0});
  now+=7*86400000;
  await assert.rejects(create(),{code:"ENTITLEMENT_REQUIRED"});
  const subscription=await asWorker(tx=>entitlements.within.grantPeriod(tx,subjectOf({accountId:owner.accountId}),{quantity:null,
    effectiveAt:new Date(now-1000),expiresAt:new Date(now+86400000),provenanceRef:"test:sub_1",idempotencyKey:"test:invoice:1",at:new Date(now)}));
  const second=await create();
  assert.equal((await entitlements.status(owner)).grants.find(g=>g.id===subscription.id).state,"active");
  now+=2*86400000;
  await assert.rejects(create(),{code:"ENTITLEMENT_REQUIRED"});
  // Existing documents and participation stay intact for everyone.
  assert.equal((await plain.read(participant,tenantId,first.document.id)).version,1);
  const proposals=createProposalStore({identity,transaction}),decisions=createDecisionStore({identity});
  const proposal=await proposals.create(participant,tenantId,second.document.id,{baseVersion:1,
    selection:{blockId:second.document.content[0].id,start:24,end:32,quote:"annually"},replacement:"quarterly",
    rationale:"Timely reporting.",commandId:randomUUID(),disclosure:"publish-proposal-v1"});
  await decisions.open(owner,tenantId,second.document.id,proposal.proposal.id,{commandId:randomUUID(),hours:1});
  const ballot=await decisions.cast(participant,tenantId,second.document.id,proposal.proposal.id,{choice:"yes",expectedVersion:0,commandId:randomUUID()});
  assert.equal(ballot.version,1);
  await platformChange({"quotas.weeklyFreeDocuments":1});
  await create();
  assert.equal(await documentCount(),3);
});

test("consumption order is configurable and entitlement data stays isolated per account and workspace",async()=>{
  const account=subjectOf({accountId:owner.accountId});
  await buyCredits(account,1);
  await platformChange({"entitlements.consumptionOrder":["credits","grants","weekly-allowance"]});
  await create();
  assert.equal(await credits(account),0);
  assert.equal((await entitlements.status(owner)).allowance.used,0);
  await grant({subject:{kind:"tenant",id:tenantId},quantity:2,period:"week",provenance:"enterprise-license"});
  await create(editor);
  const usage=(await entitlements.tenantStatus(owner,tenantId)).usage;
  assert.deepEqual(usage.map(u=>u.source).sort(),["credits","grants"]);
  const other=await entitlements.status(outsider);
  assert.deepEqual([other.credits,other.grants.length],[0,0]);
  await assert.rejects(entitlements.tenantStatus(participant,tenantId),{code:"ACCESS_DENIED"});
  await assert.rejects(entitlements.tenantStatus(outsider,tenantId),{code:"ACCESS_DENIED"});
  const visible=await transaction(async tx=>{
    await tx.query("SELECT set_config('dge.account_id',$1,true)",[outsider.accountId]);
    return (await tx.query("SELECT (SELECT count(*)::int FROM dge_billing.grants) AS grants,(SELECT count(*)::int FROM dge_billing.credit_ledger) AS ledger,(SELECT count(*)::int FROM dge_billing.usage) AS usage")).rows[0];
  });
  assert.deepEqual(visible,{grants:0,ledger:0,usage:0});
  await assert.rejects(grant({subject:{kind:"account",id:owner.accountId}},owner),{code:"PLATFORM_ADMIN_REQUIRED"});
});

test("entitlement routes enforce platform administration and return status",async()=>{
  const handler=createAccountHandler({store:identity,login:{},origin,extensions:[createBillingRoutes({entitlements,billing:{}})]});
  const call=(path,{who=owner,method="GET",body}={})=>handler(new Request(origin+path,{method,
    headers:{cookie:"__Host-dge_session="+who.sessionToken,origin,"x-dge-csrf":who.csrfToken,...(body?{"content-type":"application/json"}:{})},
    ...(body?{body:JSON.stringify(body)}:{})}),{peerAddress:"127.0.0.1"});
  let response=await call("/api/entitlements");
  assert.equal((await response.json()).allowance.limit,1);
  const body={subject:{kind:"tenant",id:tenantId},quantity:10,period:"month",provenance:"enterprise-license",reason:"Annual contract 2026",idempotencyKey:"contract-2026-0001"};
  response=await call("/api/entitlements/grants",{method:"POST",body});
  assert.deepEqual([response.status,(await response.json()).error],[403,"PLATFORM_ADMIN_REQUIRED"]);
  response=await call("/api/entitlements/grants",{who:admin,method:"POST",body});
  const created=(await response.json()).grant;
  assert.equal(created.provenance,"enterprise-license");
  response=await call("/api/workspaces/"+tenantId+"/entitlements");
  assert.equal((await response.json()).grants[0].id,created.id);
  response=await call("/api/entitlements/grants/"+created.id+"/revoke",{who:admin,method:"POST",body:{reason:"Contract ended"}});
  assert.equal((await response.json()).grant.state,"revoked");
  response=await call("/api/entitlements/grants/"+created.id+"/revoke",{who:admin,method:"POST",body:{reason:"Again"}});
  assert.equal(response.status,409);
  response=await call("/api/workspaces/"+tenantId+"/entitlements",{who:participant});
  assert.equal(response.status,403);
});

test("an unlimited, never-expiring grant covers repeated creations",async()=>{
  const {randomUUID:id}=await import("node:crypto");
  const {PGlite:Lite}=await import("@electric-sql/pglite");
  const {createIdentityStore:identityStore,applyIdentityMigrations:migrate}=await import("../server/identity-store.mjs");
  const {createPlatform}=await import("../server/platform.mjs");
  const {changePlatformAdmin}=await import("../scripts/grant-platform-admin.mjs");
  const {createLegalDocument:legal}=await import("../src/legal-structure.mjs");
  const lite=await Lite.create();await migrate(fn=>lite.transaction(fn));
  const origin="https://quill.example";
  const tx=fn=>lite.transaction(async t=>{await t.exec("SET LOCAL ROLE dge_identity_runtime");return fn(t);});
  const ids=identityStore({transaction:tx,origin,sessionKey:(await import("node:crypto")).randomBytes(32),stateKey:(await import("node:crypto")).randomBytes(32)});
  const platform=createPlatform({identity:ids,transaction:tx,login:{},origin});
  const session=async()=>({...await ids.establishSession({issuer:"https://id.example",subject:id(),authenticatedAt:Date.now()}),origin});
  const admin=await session(),author=await session();
  await changePlatformAdmin(fn=>lite.transaction(fn),{action:"grant",accountId:admin.accountId,reason:"Test administrator"});
  await platform.services.entitlements.createGrant(admin,{subject:{kind:"account",id:author.accountId},resource:"document-create",quantity:null,period:"none",provenance:"administrator",reason:"Unlimited drafting",idempotencyKey:"unlimited-author"});
  const {tenantId}=await ids.createTenant(author);
  for(let i=0;i<3;i++){
    const document=structuredClone(legal({id:id(),tenantId,title:"Draft "+i}));
    await platform.services.documents.create(author,tenantId,{document,commandId:id(),disclosure:"publish-all-revisions-v1"});
  }
  await lite.close();
});
