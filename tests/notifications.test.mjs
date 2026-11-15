import {before,after,beforeEach,test} from "node:test";
import assert from "node:assert/strict";
import {randomUUID,randomBytes,generateKeyPairSync} from "node:crypto";
import {PGlite} from "@electric-sql/pglite";
import {createIdentityStore,applyIdentityMigrations} from "../server/identity-store.mjs";
import {createLegalDocument} from "../src/legal-structure.mjs";
import {createDocumentStore} from "../server/document-store.mjs";
import {createProposalStore} from "../server/proposal-store.mjs";
import {createDiscussionStore} from "../server/discussion-store.mjs";
import {createLedger,loadLogSigningKey} from "../server/ledger.mjs";
import {createNotificationStore,createNotificationTokens} from "../server/notification-store.mjs";
import {createNotificationWorker,nextDigestAt} from "../server/notification-worker.mjs";
import {createNotificationRoutes} from "../server/notification-http.mjs";
import {createAccountHandler} from "../server/account-http.mjs";
import {EmailDeliveryError,createPostmarkAdapter,postmarkFromEnvironment} from "../server/email-adapters/postmark.mjs";

const origin="https://quill.example";
let db,identity,documents,proposals,discussion,ledger,tokens,store,worker,handler,outbox,emailBehavior,now;
let owner,member,follower,tenantId;
const transaction=fn=>db.transaction(async tx=>{await tx.exec("SET LOCAL ROLE dge_identity_runtime");return fn(tx);});
const user=async()=>({...await identity.establishSession({issuer:"https://provider.example",subject:randomUUID(),authenticatedAt:Date.now()}),origin});
const publish=async(title,text="Body text.")=>{
  const document=structuredClone(createLegalDocument({id:randomUUID(),tenantId,title}));
  document.content[0].inlines=[{kind:"text",text}];
  return (await documents.create(owner,tenantId,{document,commandId:randomUUID(),disclosure:"publish-all-revisions-v1"})).document;
};
const revise=async(document,text,expectedVersion)=>{
  const next=structuredClone(document);next.revision+=1;next.content[0].inlines=[{kind:"text",text}];
  await documents.save(owner,tenantId,document.id,{document:next,commandId:randomUUID(),expectedVersion});
  return next;
};
const fakeEmail={id:"fake",send:async message=>{const outcome=emailBehavior(message);if(outcome instanceof Error)throw outcome;outbox.push(message);return {messageId:randomUUID()};}};
const build=({email=fakeEmail,maxAttempts=3}={})=>{
  store=createNotificationStore({identity,transaction,tokens,origin,email,clock:()=>now});
  worker=createNotificationWorker({transaction,store,email,origin,clock:()=>now,maxAttempts});
  handler=createAccountHandler({store:identity,login:{},origin,extensions:[createNotificationRoutes({notifications:store,origin})]});
};
const tick=async()=>{await ledger.sequence();return worker.tick();};
const deliveries=async()=>(await db.query("SELECT status,channel,cadence,attempts,last_error,next_attempt_at FROM dge_notifications.deliveries ORDER BY ledger_seq,channel")).rows;
const verifyAddress=async(who,address="person@example.org")=>{
  await store.setEmailAddress(who,{address});
  const link=outbox.pop().text.match(/verify-email#(\S+)/)[1];
  await store.verifyEmail({token:link});
};
const call=(path,{who,method="GET",body,headers={}}={})=>handler(new Request(origin+path,{method,headers:{
  ...(who?{cookie:"__Host-dge_session="+who.sessionToken,"x-dge-csrf":who.csrfToken}:{}),origin,
  ...(body!==undefined?{"content-type":"application/json"}:{}),...headers},...(body!==undefined?{body:JSON.stringify(body)}:{})}),{peerAddress:"127.0.0.1"});

before(async()=>{db=await PGlite.create();await applyIdentityMigrations(fn=>db.transaction(fn));});
after(async()=>db?.close());
beforeEach(async()=>{
  await db.exec("TRUNCATE dge_identity.accounts,dge_identity.tenants,dge_identity.login_challenges,dge_ledger.entries,dge_ledger.nodes,dge_ledger.checkpoints CASCADE");
  await db.exec(`ALTER TABLE dge_ledger.head DISABLE TRIGGER USER; UPDATE dge_ledger.head SET size=0; ALTER TABLE dge_ledger.head ENABLE TRIGGER USER;
    ALTER TABLE dge_notifications.worker_cursor DISABLE TRIGGER USER; UPDATE dge_notifications.worker_cursor SET ledger_seq=-1; ALTER TABLE dge_notifications.worker_cursor ENABLE TRIGGER USER`);
  now=Date.UTC(2026,10,14,12);
  identity=createIdentityStore({transaction,origin,sessionKey:randomBytes(32),stateKey:randomBytes(32)});
  documents=createDocumentStore({identity,transaction});
  proposals=createProposalStore({identity,transaction});
  discussion=createDiscussionStore({identity,transaction});
  const {privateKey}=generateKeyPairSync("ed25519");
  ledger=createLedger({transaction,logId:"quill.test",signingKey:loadLogSigningKey(privateKey.export({format:"der",type:"pkcs8"}).toString("base64")),clock:()=>now});
  tokens=createNotificationTokens({key:randomBytes(32),clock:()=>now});
  outbox=[];emailBehavior=()=>null;
  build();
  owner=await user();member=await user();follower=await user();
  ({tenantId}=await identity.createTenant(owner));
  const invite=await identity.invite(owner,tenantId,member.accountId,"participant");
  await identity.acceptInvitation(member,tenantId,invite.invitationToken);
});

test("subscriptions are permission-checked and private to their account",async()=>{
  const document=await publish("Transit plan");
  const proposal=await proposals.create(member,tenantId,document.id,{baseVersion:1,selection:{blockId:document.content[0].id,start:0,end:4,quote:"Body"},
    replacement:"Main",rationale:"Clearer.",commandId:randomUUID(),disclosure:"publish-proposal-v1"});
  const followed=await store.subscribe(follower,{targetKind:"document",targetId:document.id});
  assert.equal(followed.workspaceId,tenantId);assert.equal(followed.documentId,document.id);
  assert.deepEqual(await store.subscribe(follower,{targetKind:"document",targetId:document.id}),followed,"idempotent");
  const onProposal=await store.subscribe(follower,{targetKind:"proposal",targetId:proposal.proposal.id});
  assert.equal(onProposal.documentId,document.id);
  await assert.rejects(store.subscribe(follower,{targetKind:"workspace",targetId:tenantId}),{code:"ACCESS_DENIED"});
  assert.equal((await store.subscribe(member,{targetKind:"workspace",targetId:tenantId})).targetKind,"workspace");
  await assert.rejects(store.subscribe(follower,{targetKind:"document",targetId:randomUUID()}),{code:"DOCUMENT_NOT_FOUND"});
  await assert.rejects(store.subscribe(follower,{targetKind:"proposal",targetId:randomUUID()}),{code:"PROPOSAL_NOT_FOUND"});
  await assert.rejects(store.subscribe(follower,{targetKind:"tenant",targetId:tenantId}),{code:"INVALID_SUBSCRIPTION"});
  assert.equal((await store.subscriptions(follower)).items.length,2);
  assert.equal((await store.subscriptions(member)).items.length,1,"rows are visible only to their owner");
  await assert.rejects(store.unsubscribe(member,followed.id),{code:"SUBSCRIPTION_NOT_FOUND"});
  const limited=createNotificationStore({identity,transaction,tokens,origin,maxSubscriptions:2});
  await assert.rejects(limited.subscribe(follower,{targetKind:"document",targetId:(await publish("Third")).id}),{code:"SUBSCRIPTION_LIMIT_REACHED"});
  assert.equal((await call("/api/notifications/subscriptions")).status,401);
  const noCsrf=await call("/api/notifications/subscriptions",{who:follower,method:"POST",body:{targetKind:"document",targetId:document.id},headers:{"x-dge-csrf":""}});
  assert.equal(noCsrf.status,403);
  const viaHttp=await call("/api/notifications/subscriptions",{who:member,method:"POST",body:{targetKind:"document",targetId:document.id}});
  assert.equal(viaHttp.status,201);
  const removed=await call("/api/notifications/subscriptions/"+(await viaHttp.json()).id,{who:member,method:"DELETE",body:{}});
  assert.deepEqual(await removed.json(),{removed:true});
  const bad=await call("/api/notifications/subscriptions",{who:member,method:"POST",body:{targetKind:"document",targetId:document.id,extra:1}});
  assert.equal(bad.status,400);
});

test("fan-out reads the ledger after its cursor and never duplicates notices",async()=>{
  const document=await publish("Clean air act","Private draft phrase SECRETBODY must never be emailed.");
  await store.subscribe(follower,{targetKind:"document",targetId:document.id});
  await store.subscribe(member,{targetKind:"workspace",targetId:tenantId});
  await revise(document,"Second text SECRETBODY.",1);
  await ledger.sequence();
  const [first,second]=await Promise.all([worker.fanOut(),worker.fanOut()]);
  assert.equal(first.queued+second.queued,4,"two subscribers × two events, in-app only");
  assert.equal((await worker.fanOut()).entries,0);
  const result=await worker.tick();
  assert.equal(result.delivered,4);
  assert.equal((await worker.tick()).delivered,0,"re-running tick delivers nothing again");
  const inbox=await store.inbox(follower);
  assert.equal(inbox.items.length,2);assert.equal(inbox.unreadCount,2);
  assert.deepEqual(inbox.items.map(i=>i.items[0].eventKind),["document-version","document-version"]);
  assert.equal(inbox.items[0].items[0].title,"Clean air act");
  assert.doesNotMatch(JSON.stringify(inbox),/SECRETBODY/);
  assert.equal((await store.inbox(owner)).items.length,0,"non-subscribers get nothing");
  await assert.rejects(db.query("UPDATE dge_notifications.worker_cursor SET ledger_seq=0"),/backwards/);
});

test("proposal and discussion events reach proposal followers; blinded entries are skipped",async()=>{
  const document=await publish("Parks");
  const proposal=await proposals.create(member,tenantId,document.id,{baseVersion:1,selection:{blockId:document.content[0].id,start:0,end:4,quote:"Body"},
    replacement:"Main",rationale:"Clearer.",commandId:randomUUID(),disclosure:"publish-proposal-v1"});
  await store.subscribe(follower,{targetKind:"proposal",targetId:proposal.proposal.id});
  await discussion.create(member,tenantId,document.id,proposal.proposal.id,{position:"support",text:"Good change.",commandId:randomUUID(),disclosure:"publish-point-v1"});
  await db.query("INSERT INTO dge_ledger.outbox(id,tenant_id,kind,scope,subject_id,event_digest,created_at) VALUES($1,$2,'private-edition','blinded',$3,$4,now())",
    [randomUUID(),tenantId,document.id,"b".repeat(64)]);
  await tick();
  const kinds=(await store.inbox(follower)).items.map(i=>i.items[0].eventKind).sort();
  assert.deepEqual(kinds,["discussion-event","proposal"],"document version and blinded entries do not match a proposal follower");
});

test("unsubscribe, membership revocation and suspension take effect before delivery",async()=>{
  const document=await publish("Harbor");
  const subscription=await store.subscribe(follower,{targetKind:"document",targetId:document.id});
  await store.subscribe(member,{targetKind:"workspace",targetId:tenantId});
  const third=await user();
  await store.subscribe(third,{targetKind:"document",targetId:document.id});
  await revise(document,"Changed.",1);
  await ledger.sequence();await worker.fanOut();
  await store.unsubscribe(follower,subscription.id);
  await identity.changeMember(owner,tenantId,member.accountId,null);
  await db.query("UPDATE dge_identity.accounts SET status='suspended' WHERE id=$1",[third.accountId]);
  const result=await worker.deliver();
  assert.equal(result.delivered,0);
  assert.equal(result.suppressed,6);
  for(const who of [follower,member])assert.equal((await store.inbox(who)).items.length,0);
  const reasons=(await db.query("SELECT DISTINCT last_error FROM dge_notifications.deliveries ORDER BY 1")).rows.map(r=>r.last_error);
  assert.deepEqual(reasons,["access-ended","account-inactive"]);
});

test("a stale workspace permission granted at fan-out is re-checked at a later digest",async()=>{
  await store.updatePreferences(member,{inApp:"daily",email:"off",locale:"fr"});
  await store.subscribe(member,{targetKind:"workspace",targetId:tenantId});
  await publish("Budget one");await publish("Budget two");
  await tick();
  assert.equal((await store.inbox(member)).items.length,0,"digest not yet due");
  await identity.changeMember(owner,tenantId,member.accountId,null);
  now=nextDigestAt(new Date(now),"daily").getTime()+1000;
  const result=await worker.tick();
  assert.equal(result.suppressed,2);assert.equal((await store.inbox(member)).items.length,0);
});

test("digests group due items into one notice and one email",async()=>{
  await verifyAddress(follower);
  await store.updatePreferences(follower,{inApp:"weekly",email:"daily",locale:"en"});
  const a=await publish("Library hours","SECRETBODY text"),b=await publish("Road repair");
  await tick();
  for(const id of [a.id,b.id])await store.subscribe(follower,{targetKind:"document",targetId:id});
  await revise(a,"More SECRETBODY",1);await revise(b,"Fixed",1);
  const proposal=await proposals.create(member,tenantId,a.id,{baseVersion:2,selection:{blockId:a.content[0].id,start:0,end:4,quote:"More"},
    replacement:"Less",rationale:"Shorter.",commandId:randomUUID(),disclosure:"publish-proposal-v1"});
  assert.ok(proposal);
  await tick();
  assert.equal(outbox.length,0);
  now=nextDigestAt(new Date(now),"daily").getTime();
  const daily=await worker.tick();
  assert.equal(daily.delivered,3);assert.equal(outbox.length,1);
  const message=outbox[0];
  assert.equal(message.to,"person@example.org");
  assert.equal(message.subject,"Your daily digest: 3 updates");
  assert.match(message.text,/New version of Library hours\n- New proposal on Library hours\n  https:\/\/quill\.example\/\?document=/);
  assert.match(message.text,/New version of Road repair/);
  assert.doesNotMatch(message.text,/SECRETBODY|Shorter|Less/,"emails carry titles, kinds and links only");
  assert.match(message.headers["List-Unsubscribe"],/^<https:\/\/quill\.example\/notifications\/unsubscribe#n1\./);
  assert.equal((await store.inbox(follower)).items.length,0,"weekly in-app digest not yet due");
  now=nextDigestAt(new Date(now),"weekly").getTime();
  await worker.tick();
  const inbox=await store.inbox(follower);
  assert.equal(inbox.items.length,1);assert.equal(inbox.items[0].kind,"digest");assert.equal(inbox.items[0].cadence,"weekly");
  assert.equal(inbox.items[0].items.length,3);
});

test("email delivery retries with backoff, dead-letters and never pretends success",async()=>{
  await verifyAddress(follower);
  await store.updatePreferences(follower,{inApp:"off",email:"immediate",locale:"en"});
  const document=await publish("Water");
  await tick();
  await store.subscribe(follower,{targetKind:"document",targetId:document.id});
  await revise(document,"Changed.",1);
  emailBehavior=()=>new EmailDeliveryError("provider-503");
  let result=await tick();
  assert.equal(result.failed,1);assert.equal(outbox.length,0);
  let [row]=await deliveries();
  assert.equal(row.status,"pending");assert.equal(row.attempts,1);assert.equal(row.last_error,"provider-503");
  assert.equal(new Date(row.next_attempt_at).getTime(),now+120000);
  assert.equal((await worker.tick()).failed,0,"not retried before its backoff");
  now+=120000;
  result=await worker.tick();
  assert.equal(result.failed,1);
  now+=240000;
  result=await worker.tick();
  assert.equal(result.dead,1,"third failure reaches maxAttempts");
  [row]=await deliveries();assert.equal(row.status,"dead");
  emailBehavior=()=>null;now+=86400000;
  assert.equal((await worker.tick()).delivered,0,"dead letters are not retried");
  await revise({...document,revision:1},"Again.",2);
  emailBehavior=()=>new EmailDeliveryError("provider-rejected-406",{permanent:true});
  assert.equal((await tick()).dead,1,"permanent rejection dead-letters immediately");

  build({email:null});
  await revise({...document,revision:2},"Third.",3);
  result=await tick();
  assert.equal(result.delivered,0);
  const pending=(await deliveries()).at(-1);
  assert.equal(pending.status,"pending");assert.equal(pending.last_error,"email-unavailable");
  await assert.rejects(store.setEmailAddress(follower,{address:"x@example.org"}),{code:"EMAIL_UNAVAILABLE"});
  await assert.rejects(store.updatePreferences(follower,{inApp:"off",email:"daily",locale:"en"}),{code:"EMAIL_UNAVAILABLE"});
});

test("email verification is required, rate limited and bound to the exact address",async()=>{
  await assert.rejects(store.updatePreferences(follower,{inApp:"immediate",email:"immediate",locale:"en"}),{code:"EMAIL_NOT_VERIFIED"});
  await assert.rejects(store.setEmailAddress(follower,{address:"not an address"}),{code:"INVALID_EMAIL_ADDRESS"});
  const sent=await store.setEmailAddress(follower,{address:"Person@Example.ORG"});
  assert.deepEqual(sent,{address:"Person@example.org",verified:false,verificationSent:true});
  const token=outbox.pop().text.match(/verify-email#(\S+)/)[1];
  await assert.rejects(store.setEmailAddress(follower,{address:"other@example.org"}),{code:"VERIFICATION_RATE_LIMITED"});
  now+=60000;
  await store.setEmailAddress(follower,{address:"other@example.org"});
  await assert.rejects(store.verifyEmail({token}),{code:"INVALID_TOKEN"},"a token for a replaced address no longer verifies");
  await store.verifyEmail({token:outbox.pop().text.match(/verify-email#(\S+)/)[1]});
  assert.deepEqual((await store.preferences(follower)).emailAddress,{address:"other@example.org",verified:true});
  assert.equal((await store.updatePreferences(follower,{inApp:"immediate",email:"weekly",locale:"ar"})).email,"weekly");
  emailBehavior=()=>new EmailDeliveryError("provider-500");now+=60000;
  await assert.rejects(store.setEmailAddress(follower,{address:"third@example.org"}),{code:"EMAIL_DELIVERY_FAILED"});
  assert.equal((await store.preferences(follower)).email,"off","changing the address turns email off until verified");
  await store.removeEmailAddress(follower);
  assert.equal((await store.preferences(follower)).emailAddress,null);
});

test("unsubscribe tokens are single-purpose, unforgeable, expiring and work without login",async()=>{
  const document=await publish("Zoning");
  const subscription=await store.subscribe(follower,{targetKind:"document",targetId:document.id});
  const token=store.unsubscribeToken(follower.accountId,{subscriptionId:subscription.id});
  const [,payload,mac]=token.split(".");
  const forgedPayload=Buffer.from(JSON.stringify({...JSON.parse(Buffer.from(payload,"base64url")),a:member.accountId})).toString("base64url");
  await assert.rejects(store.applyUnsubscribe({token:"n1."+forgedPayload+"."+mac}),{code:"INVALID_TOKEN"});
  const otherKey=createNotificationTokens({key:randomBytes(32),clock:()=>now});
  await assert.rejects(store.applyUnsubscribe({token:otherKey.sign("unsubscribe",{a:follower.accountId,s:subscription.id},60000)}),{code:"INVALID_TOKEN"});
  await assert.rejects(store.applyUnsubscribe({token:tokens.sign("verify-email",{a:follower.accountId,s:subscription.id},60000)}),{code:"INVALID_TOKEN"});
  const expiring=tokens.sign("unsubscribe",{a:follower.accountId,s:subscription.id},1000);
  now+=1000;
  await assert.rejects(store.applyUnsubscribe({token:expiring}),{code:"INVALID_TOKEN"});
  for(const bad of [null,"","n1.x.y","n1."+payload+"."+mac+"x"])await assert.rejects(store.applyUnsubscribe({token:bad}),{code:"INVALID_TOKEN"});
  assert.equal((await store.subscriptions(follower)).items.length,1);

  const preview=await call("/api/public/notifications/unsubscribe",{method:"POST",body:{token,preview:true}});
  assert.deepEqual(await preview.json(),{scope:"subscription"});
  assert.equal((await store.subscriptions(follower)).items.length,1,"preview has no effect");
  const crossSite=await call("/api/public/notifications/unsubscribe",{method:"POST",body:{token},headers:{origin:"https://evil.example"}});
  assert.equal(crossSite.status,403);
  const applied=await call("/api/public/notifications/unsubscribe",{method:"POST",body:{token}});
  assert.deepEqual(await applied.json(),{unsubscribed:true,scope:"subscription"});
  assert.equal((await store.subscriptions(follower)).items.length,0);
  assert.equal((await call("/api/public/notifications/unsubscribe",{method:"POST",body:{token}})).status,200,"idempotent");

  await verifyAddress(follower);
  await store.updatePreferences(follower,{inApp:"immediate",email:"immediate",locale:"en"});
  await store.applyUnsubscribe({token:store.unsubscribeToken(follower.accountId,{channel:"email"})});
  assert.equal((await store.preferences(follower)).email,"off");
});

test("inbox pages newest first and tracks read state",async()=>{
  const document=await publish("Ledger");
  await store.subscribe(follower,{targetKind:"document",targetId:document.id});
  let current=document;
  for(let i=0;i<5;i++)current=await revise(current,"Revision "+i,i+1);
  await tick();
  const first=await store.inbox(follower,{limit:2});
  assert.equal(first.items.length,2);assert.equal(first.unreadCount,6);
  const second=await store.inbox(follower,{limit:2,before:first.nextCursor});
  const third=await store.inbox(follower,{limit:2,before:second.nextCursor});
  const all=[...first.items,...second.items,...third.items].map(i=>i.items[0].seq);
  assert.deepEqual(all,[...all].sort((x,y)=>y-x));assert.equal(new Set(all).size,6);assert.equal(third.nextCursor,null);
  await store.markInbox(follower,{ids:[first.items[0].id],read:true});
  assert.equal((await store.inbox(follower)).unreadCount,5);
  assert.equal((await store.markInbox(member,{ids:[first.items[1].id],read:true})).updated,0,"cannot touch another account's inbox");
  await store.markInbox(follower,{ids:[first.items[0].id],read:false});
  const response=await call("/api/notifications/inbox/read-all",{who:follower,method:"POST",body:{}});
  assert.deepEqual(await response.json(),{updated:6});
  assert.equal((await (await call("/api/notifications/inbox?limit=1",{who:follower})).json()).unreadCount,0);
  await assert.rejects(store.inbox(follower,{before:"0"}),{code:"INVALID_PAGE"});
});

test("Postmark adapter sends JSON with injected fetch and classifies failures",async()=>{
  const requests=[];let reply;
  const fetch=async(url,init)=>{requests.push({url,init});return reply();};
  const adapter=createPostmarkAdapter({serverToken:"00000000-0000-4000-8000-000000000000",from:"notices@quill.example",fetch});
  reply=()=>Response.json({ErrorCode:0,MessageID:"abc"});
  assert.deepEqual(await adapter.send({to:"a@example.org",subject:"S",text:"T",headers:{"List-Unsubscribe":"<https://quill.example/u>","Bad Header":"x"},tag:"digest"}),{messageId:"abc"});
  const body=JSON.parse(requests[0].init.body);
  assert.equal(requests[0].url,"https://api.postmarkapp.com/email");
  assert.equal(requests[0].init.headers["x-postmark-server-token"],"00000000-0000-4000-8000-000000000000");
  assert.deepEqual(body.Headers,[{Name:"List-Unsubscribe",Value:"<https://quill.example/u>"}]);
  assert.equal(body.TrackOpens,false);assert.equal(body.MessageStream,"outbound");
  reply=()=>Response.json({ErrorCode:0},{status:500});
  await assert.rejects(adapter.send({to:"a@example.org",subject:"S",text:"T"}),e=>e.code==="provider-500"&&!e.permanent&&!e.message.includes("a@example.org"));
  reply=()=>Response.json({ErrorCode:300,Message:"Invalid email request"},{status:422});
  await assert.rejects(adapter.send({to:"a@example.org",subject:"S",text:"T"}),e=>e.code==="provider-rejected-300"&&e.permanent);
  reply=()=>{throw Error("network down");};
  await assert.rejects(adapter.send({to:"a@example.org",subject:"S",text:"T"}),{code:"provider-unreachable"});
  await assert.rejects(adapter.send({to:"a@example.org\r\nBcc: x@y",subject:"S",text:"T"}),{code:"invalid-message",permanent:true});
  assert.equal(postmarkFromEnvironment({}),null,"absent credentials leave email unavailable");
  assert.throws(()=>createPostmarkAdapter({serverToken:"short",from:"a@b"}));
});
