import {before,after,test} from "node:test";
import assert from "node:assert/strict";
import {randomUUID,randomBytes} from "node:crypto";
import {build} from "esbuild";
import {JSDOM} from "jsdom";
import {PGlite} from "@electric-sql/pglite";
import {createIdentityStore,applyIdentityMigrations} from "../server/identity-store.mjs";
import {createSettingsStore} from "../server/settings-store.mjs";
import {createSettingsRoutes} from "../server/settings-http.mjs";
import {createEntitlementStore} from "../server/entitlement-store.mjs";
import {createBillingStore} from "../server/billing-store.mjs";
import {createBillingRoutes} from "../server/billing-http.mjs";
import {createAccountHandler} from "../server/account-http.mjs";
import {createStripeProvider} from "../server/payment-providers/stripe.mjs";
import {createManualProvider} from "../server/payment-providers/manual.mjs";
import {changePlatformAdmin} from "../scripts/grant-platform-admin.mjs";

const origin="https://quill.example";
let db,script,identity,settings,owner,viewer,admin,tenantId,handlerFor;
const transaction=fn=>db.transaction(async tx=>{await tx.exec("SET LOCAL ROLE dge_identity_runtime");return fn(tx);});
const user=async()=>({...await identity.establishSession({issuer:"https://provider.example",subject:randomUUID(),authenticatedAt:Date.now()}),origin});

before(async()=>{
  db=await PGlite.create();await applyIdentityMigrations(fn=>db.transaction(fn));
  identity=createIdentityStore({transaction,origin,sessionKey:randomBytes(32),stateKey:randomBytes(32)});
  settings=createSettingsStore({identity,transaction});
  const entitlements=createEntitlementStore({identity,transaction,settings});
  [owner,viewer,admin]=await Promise.all([user(),user(),user()]);
  ({tenantId}=await identity.createTenant(owner));
  const invite=await identity.invite(owner,tenantId,viewer.accountId,"viewer");
  await identity.acceptInvitation(viewer,tenantId,invite.invitationToken);
  await changePlatformAdmin(fn=>db.transaction(fn),{action:"grant",accountId:admin.accountId,reason:"Pricing"});
  await settings.change(admin,{scope:"platform"},{changes:{"billing.catalog":[{id:"pack-5",kind:"credit-pack",label:"Five documents",price:{currency:"EUR",amountMinor:2550},quantity:5}],
    "quotas.weeklyFreeDocuments":0},expectedVersion:0,reason:"Catalog"});
  handlerFor=providers=>{
    const billing=createBillingStore({identity,transaction,settings,entitlements,origin,providers});
    return createAccountHandler({store:identity,login:{},origin,extensions:[createSettingsRoutes({settings}),createBillingRoutes({entitlements,billing})]});
  };
  const output=await build({stdin:{contents:`import React from "react";import {createRoot} from "react-dom/client";
    import {AdminConsole} from "./web/admin-console.jsx";import {BillingPanel,formatMoney} from "./web/billing-panel.jsx";
    window.mount=(kind,props,element)=>createRoot(element).render(React.createElement(kind==="admin"?AdminConsole:BillingPanel,props));
    window.formatMoney=formatMoney;`,resolveDir:process.cwd(),loader:"jsx"},
    bundle:true,write:false,platform:"browser",format:"iife",target:"es2022",define:{"process.env.NODE_ENV":'"production"'}});
  script=output.outputFiles[0].text;
});
after(async()=>db?.close());

/** Same-origin API client bound to one signed-in person, running the real account handler. */
const apiFor=(who,handler)=>async(path,{method="GET",body}={})=>{
  const response=await handler(new Request(origin+path,{method,headers:{cookie:"__Host-dge_session="+who.sessionToken,origin,"x-dge-csrf":who.csrfToken,
    ...(body!==undefined?{"content-type":"application/json"}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{})}),{peerAddress:"127.0.0.1"});
  const result=await response.json();
  if(!response.ok)throw Object.assign(Error(result.error),{code:result.error,status:response.status});
  return result;
};
async function page(kind,props){
  const dom=new JSDOM('<html><body><div id="root"></div></body></html>',{url:origin,runScripts:"dangerously",pretendToBeVisual:true});
  dom.window.eval(script);
  dom.window.mount(kind,props,dom.window.document.getElementById("root"));
  const document=dom.window.document;
  const waitFor=async predicate=>{for(let i=0;i<300;i++){if(predicate())return;await new Promise(r=>setTimeout(r,10));}throw Error("Expected UI state did not appear: "+document.body.textContent.slice(0,400));};
  const button=(text,scope=document)=>[...scope.querySelectorAll("button")].find(b=>b.textContent.startsWith(text));
  const row=key=>document.querySelector('[data-setting="'+key+'"]');
  const set=(element,value)=>{
    const prototype=element.tagName==="SELECT"?dom.window.HTMLSelectElement.prototype:dom.window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype,"value").set.call(element,value);
    element.dispatchEvent(new dom.window.Event(element.tagName==="SELECT"?"change":"input",{bubbles:true}));
  };
  return {dom,document,waitFor,button,row,set};
}

test("the admin console shows sources, validates, requires a matching simulation and saves a version",async()=>{
  const handler=handlerFor([]);
  const {dom,document,waitFor,button,row,set}=await page("admin",{target:{scope:"tenant",tenantId},api:apiFor(owner,handler)});
  try{
    await waitFor(()=>row("points.rankingProfile"));
    assert.match(row("points.rankingProfile").textContent,/Built-in default/);
    assert.match(row("quotas.weeklyFreeDocuments").textContent,/Platform.*Not editable here/);
    assert.match(row("invariants.publicInputImmutable").textContent,/Fixed invariant.*Never changeable/);
    button("Edit",row("votes.deliberationHours")).click();
    await waitFor(()=>row("votes.deliberationHours").querySelector("input"));
    set(row("votes.deliberationHours").querySelector("input"),"-5");
    await waitFor(()=>row("votes.deliberationHours").querySelector('[role="alert"]'));
    assert.equal(button("Preview changes").disabled,true);
    button("Discard",row("votes.deliberationHours")).click();
    button("Edit",row("points.rankingProfile")).click();
    await waitFor(()=>row("points.rankingProfile").querySelector("select"));
    set(row("points.rankingProfile").querySelector("select"),"net-votes");
    await waitFor(()=>!button("Preview changes").disabled);
    set(document.querySelector(".settings-review input"),"Try net votes");
    await waitFor(()=>document.querySelector(".settings-review input").value==="Try net votes");
    assert.equal(button("Save new version").disabled,true);
    button("Preview changes").click();
    await waitFor(()=>document.querySelector(".settings-preview"));
    assert.match(document.querySelector(".settings-preview").textContent,/Built-in default.*→.*net-votes.*Workspace/);
    assert.match(document.querySelector(".settings-preview").textContent,/Affected: 0 documents, 0 open decisions/);
    await waitFor(()=>!button("Save new version").disabled);
    button("Save new version").click();
    await waitFor(()=>/Saved as version 1/.test(document.body.textContent));
    await waitFor(()=>/Workspace/.test(row("points.rankingProfile").textContent));
    button("Show history").click();
    await waitFor(()=>document.querySelector(".settings-history ol li"));
    assert.match(document.querySelector(".settings-history").textContent,/History digests verified.*Version 1.*Try net votes/);
  }finally{dom.window.close();}
  const readOnly=await page("admin",{target:{scope:"tenant",tenantId},api:apiFor(viewer,handler)});
  try{
    await readOnly.waitFor(()=>readOnly.row("points.rankingProfile"));
    assert.match(readOnly.document.body.textContent,/Read only/);
    assert.equal(readOnly.button("Edit"),undefined);
    assert.equal(readOnly.button("Show history"),undefined);
  }finally{readOnly.dom.window.close();}
});

test("the billing panel hides purchases without a configured provider and requests invoices when one is",async()=>{
  const unavailable=createStripeProvider({});
  let view=await page("billing",{tenantId,api:apiFor(owner,handlerFor([unavailable]))});
  try{
    await view.waitFor(()=>view.document.querySelector(".billing-balances"));
    assert.match(view.document.body.textContent,/0 of 0 used/);
    assert.match(view.document.body.textContent,/You can still read, discuss and vote/);
    assert.equal(view.document.querySelector(".billing-purchase"),null);
    assert.match(view.document.body.textContent,/Workspace credits/);
  }finally{view.dom.window.close();}
  const navigated=[];
  view=await page("billing",{tenantId,api:apiFor(owner,handlerFor([unavailable,createManualProvider({enabled:true})])),navigate:url=>navigated.push(url)});
  try{
    await view.waitFor(()=>view.document.querySelector(".billing-purchase"));
    assert.equal(view.dom.window.formatMoney({currency:"EUR",amountMinor:2550},"en-US"),"€25.50");
    assert.equal(view.dom.window.formatMoney({currency:"JPY",amountMinor:1200},"en-US"),"¥1,200");
    assert.equal(view.button("Pay with Stripe"),undefined);
    view.button("Request invoice").click();
    await view.waitFor(()=>/Invoice requested/.test(view.document.body.textContent));
    assert.deepEqual(navigated,[]);
  }finally{view.dom.window.close();}
  view=await page("billing",{tenantId,api:apiFor(viewer,handlerFor([createManualProvider({enabled:true})]))});
  try{
    await view.waitFor(()=>view.document.querySelector(".billing-purchase"));
    assert.doesNotMatch(view.document.body.textContent,/Workspace credits/);
    assert.equal(view.document.querySelector(".billing-purchase select"),null);
  }finally{view.dom.window.close();}
});
