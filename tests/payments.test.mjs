import {before,after,beforeEach,test} from "node:test";
import assert from "node:assert/strict";
import {randomUUID,randomBytes,createHmac} from "node:crypto";
import {PGlite} from "@electric-sql/pglite";
import {createIdentityStore,applyIdentityMigrations} from "../server/identity-store.mjs";
import {createLegalDocument} from "../src/legal-structure.mjs";
import {createDocumentStore} from "../server/document-store.mjs";
import {createSettingsStore} from "../server/settings-store.mjs";
import {createEntitlementStore} from "../server/entitlement-store.mjs";
import {createBillingStore,reconcilePayments} from "../server/billing-store.mjs";
import {createBillingRoutes,billingBodyLimit} from "../server/billing-http.mjs";
import {createAccountHandler} from "../server/account-http.mjs";
import {createStripeProvider,verifyStripeSignature,stripeProviderFromEnvironment} from "../server/payment-providers/stripe.mjs";
import {createManualProvider} from "../server/payment-providers/manual.mjs";
import {changePlatformAdmin} from "../scripts/grant-platform-admin.mjs";

const origin="https://quill.example";
const SECRET="whsec_testSecretValue1234567890";
let db,identity,settings,entitlements,billing,documents,stripe,remote,handler,tenantId,owner,member,other,admin,now,eventCounter;
const transaction=fn=>db.transaction(async tx=>{await tx.exec("SET LOCAL ROLE dge_identity_runtime");return fn(tx);});
const user=async()=>({...await identity.establishSession({issuer:"https://provider.example",subject:randomUUID(),authenticatedAt:Date.now()}),origin});
const asWorker=fn=>transaction(async tx=>{await tx.query("SELECT set_config('dge.worker','billing',true)");return fn(tx);});
const CATALOG=[
  {id:"pack-10",kind:"credit-pack",label:"Ten documents",price:{currency:"USD",amountMinor:5000},quantity:10},
  {id:"single",kind:"single-document",label:"One document",price:{currency:"USD",amountMinor:900}},
  {id:"pro",kind:"subscription",label:"Pro monthly",price:{currency:"USD",amountMinor:1500},interval:"month",unlimited:true},
];

/** In-memory Stripe test-mode API: deterministic sessions per idempotency key, inspectable remote state. */
function fakeStripe(){
  const calls=[],sessions=new Map(),byKey=new Map();
  const state={sessions,subscriptions:new Map(),payments:new Map()};
  const fetch=async(url,init)=>{
    const {pathname}=new URL(url);
    calls.push({method:init.method,pathname,headers:init.headers,body:init.body});
    assert.match(init.headers.authorization,/^Bearer sk_test_/);
    if(init.method==="POST"&&pathname==="/v1/checkout/sessions"){
      const key=init.headers["idempotency-key"];
      if(!byKey.has(key)){
        const form=new URLSearchParams(init.body),id="cs_test_"+(byKey.size+1);
        byKey.set(key,id);
        sessions.set(id,{id,url:"https://checkout.stripe.com/c/pay/"+id,livemode:false,payment_status:"unpaid",
          amount_total:Number(form.get("line_items[0][price_data][unit_amount]")),currency:form.get("line_items[0][price_data][currency]"),
          client_reference_id:form.get("client_reference_id"),mode:form.get("mode"),payment_intent:null,subscription:null});
      }
      return Response.json(sessions.get(byKey.get(key)));
    }
    const session=pathname.match(/^\/v1\/checkout\/sessions\/(\w+)$/);
    if(session&&sessions.has(session[1]))return Response.json(sessions.get(session[1]));
    const subscription=pathname.match(/^\/v1\/subscriptions\/(\w+)$/);
    if(subscription&&state.subscriptions.has(subscription[1]))return Response.json(state.subscriptions.get(subscription[1]));
    const payment=pathname.match(/^\/v1\/payment_intents\/(\w+)$/);
    if(payment&&state.payments.has(payment[1]))return Response.json(state.payments.get(payment[1]));
    return new Response("{}",{status:404});
  };
  return {fetch,calls,state};
}
const sign=(body,{secret=SECRET,t=Math.floor(now/1000)}={})=>"t="+t+",v1="+createHmac("sha256",secret).update(t+"."+body).digest("hex");
const event=(type,object,{created=Math.floor(now/1000),id="evt_"+(++eventCounter)}={})=>({id,object:"event",type,created,livemode:false,data:{object}});
const deliver=async(evt,{signature,body=JSON.stringify(evt)}={})=>{
  const response=await handler(new Request(origin+"/api/billing/webhooks/stripe",{method:"POST",
    headers:{"content-type":"application/json; charset=utf-8",...(signature!==null?{"stripe-signature":signature??sign(body)}:{})},body}),{peerAddress:"203.0.113.9"});
  return {status:response.status,body:await response.json()};
};
const call=(path,{who=owner,method="GET",body}={})=>handler(new Request(origin+path,{method,
  headers:{cookie:"__Host-dge_session="+who.sessionToken,origin,"x-dge-csrf":who.csrfToken,...(body?{"content-type":"application/json"}:{})},
  ...(body?{body:JSON.stringify(body)}:{})}),{peerAddress:"127.0.0.1"}).then(async r=>({status:r.status,body:await r.json()}));
const buy=(itemId,who=owner,extra={})=>billing.checkout(who,{provider:"stripe",itemId,subject:"account",idempotencyKey:"checkout-"+randomUUID(),...extra});
const pay=async(checkout,{paymentIntent="pi_"+randomUUID().replaceAll("-",""),subscription=null}={})=>{
  const session=remote.state.sessions.get([...remote.state.sessions.keys()].find(id=>remote.state.sessions.get(id).client_reference_id===checkout.checkoutId));
  Object.assign(session,{payment_status:"paid",payment_intent:subscription?null:paymentIntent,subscription});
  return {session,result:await deliver(event("checkout.session.completed",{...session,object:"checkout.session"}))};
};
const balance=async accountId=>(await asWorker(tx=>tx.query("SELECT credits FROM dge_billing.balances WHERE subject=$1",["account:"+accountId]))).rows[0]?.credits??0;
const createDocument=who=>{
  const document=structuredClone(createLegalDocument({id:randomUUID(),tenantId,title:"Paid document"}));
  return documents.create(who,tenantId,{document,commandId:randomUUID(),disclosure:"publish-all-revisions-v1"});
};

before(async()=>{db=await PGlite.create();await applyIdentityMigrations(fn=>db.transaction(fn));});
after(async()=>db?.close());
beforeEach(async()=>{
  await db.exec("TRUNCATE dge_identity.accounts,dge_identity.tenants,dge_identity.login_challenges,dge_billing.webhook_events CASCADE");
  now=Date.now();eventCounter=0;
  identity=createIdentityStore({transaction,origin,sessionKey:randomBytes(32),stateKey:randomBytes(32)});
  settings=createSettingsStore({identity,transaction});
  entitlements=createEntitlementStore({identity,transaction,settings,clock:()=>now});
  documents=createDocumentStore({identity,transaction,entitlements});
  remote=fakeStripe();
  stripe=createStripeProvider({secretKey:"sk_test_abcdefghijkl",webhookSecret:SECRET,fetch:remote.fetch,clock:()=>now});
  billing=createBillingStore({identity,transaction,settings,entitlements,origin,clock:()=>now,providers:[stripe,createManualProvider({enabled:true})]});
  handler=createAccountHandler({store:identity,login:{},origin,extensions:[createBillingRoutes({entitlements,billing})]});
  [owner,member,other,admin]=await Promise.all([user(),user(),user(),user()]);
  ({tenantId}=await identity.createTenant(owner));
  const invite=await identity.invite(owner,tenantId,member.accountId,"participant");
  await identity.acceptInvitation(member,tenantId,invite.invitationToken);
  await changePlatformAdmin(fn=>db.transaction(fn),{action:"grant",accountId:admin.accountId,reason:"Billing operations"});
  await settings.change(admin,{scope:"platform"},{changes:{"billing.catalog":CATALOG,"quotas.weeklyFreeDocuments":0},expectedVersion:0,reason:"Launch catalog"});
});

test("webhook forgery, wrong secrets, stale timestamps and tampered bodies are rejected before any processing",async()=>{
  const checkout=await buy("pack-10");
  const session=[...remote.state.sessions.values()][0];
  Object.assign(session,{payment_status:"paid",payment_intent:"pi_forged"});
  const evt=event("checkout.session.completed",session),body=JSON.stringify(evt);
  for(const [signature,code] of [
    [null,"WEBHOOK_SIGNATURE_INVALID"],
    ["t=1,v1=zz","WEBHOOK_SIGNATURE_INVALID"],
    [sign(body,{secret:"whsec_someOtherSecret123456"}),"WEBHOOK_SIGNATURE_INVALID"],
    ["t="+Math.floor(now/1000)+",v0="+createHmac("sha256",SECRET).update(Math.floor(now/1000)+"."+body).digest("hex"),"WEBHOOK_SIGNATURE_INVALID"],
    [sign(body,{t:Math.floor(now/1000)-301}),"WEBHOOK_TIMESTAMP_STALE"],
    [sign(body,{t:Math.floor(now/1000)+301}),"WEBHOOK_TIMESTAMP_STALE"],
  ])assert.deepEqual(await deliver(evt,{signature}),{status:400,body:{error:code}});
  assert.deepEqual(await deliver(evt,{signature:sign(body),body:body.replace('"paid"','"paid" ')}),{status:400,body:{error:"WEBHOOK_SIGNATURE_INVALID"}});
  assert.equal(await balance(owner.accountId),0);
  assert.equal((await asWorker(tx=>tx.query("SELECT count(*)::int AS n FROM dge_billing.webhook_events"))).rows[0].n,0);
  // Several v1 signatures (secret rotation): any valid one is accepted.
  const t=Math.floor(now/1000),good=createHmac("sha256",SECRET).update(t+"."+body).digest("hex");
  assert.equal(verifyStripeSignature({header:"t="+t+",v1="+"0".repeat(64)+",v1="+good,rawBody:body,secret:SECRET,now}),t);
  assert.deepEqual(await deliver(evt),{status:200,body:{received:true,duplicate:false,outcome:"processed"}});
  assert.equal(await balance(owner.accountId),10);
  assert.equal(checkout.status,"open");
  assert.equal(billingBodyLimit("/api/billing/webhooks/stripe"),65536);
  assert.equal((await call("/api/billing/webhooks/unknown-provider",{method:"POST",body:{}})).status,404);
  assert.equal((await call("/api/billing/webhooks/manual",{method:"POST",body:{}})).status,404);
});

test("duplicated checkouts and replayed events grant exactly once",async()=>{
  const key="checkout-"+randomUUID();
  const [one,two]=await Promise.all([buy("pack-10",owner,{idempotencyKey:key}),buy("pack-10",owner,{idempotencyKey:key})]);
  assert.equal(one.checkoutId,two.checkoutId);
  assert.equal(one.url,two.url);
  assert.match(one.url,/^https:\/\/checkout\.stripe\.com\//);
  assert.deepEqual(await buy("pack-10",owner,{idempotencyKey:key}),one);
  await assert.rejects(buy("single",owner,{idempotencyKey:key}),{code:"IDEMPOTENCY_KEY_REUSED"});
  const posts=remote.calls.filter(c=>c.method==="POST");
  assert(posts.length>=1&&posts.every(c=>c.headers["idempotency-key"]==="dge-checkout-"+one.checkoutId));
  const form=new URLSearchParams(posts[0].body);
  assert.deepEqual([form.get("mode"),form.get("client_reference_id"),form.get("line_items[0][price_data][unit_amount]"),form.get("payment_intent_data[metadata][checkout_id]")],
    ["payment",one.checkoutId,"5000",one.checkoutId]);
  const {session,result}=await pay(one);
  assert.equal(result.body.outcome,"processed");
  const replay=event("checkout.session.completed",session,{id:"evt_1"});
  assert.deepEqual((await deliver(replay)).body,{received:true,duplicate:true});
  assert.equal((await deliver(event("checkout.session.completed",session))).body.outcome,"processed");
  assert.equal(await balance(owner.accountId),10);
  await assert.rejects(buy("missing"),{code:"CATALOG_ITEM_NOT_FOUND"});
  const mismatch=await buy("single");
  const wrong=[...remote.state.sessions.values()].find(s=>s.client_reference_id===mismatch.checkoutId);
  Object.assign(wrong,{payment_status:"paid",amount_total:1,payment_intent:"pi_cheap"});
  assert.equal((await deliver(event("checkout.session.completed",wrong))).body.outcome,"mismatch");
  assert.equal(await balance(owner.accountId),10);
});

test("out-of-order subscription events are deferred, replayed after linking, and stale updates are ignored",async()=>{
  const checkout=await buy("pro");
  assert.equal(new URLSearchParams(remote.calls[0].body).get("line_items[0][price_data][recurring][interval]"),"month");
  const t0=Math.floor(now/1000);
  const updated=await deliver(event("customer.subscription.updated",{id:"sub_1",object:"subscription",status:"past_due",metadata:{checkout_id:checkout.checkoutId},current_period_end:t0+86400*30},{created:t0+5}));
  assert.equal(updated.body.outcome,"pending-link");
  const invoice=await deliver(event("invoice.paid",{id:"in_1",object:"invoice",subscription:"sub_1",amount_paid:1500,currency:"usd",
    lines:{data:[{period:{start:t0-60,end:t0+86400*30}}]}},{created:t0+2}));
  assert.equal(invoice.body.outcome,"pending-link");
  await assert.rejects(createDocument(owner),{code:"ENTITLEMENT_REQUIRED"});
  await pay(checkout,{subscription:"sub_1"});
  const outcomes=(await asWorker(tx=>tx.query("SELECT event_type,outcome FROM dge_billing.webhook_events ORDER BY event_created"))).rows;
  assert(outcomes.every(row=>row.outcome==="processed"),JSON.stringify(outcomes));
  assert.equal((await asWorker(tx=>tx.query("SELECT status FROM dge_billing.subscriptions"))).rows[0].status,"past_due");
  await createDocument(owner);
  await createDocument(owner);
  const older=await deliver(event("customer.subscription.updated",{id:"sub_1",object:"subscription",status:"active",metadata:{}},{created:t0+1}));
  assert.equal(older.body.outcome,"stale");
  const status=await entitlements.status(owner);
  assert.equal(status.grants.find(g=>g.provenance==="subscription").unlimited,true);
  // Cancellation ends the subscription grant from now on; documents and participation remain.
  const first=(await createDocument(owner)).document.id;
  assert.equal((await deliver(event("customer.subscription.deleted",{id:"sub_1",object:"subscription",status:"canceled",metadata:{}},{created:t0+10}))).body.outcome,"processed");
  await assert.rejects(createDocument(owner),{code:"ENTITLEMENT_REQUIRED"});
  assert.equal((await deliver(event("customer.subscription.updated",{id:"sub_1",object:"subscription",status:"active",metadata:{}},{created:t0+20}))).body.outcome,"stale");
  assert.equal((await deliver(event("invoice.paid",{id:"in_2",object:"invoice",subscription:"sub_1",amount_paid:1500,currency:"usd",lines:{data:[{period:{start:t0+86400*30,end:t0+86400*60}}]}}))).body.outcome,"stale");
  assert.equal((await documents.read(member,tenantId,first)).version,1);
  assert.equal((await entitlements.status(owner)).grants.find(g=>g.provenance==="subscription").state,"revoked");
});

test("refunds and disputes revoke only unused purchased credits and never touch documents",async()=>{
  const pack=await buy("pack-10");
  await pay(pack,{paymentIntent:"pi_pack"});
  for(let i=0;i<4;i++)await createDocument(owner);
  assert.equal(await balance(owner.accountId),6);
  const refund=amount=>deliver(event("charge.refunded",{id:"ch_pack",object:"charge",payment_intent:"pi_pack",amount:5000,amount_refunded:amount,currency:"usd"}));
  assert.equal((await refund(2500)).body.outcome,"processed");
  assert.equal(await balance(owner.accountId),1);
  assert.equal((await refund(5000)).body.outcome,"processed");
  assert.equal(await balance(owner.accountId),0);
  assert.equal((await refund(5000)).body.outcome,"processed");
  const revoked=(await asWorker(tx=>tx.query("SELECT coalesce(-sum(delta),0)::int AS n FROM dge_billing.credit_ledger WHERE kind='revoke'"))).rows[0].n;
  assert.equal(revoked,6);
  assert.equal((await documents.list(member,tenantId)).items.length,4);
  const single=await buy("single");
  await pay(single,{paymentIntent:"pi_single"});
  assert.equal(await balance(owner.accountId),1);
  assert.equal((await deliver(event("charge.dispute.created",{id:"dp_1",object:"dispute",charge:"ch_single",payment_intent:"pi_single",amount:900,currency:"usd"}))).body.outcome,"processed");
  assert.equal(await balance(owner.accountId),0);
  const unknown=await deliver(event("charge.dispute.created",{id:"dp_2",object:"dispute",charge:"ch_x",payment_intent:"pi_unknown",amount:900,currency:"usd"}));
  assert.equal(unknown.body.outcome,"pending-link");
  const report=await reconcilePayments({transaction,provider:stripe,clock:()=>now});
  assert.deepEqual(report.differences.filter(d=>d.kind==="unrecoverable-credits").map(d=>[d.checkoutId,d.expected,d.revoked]),[[pack.checkoutId,10,6]]);
  assert.equal(report.pendingEvents,1);
});

test("purchases are isolated per account and workspace",async()=>{
  const mine=await buy("pack-10");
  await pay(mine);
  assert.equal(await balance(other.accountId),0);
  assert.equal((await entitlements.status(other)).credits,0);
  const peek=await transaction(async tx=>{await tx.query("SELECT set_config('dge.account_id',$1,true)",[other.accountId]);
    return (await tx.query("SELECT (SELECT count(*)::int FROM dge_billing.checkouts) AS checkouts,(SELECT count(*)::int FROM dge_billing.webhook_events) AS events")).rows[0];});
  assert.deepEqual(peek,{checkouts:0,events:0});
  await assert.rejects(billing.checkout(member,{provider:"stripe",itemId:"pack-10",subject:"tenant",tenantId,idempotencyKey:"tenant-purchase-1"}),{code:"ACCESS_DENIED"});
  await assert.rejects(billing.checkout(other,{provider:"stripe",itemId:"pack-10",subject:"tenant",tenantId,idempotencyKey:"tenant-purchase-1"}),{code:"ACCESS_DENIED"});
  const workspace=await billing.checkout(owner,{provider:"stripe",itemId:"pack-10",subject:"tenant",tenantId,idempotencyKey:"tenant-purchase-1"});
  assert.deepEqual(workspace.subject,{kind:"tenant",id:tenantId});
  await pay(workspace);
  assert.equal((await entitlements.tenantStatus(owner,tenantId)).credits,10);
  assert.equal(await balance(owner.accountId),10);
  // A member spends workspace credits; reading needs nothing.
  await settings.change(admin,{scope:"platform"},{changes:{"entitlements.consumptionOrder":["credits","grants","weekly-allowance"]},expectedVersion:1,reason:"Order"});
  const invite=await identity.invite(owner,tenantId,other.accountId,"editor");
  await identity.acceptInvitation(other,tenantId,invite.invitationToken);
  await createDocument(other);
  assert.equal((await entitlements.tenantStatus(owner,tenantId)).credits,9);
});

test("unconfigured providers are reported unavailable and nothing is ever marked paid",async()=>{
  const unavailable=stripeProviderFromEnvironment({});
  assert.deepEqual([unavailable.available,unavailable.mode],[false,null]);
  const offline=createBillingStore({identity,transaction,settings,entitlements,origin,providers:[unavailable,createManualProvider()]});
  assert.deepEqual(await offline.options(owner),{providers:[],catalog:CATALOG,purchasesEnabled:false});
  await assert.rejects(offline.checkout(owner,{provider:"stripe",itemId:"pack-10",subject:"account",idempotencyKey:"offline-0001"}),{code:"PROVIDER_UNAVAILABLE",status:503});
  await assert.rejects(offline.webhook("stripe",Buffer.from("{}"),new Headers()),{code:"PROVIDER_UNAVAILABLE"});
  assert.deepEqual((await reconcilePayments({transaction,provider:unavailable})).differences,[]);
  assert.equal((await asWorker(tx=>tx.query("SELECT count(*)::int AS n FROM dge_billing.checkouts"))).rows[0].n,0);
  const options=await call("/api/billing/checkout");
  assert.deepEqual(options.body.providers,[{id:"stripe",mode:"test"},{id:"manual",mode:"invoice"}]);
});

test("manual invoicing records administrator-confirmed payments and refunds idempotently",async()=>{
  const invoice=await billing.checkout(owner,{provider:"manual",itemId:"pack-10",subject:"account",idempotencyKey:"invoice-request-1"});
  assert.deepEqual([invoice.status,invoice.url],["invoice-requested",null]);
  assert.equal(await balance(owner.accountId),0);
  const payment={checkoutId:invoice.checkoutId,invoiceReference:"INV-2026-0042",amountMinor:5000,currency:"USD"};
  assert.equal((await call("/api/entitlements/manual-payments",{method:"POST",body:payment})).status,403);
  assert.equal((await call("/api/entitlements/manual-payments",{who:admin,method:"POST",body:payment})).body.outcome,"processed");
  assert.equal((await call("/api/entitlements/manual-payments",{who:admin,method:"POST",body:payment})).body.duplicate,true);
  assert.equal(await balance(owner.accountId),10);
  assert.equal((await call("/api/entitlements/manual-payments",{who:admin,method:"POST",body:{...payment,checkoutId:randomUUID(),invoiceReference:"INV-X"}})).status,404);
  await billing.recordManualRefund(admin,{checkoutId:invoice.checkoutId,refundReference:"CN-2026-0007",refundedMinor:5000});
  assert.equal(await balance(owner.accountId),0);
  const report=await billing.reconcile({provider:"manual"});
  assert.deepEqual([report.mode,report.checked,report.differences],["invoice",1,[]]);
});

test("test-mode reconciliation reports differences between Stripe and the ledger without changing either",async()=>{
  const paidLate=await buy("pack-10");// paid at Stripe, webhook never arrived
  const consistent=await buy("single");
  await pay(consistent,{paymentIntent:"pi_consistent"});
  const subscription=await buy("pro");
  await pay(subscription,{subscription:"sub_9"});
  Object.assign([...remote.state.sessions.values()].find(s=>s.client_reference_id===paidLate.checkoutId),{payment_status:"paid"});
  remote.state.subscriptions.set("sub_9",{id:"sub_9",status:"canceled",livemode:false});
  remote.state.payments.set("pi_consistent",{id:"pi_consistent",livemode:false,latest_charge:{amount_refunded:900,disputed:true}});
  const before=await balance(owner.accountId);
  const report=await reconcilePayments({transaction,provider:stripe,clock:()=>now});
  assert.equal(report.mode,"test");
  assert.equal(report.checked,3);
  const kinds=report.differences.map(d=>d.kind+":"+(d.checkoutId===paidLate.checkoutId?"late":d.checkoutId===consistent.checkoutId?"single":"pro")).sort();
  assert.deepEqual(kinds,["dispute-not-applied:single","paid-not-fulfilled:late","refund-mismatch:single","subscription-status-mismatch:pro"]);
  assert.equal(await balance(owner.accountId),before);
  assert(JSON.stringify(report).indexOf("sk_test")<0);
});
