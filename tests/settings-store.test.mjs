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
import {createSettingsRoutes,settingsBodyLimit} from "../server/settings-http.mjs";
import {createAccountHandler} from "../server/account-http.mjs";
import {HARD_INVARIANTS} from "../src/settings-registry.mjs";
import {changePlatformAdmin} from "../scripts/grant-platform-admin.mjs";

const origin="https://quill.example";
let db,identity,documents,settings,tenantId,people,document,handler;
const transaction=fn=>db.transaction(async tx=>{await tx.exec("SET LOCAL ROLE dge_identity_runtime");return fn(tx);});
const migrationTransaction=fn=>db.transaction(fn);
const user=async()=>({...await identity.establishSession({issuer:"https://provider.example",subject:randomUUID(),authenticatedAt:Date.now()}),origin});
const platform={scope:"platform"},product={scope:"product",product:"charter"};
const tenant=()=>({scope:"tenant",tenantId});
const doc=()=>({scope:"document",tenantId,documentId:document.id});

before(async()=>{db=await PGlite.create();await applyIdentityMigrations(migrationTransaction);});
after(async()=>db?.close());
beforeEach(async()=>{
  await db.exec("TRUNCATE dge_identity.accounts,dge_identity.tenants,dge_identity.login_challenges CASCADE");
  identity=createIdentityStore({transaction,origin,sessionKey:randomBytes(32),stateKey:randomBytes(32)});
  documents=createDocumentStore({identity,transaction});
  settings=createSettingsStore({identity,transaction,product:"civic"});
  people={};
  for(const name of ["owner","admin","editor","participant","viewer","outsider","platformAdmin"])people[name]=await user();
  ({tenantId}=await identity.createTenant(people.owner));
  for(const role of ["admin","editor","participant","viewer"]){
    const invite=await identity.invite(people.owner,tenantId,people[role].accountId,role);
    await identity.acceptInvitation(people[role],tenantId,invite.invitationToken);
  }
  await changePlatformAdmin(migrationTransaction,{action:"grant",accountId:people.platformAdmin.accountId,reason:"Operations on-call"});
  document=structuredClone(createLegalDocument({id:randomUUID(),tenantId,title:"Settings test"}));
  document.content[0].inlines=[{kind:"text",text:"The agency shall report annually."}];
  await documents.create(people.owner,tenantId,{document,commandId:randomUUID(),disclosure:"publish-all-revisions-v1"});
  handler=createAccountHandler({store:identity,login:{},origin,extensions:[createSettingsRoutes({settings})]});
});
const change=(who,target,changes,expectedVersion=0,reason="Policy review")=>settings.change(who,target,{changes,expectedVersion,reason});
const openDecision=async()=>{
  const proposals=createProposalStore({identity,transaction}),decisions=createDecisionStore({identity});
  const proposal=await proposals.create(people.participant,tenantId,document.id,{baseVersion:1,
    selection:{blockId:document.content[0].id,start:24,end:32,quote:"annually"},replacement:"quarterly",
    rationale:"Timely reporting.",commandId:randomUUID(),disclosure:"publish-proposal-v1"});
  await decisions.open(people.owner,tenantId,document.id,proposal.proposal.id,{commandId:randomUUID(),hours:1});
  return {decisions,proposalId:proposal.proposal.id};
};

test("permission matrix: platform/product need a listed administrator, workspace and document scopes follow roles",async()=>{
  const allowed={
    platform:["platformAdmin"],product:["platformAdmin"],
    tenant:["owner","admin"],document:["owner","admin","editor"],
  };
  const targets={platform,product,tenant:tenant(),document:doc()};
  const keys={platform:"abuse.requestsPerMinute",product:"quotas.weeklyFreeDocuments",tenant:"points.rankingProfile",document:"notifications.defaults"};
  const values={platform:[200,300,400],product:[2,3,4],tenant:["net-votes","chronological","wilson-lower-bound"],
    document:[{proposals:false,decisions:true,discussion:true,digest:"daily"},{proposals:true,decisions:true,discussion:true,digest:"none"},{proposals:false,decisions:false,discussion:false,digest:"none"}]};
  for(const [scope,target] of Object.entries(targets)){
    let version=0;
    for(const name of Object.keys(people)){
      const permitted=allowed[scope].includes(name);
      const member=!["outsider","platformAdmin"].includes(name);
      const readable=scope==="platform"||scope==="product"||member;
      if(readable)assert.equal((await settings.read(people[name],target)).target.scope,scope,scope+" read by "+name);
      else await assert.rejects(settings.read(people[name],target),{code:"ACCESS_DENIED"},scope+" read by "+name);
      const attempt=change(people[name],target,{[keys[scope]]:values[scope][version%3]},version);
      if(permitted){const result=await attempt;version=result.version;assert.equal(result.actorId,people[name].accountId);}
      else await assert.rejects(attempt,error=>["ACCESS_DENIED","PLATFORM_ADMIN_REQUIRED"].includes(error.code),scope+" change by "+name);
      const simulation=settings.simulate(people[name],target,{changes:{[keys[scope]]:values[scope][2]},expectedVersion:version});
      if(permitted)assert.equal((await simulation).valid,true);else await assert.rejects(simulation);
      const history=settings.history(people[name],target);
      if(permitted)assert.equal((await history).items.length,version);else await assert.rejects(history);
    }
    assert.equal(version,allowed[scope].length);
  }
  await assert.rejects(settings.read({sessionToken:undefined},platform),{code:"AUTHENTICATION_REQUIRED"});
  await changePlatformAdmin(migrationTransaction,{action:"revoke",accountId:people.platformAdmin.accountId,reason:"Rotation ended"});
  await assert.rejects(change(people.platformAdmin,platform,{"abuse.requestsPerMinute":500},1),{code:"PLATFORM_ADMIN_REQUIRED"});
  const stale=createSettingsStore({identity,transaction,clock:()=>Date.now()+301000});
  await changePlatformAdmin(migrationTransaction,{action:"grant",accountId:people.platformAdmin.accountId,reason:"Rotation resumed"});
  await assert.rejects(stale.change(people.platformAdmin,platform,{changes:{"abuse.requestsPerMinute":500},expectedVersion:1,reason:"Late"}),{code:"REAUTHENTICATION_REQUIRED"});
  const events=(await db.query("SELECT kind FROM dge_settings.platform_admin_events ORDER BY occurred_at")).rows.map(row=>row.kind);
  assert.deepEqual(events,["granted","revoked","granted"]);
  await assert.rejects(transaction(tx=>tx.query("INSERT INTO dge_settings.platform_admins(account_id,granted_at,granted_reason) VALUES($1,now(),'self service')",[people.outsider.accountId])));
});

test("dangerous settings fail closed at every scope and active votes lock document vote rules",async()=>{
  for(const [who,target] of [[people.platformAdmin,platform],[people.platformAdmin,product],[people.owner,tenant()],[people.owner,doc()]])
    for(const rule of HARD_INVARIANTS)
      await assert.rejects(change(who,target,{[rule.key]:rule.value}),{code:rule.code,status:403});
  await assert.rejects(change(people.owner,doc(),{"anchoring.enabled":false}),{code:"INVARIANT_PUBLIC_ANCHORING_REQUIRED"});
  const organizationLevel=await change(people.owner,tenant(),{"anchoring.enabled":false});
  assert.equal(organizationLevel.version,1);
  assert.deepEqual((await settings.read(people.viewer,doc())).effective["anchoring.enabled"],{value:true,source:"invariant",locked:true});
  await assert.rejects(change(people.owner,tenant(),{"billing.catalog":[]},1),{code:"SETTING_SCOPE_NOT_ALLOWED",status:403});
  await assert.rejects(change(people.owner,tenant(),{"quotas.weeklyFreeDocuments":100},1),{code:"SETTING_SCOPE_NOT_ALLOWED"});
  await assert.rejects(change(people.owner,tenant(),{"roles.capabilities":{owner:["read"],admin:["read"],editor:["read"],participant:["read"],viewer:["read"]}},1),{code:"INVALID_SETTING_VALUE"});
  await assert.rejects(change(people.owner,tenant(),{"unknown.setting":1},1),{code:"UNKNOWN_SETTING"});
  const {decisions,proposalId}=await openDecision();
  const frozen=await decisions.read(people.owner,tenantId,document.id,proposalId);
  await assert.rejects(change(people.owner,doc(),{"votes.quorumFraction":"0.75"}),{code:"SETTING_LOCKED_ACTIVE_VOTE",status:409});
  const read=await settings.read(people.owner,doc());
  assert.equal(read.activeVote,true);
  assert(!read.editableKeys.includes("votes.quorumFraction"));
  assert(read.editableKeys.includes("notifications.defaults"));
  const simulation=await settings.simulate(people.owner,tenant(),{changes:{"votes.quorumFraction":"0.75"},expectedVersion:1});
  assert.equal(simulation.affected.openDecisions,1);
  assert.match(simulation.frozenDecisionNotice,/frozen policy/);
  await change(people.owner,tenant(),{"votes.quorumFraction":"0.75"},1);
  assert.deepEqual(await decisions.read(people.owner,tenantId,document.id,proposalId),frozen);
});

test("concurrent changes: exactly one writer wins an expected version",async()=>{
  const results=await Promise.allSettled([
    change(people.owner,tenant(),{"points.rankingProfile":"net-votes"}),
    change(people.admin,tenant(),{"points.rankingProfile":"chronological"}),
  ]);
  assert.equal(results.filter(r=>r.status==="fulfilled").length,1);
  assert.equal(results.find(r=>r.status==="rejected").reason.code,"SETTINGS_VERSION_CONFLICT");
  await assert.rejects(change(people.owner,tenant(),{"points.rankingProfile":"net-votes"},0),{code:"SETTINGS_VERSION_CONFLICT",status:409});
  const platformRace=await Promise.allSettled([1,2,3].map(n=>change(people.platformAdmin,platform,{"abuse.pointsPerHour":10+n})));
  assert.equal(platformRace.filter(r=>r.status==="fulfilled").length,1);
});

test("simulation previews effective diffs, affected counts and validation errors without writing",async()=>{
  const preview=await settings.simulate(people.owner,tenant(),{changes:{"votes.deliberationHours":24,"points.rankingProfile":"net-votes"},expectedVersion:0});
  assert.equal(preview.valid,true);
  assert.equal(preview.stale,false);
  assert.deepEqual(preview.affected,{scope:"tenant",documents:1,openDecisions:0});
  assert.deepEqual(preview.diff.map(d=>[d.key,d.before.source,d.after.source,d.after.value]),
    [["votes.deliberationHours","default","tenant",24],["points.rankingProfile","default","tenant","net-votes"]]);
  assert.equal(preview.frozenDecisionNotice,null);
  assert.equal((await settings.history(people.owner,tenant())).items.length,0);
  const invalid=await settings.simulate(people.owner,tenant(),{changes:{"votes.deliberationHours":-1,"invariants.signedContentImmutable":false},expectedVersion:0});
  assert.equal(invalid.valid,false);
  assert.deepEqual(invalid.errors.map(e=>e.code).sort(),["INVALID_SETTING_VALUE","INVARIANT_SIGNED_CONTENT_IMMUTABLE"]);
  await change(people.owner,tenant(),{"votes.deliberationHours":12});
  assert.equal((await settings.simulate(people.owner,tenant(),{changes:{"votes.deliberationHours":24},expectedVersion:0})).stale,true);
  const platformPreview=await settings.simulate(people.platformAdmin,platform,{changes:{"votes.deliberationHours":48},expectedVersion:0});
  assert.deepEqual(platformPreview.affected,{scope:"deployment",tenants:1,documents:1,openDecisions:0});
  assert.equal(platformPreview.diff[0].after.source,"platform");
  // The tenant override shadows the platform value inside the workspace.
  const shadowed=await settings.read(people.viewer,tenant());
  assert.deepEqual(shadowed.effective["votes.deliberationHours"],{value:12,source:"tenant",locked:false});
});

test("effective values name their source across platform, product, workspace and document layers",async()=>{
  const key="notifications.defaults";
  const value=digest=>({proposals:true,decisions:true,discussion:false,digest});
  assert.equal((await settings.read(people.viewer,doc())).effective[key].source,"default");
  await change(people.platformAdmin,platform,{[key]:value("daily")});
  await change(people.platformAdmin,{scope:"product",product:"civic"},{[key]:value("none")});
  await change(people.platformAdmin,product,{[key]:value("weekly")});
  assert.deepEqual((await settings.read(people.viewer,doc())).effective[key],{value:value("none"),source:"product:civic",locked:false});
  assert.equal((await settings.read(people.outsider,product)).effective[key].source,"product:charter");
  await change(people.owner,tenant(),{[key]:value("daily")});
  await change(people.editor,doc(),{[key]:value("weekly")});
  assert.equal((await settings.read(people.viewer,doc())).effective[key].source,"document");
  await change(people.editor,doc(),{[key]:null},1);
  const read=await settings.read(people.viewer,doc());
  assert.deepEqual(read.effective[key],{value:value("daily"),source:"tenant",locked:false});
  assert.deepEqual(read.overrides,{});
  assert.equal(read.version,2);
  assert.equal((await settings.read(people.viewer,doc())).effective["invariants.cryptoProfile"].source,"invariant");
});

test("rollback creates a new version and history is an append-only, verifiable chain",async()=>{
  await change(people.owner,tenant(),{"votes.challengeHours":24},0,"Shorter challenge window");
  await change(people.owner,tenant(),{"votes.challengeHours":72,"points.rankingProfile":"net-votes"},1,"Board resolution 12");
  const rolled=await settings.rollback(people.owner,tenant(),{toVersion:1,expectedVersion:2,reason:"Revert resolution 12"});
  assert.equal(rolled.version,3);
  assert.equal(rolled.rollbackOf,1);
  assert.deepEqual(rolled.changes,{"votes.challengeHours":24,"points.rankingProfile":null});
  const history=await settings.history(people.admin,tenant());
  assert.equal(history.verified,true);
  assert.deepEqual(history.items.map(i=>[i.version,i.reason]),[[3,"Revert resolution 12"],[2,"Board resolution 12"],[1,"Shorter challenge window"]]);
  assert.equal(history.items[0].previousDigest,history.items[1].digest);
  assert.equal((await settings.read(people.viewer,tenant())).effective["votes.challengeHours"].value,24);
  await assert.rejects(settings.rollback(people.owner,tenant(),{toVersion:3,expectedVersion:3,reason:"Self"}),{code:"SETTINGS_VERSION_NOT_FOUND"});
  await assert.rejects(settings.rollback(people.owner,tenant(),{toVersion:1,expectedVersion:3,reason:"Same values"}),{code:"NO_SETTINGS_CHANGE"});
  const paged=await settings.history(people.admin,tenant(),{limit:2});
  assert.equal(paged.verified,true);assert.equal(paged.nextBefore,2);
  assert.equal((await settings.history(people.admin,tenant(),{before:2})).verified,true);
  await assert.rejects(transaction(async tx=>{await tx.query("SELECT set_config('dge.tenant_id',$1,true)",[tenantId]);await tx.query("UPDATE dge_settings.versions SET reason='edited'");}));
  await assert.rejects(transaction(async tx=>{await tx.query("SELECT set_config('dge.tenant_id',$1,true)",[tenantId]);await tx.query("DELETE FROM dge_settings.versions");}));
  await assert.rejects(db.query("UPDATE dge_settings.versions SET reason='edited' WHERE version=2"),/Append-only/);
  await db.exec("ALTER TABLE dge_settings.versions DISABLE TRIGGER versions_append_only");
  await db.query("UPDATE dge_settings.versions SET overrides='{\"votes.challengeHours\":1}' WHERE version=2");
  await db.exec("ALTER TABLE dge_settings.versions ENABLE TRIGGER versions_append_only");
  assert.equal((await settings.history(people.admin,tenant())).verified,false);
});

test("tenant isolation: another workspace cannot read or append to this workspace's layers",async()=>{
  await change(people.owner,tenant(),{"points.rankingProfile":"net-votes"});
  const {tenantId:other}=await identity.createTenant(people.outsider);
  assert.equal((await settings.read(people.outsider,{scope:"tenant",tenantId:other})).effective["points.rankingProfile"].source,"default");
  const visible=await transaction(async tx=>{await tx.query("SELECT set_config('dge.tenant_id',$1,true)",[other]);return (await tx.query("SELECT count(*)::int AS n FROM dge_settings.versions")).rows[0].n;});
  assert.equal(visible,0);
  await assert.rejects(transaction(async tx=>{
    await tx.query("SELECT set_config('dge.tenant_id',$1,true)",[other]);
    await tx.query("SELECT set_config('dge.account_id',$1,true)",[people.outsider.accountId]);
    await tx.query("INSERT INTO dge_settings.versions(target,version,scope,tenant_id,overrides,changes,reason,actor_id,created_at,digest) VALUES($1,2,'tenant',$2,'{}','{}','x',$3,now(),$4)",
      ["tenant:"+tenantId,tenantId,people.outsider.accountId,"0".repeat(64)]);
  }));
  await assert.rejects(transaction(async tx=>{
    await tx.query("SELECT set_config('dge.account_id',$1,true)",[people.outsider.accountId]);
    await tx.query("INSERT INTO dge_settings.versions(target,version,scope,overrides,changes,reason,actor_id,created_at,digest) VALUES('platform',1,'platform','{}','{}','x',$1,now(),$2)",[people.outsider.accountId,"0".repeat(64)]);
  }));
  await assert.rejects(transaction(tx=>tx.query("SELECT * FROM dge_settings.platform_impact()").then(r=>{if(!r.rows.length)throw Error("no impact rows");})));
});

test("HTTP routes expose read, simulate, change, history and rollback at each scope",async()=>{
  const call=(path,{who=people.owner,method="GET",body}={})=>handler(new Request(origin+path,{method,
    headers:{cookie:"__Host-dge_session="+who.sessionToken,origin,"x-dge-csrf":who.csrfToken,...(body?{"content-type":"application/json"}:{})},
    ...(body?{body:JSON.stringify(body)}:{})}),{peerAddress:"127.0.0.1"});
  const base="/api/workspaces/"+tenantId;
  let response=await call(base+"/settings");
  assert.equal(response.status,200);
  assert.equal((await response.json()).effective["points.rankingProfile"].source,"default");
  response=await call(base+"/settings/simulate",{method:"POST",body:{changes:{"points.rankingProfile":"net-votes"},expectedVersion:0}});
  assert.equal((await response.json()).diff.length,1);
  response=await call(base+"/settings",{method:"POST",body:{changes:{"points.rankingProfile":"net-votes"},expectedVersion:0,reason:"Trial"}});
  assert.equal(response.status,200);assert.equal((await response.json()).version,1);
  response=await call(base+"/settings",{method:"POST",body:{changes:{"points.rankingProfile":"chronological"},expectedVersion:0,reason:"Race"}});
  assert.deepEqual([response.status,(await response.json()).error],[409,"SETTINGS_VERSION_CONFLICT"]);
  response=await call(base+"/settings",{who:people.viewer,method:"POST",body:{changes:{"points.rankingProfile":"chronological"},expectedVersion:1,reason:"No"}});
  assert.equal(response.status,403);
  response=await call(base+"/documents/"+document.id+"/settings",{method:"POST",body:{changes:{"invariants.publicInputImmutable":false},expectedVersion:0,reason:"No"}});
  assert.deepEqual([response.status,(await response.json()).error],[403,"INVARIANT_PUBLIC_INPUT_IMMUTABLE"]);
  response=await call(base+"/settings/history?limit=10");
  assert.equal((await response.json()).items.length,1);
  response=await call("/api/settings?scope=product&product=charter",{who:people.outsider});
  assert.equal((await response.json()).target.product,"charter");
  response=await call("/api/settings",{who:people.platformAdmin,method:"POST",body:{scope:"product",product:"charter",changes:{"quotas.weeklyFreeDocuments":2},expectedVersion:0,reason:"Launch offer"}});
  assert.equal((await response.json()).version,1);
  response=await call("/api/settings/rollback",{who:people.platformAdmin,method:"POST",body:{scope:"product",product:"charter",toVersion:1,expectedVersion:1,reason:"Nothing"}});
  assert.equal(response.status,404);
  response=await call("/api/settings/history?scope=product&product=charter",{who:people.outsider});
  assert.deepEqual([response.status,(await response.json()).error],[403,"PLATFORM_ADMIN_REQUIRED"]);
  response=await call("/api/settings?scope=galaxy");
  assert.equal(response.status,400);
  assert.equal(settingsBodyLimit(base+"/settings"),65536);
  assert.equal(settingsBodyLimit("/api/other"),8192);
});
