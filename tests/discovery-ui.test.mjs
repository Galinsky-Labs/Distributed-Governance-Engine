import {before,after,test} from "node:test";
import assert from "node:assert/strict";
import {build} from "esbuild";
import {JSDOM} from "jsdom";
import {auditAccessibility} from "./support/a11y.mjs";

const entry=`
import React from "react";
import {createRoot} from "react-dom/client";
import {I18nProvider} from "./i18n-react.mjs";
import {SearchPanel} from "./search-panel.jsx";
import {NotificationCenter,FollowButton,UnsubscribeConfirmation,EmailVerification} from "./notification-center.jsx";
import {LanguagePicker} from "./language-picker.jsx";
const components={SearchPanel,NotificationCenter,FollowButton,UnsubscribeConfirmation,EmailVerification,LanguagePicker};
window.mount=(name,props,locale="en")=>{
  const host=document.createElement("div");document.body.appendChild(host);
  const root=createRoot(host);
  root.render(React.createElement(I18nProvider,{locale,applyToDocument:true},React.createElement(components[name],props)));
  return {host,unmount:()=>{root.unmount();host.remove();}};
};`;
let script,dom;
before(async()=>{
  const output=await build({stdin:{contents:entry,resolveDir:"web",loader:"jsx",sourcefile:"discovery-entry.jsx"},bundle:true,write:false,
    platform:"browser",format:"iife",target:"es2022",define:{"process.env.NODE_ENV":'"production"'}});
  script=output.outputFiles[0].text;
  dom=new JSDOM("<!doctype html><html lang=\"en\"><body></body></html>",{url:"https://quill.example/",runScripts:"dangerously",pretendToBeVisual:true});
  dom.window.eval(script);
});
after(()=>dom?.window.close());

const waitFor=async(predicate,message="Expected UI state did not appear")=>{
  for(let i=0;i<200;i++){if(predicate())return;await new Promise(r=>setTimeout(r,5));}
  throw Error(message);
};
const type=(element,value)=>{
  Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,"value").set.call(element,value);
  element.dispatchEvent(new dom.window.Event("input",{bubbles:true}));
};
const select=(element,value)=>{
  Object.getOwnPropertyDescriptor(dom.window.HTMLSelectElement.prototype,"value").set.call(element,value);
  element.dispatchEvent(new dom.window.Event("change",{bubbles:true}));
};
const buttonNamed=(host,name)=>[...host.querySelectorAll("button")].find(b=>b.textContent.trim()===name);
const status=(host)=>[...host.querySelectorAll("[role=status]")].map(s=>s.textContent).join(" ");
const assertAccessible=(host,options)=>assert.deepEqual(auditAccessibility(host,options),[]);

const result=(i,extra={})=>({kind:"document",documentId:"00000000-0000-4000-8000-00000000000"+i,proposalId:null,workspaceId:"11111111-1111-4111-8111-111111111111",
  product:"civic",mode:"collaboration",title:"Water act "+i,version:2,rank:0.5,
  snippet:{segments:[{text:"The ",match:false},{text:"water",match:true},{text:" authority <img src=x onerror=alert(1)>",match:false}],truncatedStart:true,truncatedEnd:false},...extra});

test("search panel is labelled, announces status, renders snippet text safely and paginates",async()=>{
  const calls=[];
  const api=async(path)=>{calls.push(path);return path.includes("cursor=")?{items:[result(2,{kind:"proposal",proposalId:"22222222-2222-4222-8222-222222222222"})],nextCursor:null}:{items:[result(1)],nextCursor:"next-page"};};
  const {host,unmount}=dom.window.mount("SearchPanel",{api});
  try{
    await waitFor(()=>host.querySelector("input[type=search]"));
    assertAccessible(host);
    assert.ok(host.querySelector("form[role=search]"));
    type(host.querySelector("input[type=search]"),"water authority");
    select(host.querySelector("select"),"public-input");
    await new Promise(r=>setTimeout(r,0));
    buttonNamed(host,"Search").click();
    await waitFor(()=>host.querySelectorAll(".search-results li").length===1);
    assert.match(calls[0],/^\/api\/public\/search\?q=water\+authority&kind=all&limit=20&mode=public-input$/);
    const snippet=host.querySelector(".search-snippet");
    assert.equal(snippet.querySelector("mark").textContent,"water");
    assert.equal(snippet.querySelector("img"),null,"snippet text is never parsed as markup");
    assert.match(snippet.textContent,/^… The water authority <img/);
    assert.match(status(host),/1 result shown/);
    assertAccessible(host);
    buttonNamed(host,"Load more").click();
    await waitFor(()=>host.querySelectorAll(".search-results li").length===2);
    assert.match(calls[1],/cursor=next-page/);
    assert.equal(buttonNamed(host,"Load more"),undefined);
    assert.match(host.querySelectorAll(".search-results li")[1].textContent,/Proposal/);
    assert.equal(host.querySelectorAll(".search-results a")[1].getAttribute("href"),"/?document=00000000-0000-4000-8000-000000000002&proposal=22222222-2222-4222-8222-222222222222");
  }finally{unmount();}
});

test("search panel validates locally, maps errors and renders right-to-left in Arabic",async()=>{
  let called=0;
  const api=async()=>{called++;throw Object.assign(Error("x"),{code:"RATE_LIMITED"});};
  const {host,unmount}=dom.window.mount("SearchPanel",{api,scope:"member",workspaces:[{tenantId:"11111111-1111-4111-8111-111111111111"}]},"ar");
  try{
    await waitFor(()=>host.querySelector("input[type=search]"));
    await waitFor(()=>dom.window.document.documentElement.dir==="rtl");
    assert.equal(dom.window.document.documentElement.lang,"ar");
    assert.equal(host.querySelector("h2").textContent,"البحث في مساحات عملك");
    assert.equal(host.querySelectorAll("select").length,3,"members can filter by workspace");
    assertAccessible(host);
    type(host.querySelector("input[type=search]"),Array.from({length:17},(_,i)=>"w"+i).join(" "));
    await new Promise(r=>setTimeout(r,0));
    host.querySelector("button[type=submit]").click();
    await waitFor(()=>status(host).includes("16"));
    assert.equal(called,0);
    type(host.querySelector("input[type=search]"),"قانون");
    await new Promise(r=>setTimeout(r,0));
    host.querySelector("button[type=submit]").click();
    await waitFor(()=>status(host).includes("طلبات كثيرة"));
    assert.equal(called,1);
  }finally{unmount();}
});

const inbox={items:[
  {id:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",kind:"event",cadence:"immediate",read:false,createdAt:"2026-11-14T12:00:00.000Z",cursor:"2",
    items:[{seq:4,eventKind:"proposal",workspaceId:"w",documentId:"00000000-0000-4000-8000-000000000001",proposalId:"p",title:"Budget",recordedAt:"2026-11-14T12:00:00.000Z"}]},
  {id:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",kind:"digest",cadence:"daily",read:true,createdAt:"2026-11-13T08:00:00.000Z",cursor:"1",
    items:[{seq:1,eventKind:"document-version",workspaceId:"w",documentId:"00000000-0000-4000-8000-000000000001",proposalId:null,title:"Budget",recordedAt:"2026-11-12T10:00:00.000Z"},
      {seq:2,eventKind:"signature-added",workspaceId:"w",documentId:"00000000-0000-4000-8000-000000000003",proposalId:null,title:"Charter",recordedAt:"2026-11-12T11:00:00.000Z"}]},
],nextCursor:null,unreadCount:1};

test("notification center passes structural accessibility checks and updates read state",async()=>{
  const calls=[];
  const api=async(path,{method="GET",body}={})=>{
    calls.push({path,method,body});
    if(path.startsWith("/api/notifications/inbox?"))return inbox;
    if(path==="/api/notifications/preferences")return {inApp:"immediate",email:"off",locale:"en",emailAddress:null,emailAvailable:true};
    if(path.startsWith("/api/notifications/subscriptions?"))return {items:[{id:"cccccccc-cccc-4ccc-8ccc-cccccccccccc",targetKind:"document",targetId:"00000000-0000-4000-8000-000000000001"}],nextCursor:null};
    if(path==="/api/notifications/inbox/read")return {updated:1};
    if(path.startsWith("/api/notifications/subscriptions/"))return {removed:true};
    throw Object.assign(Error("unexpected"),{code:"NOT_FOUND"});
  };
  const {host,unmount}=dom.window.mount("NotificationCenter",{api});
  try{
    await waitFor(()=>host.querySelectorAll(".notification").length===2&&[...host.querySelectorAll("label")].some(l=>l.textContent==="Email address"));
    assertAccessible(host);
    assert.equal(host.querySelector("h1").textContent,"Notifications");
    assert.match(host.textContent,/New proposal on Budget/);
    assert.match(host.textContent,/Daily digest · 2 updates/);
    assert.match(host.textContent,/New public activity on Charter/,"unknown event kinds use the generic notice");
    assert.match(status(host),/1 unread notification/);
    const emailOptions=[...host.querySelectorAll("select")][1].querySelectorAll("option:disabled");
    assert.equal(emailOptions.length,3,"email cadences need a verified address");
    buttonNamed(host,"Mark as read").click();
    await waitFor(()=>status(host).includes("No unread notifications"));
    assert.equal(JSON.stringify(calls.find(c=>c.path==="/api/notifications/inbox/read").body),JSON.stringify({ids:["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"],read:true}));
    host.querySelector("button[aria-label^='Stop following']").click();
    await waitFor(()=>status(host).includes("no longer be notified"));
    assert.equal(calls.at(-1).method,"DELETE");
    assertAccessible(host);
  }finally{unmount();}
});

test("follow button exposes pressed state; token pages act only on confirmation",async()=>{
  const api=async(path,{method})=>method==="POST"?{id:"cccccccc-cccc-4ccc-8ccc-cccccccccccc"}:{removed:true};
  const follow=dom.window.mount("FollowButton",{api,targetKind:"document",targetId:"00000000-0000-4000-8000-000000000001"});
  try{
    await waitFor(()=>follow.host.querySelector("button"));
    const button=follow.host.querySelector("button");
    assert.equal(button.getAttribute("aria-pressed"),"false");
    button.click();
    await waitFor(()=>button.getAttribute("aria-pressed")==="true");
    assert.equal(button.textContent,"Following");
    assertAccessible(follow.host,{requireLandmark:false});
  }finally{follow.unmount();}

  const posts=[];
  const fetcher=async(path,init)=>{const body=JSON.parse(init.body);posts.push({path,body});
    return new Response(JSON.stringify(body.preview?{scope:"email"}:{unsubscribed:true,scope:"email"}),{status:200,headers:{"content-type":"application/json"}});};
  const page=dom.window.mount("UnsubscribeConfirmation",{token:"n1.token",fetcher},"fr");
  try{
    await waitFor(()=>buttonNamed(page.host,"Confirmer le désabonnement"));
    assert.equal(posts.length,1);assert.equal(posts[0].body.preview,true);
    assert.match(page.host.textContent,/Arrêter tous les courriels/);
    assertAccessible(page.host);
    buttonNamed(page.host,"Confirmer le désabonnement").click();
    await waitFor(()=>status(page.host).includes("désabonnement est enregistré"));
    assert.deepEqual(posts[1].body,{token:"n1.token"});
  }finally{page.unmount();}

  const failing=async()=>new Response(JSON.stringify({error:"INVALID_TOKEN"}),{status:400,headers:{"content-type":"application/json"}});
  const verify=dom.window.mount("EmailVerification",{token:"n1.bad",fetcher:failing});
  try{
    await waitFor(()=>buttonNamed(verify.host,"Confirm this email address"));
    buttonNamed(verify.host,"Confirm this email address").click();
    await waitFor(()=>status(verify.host).includes("invalid or has expired"));
    assertAccessible(verify.host);
  }finally{verify.unmount();}
});

test("language picker lists endonyms with lang and dir and announces changes",async()=>{
  const chosen=[];
  const {host,unmount}=dom.window.mount("LanguagePicker",{value:"en",onChange:value=>chosen.push(value)});
  try{
    await waitFor(()=>host.querySelector("select"));
    const options=[...host.querySelectorAll("option")].map(o=>[o.value,o.getAttribute("lang"),o.getAttribute("dir"),o.textContent]);
    assert.deepEqual(options,[["en","en","ltr","English"],["es","es","ltr","Español"],["fr","fr","ltr","Français"],["ar","ar","rtl","العربية"]]);
    assertAccessible(host,{requireLandmark:false});
    select(host.querySelector("select"),"ar");
    await waitFor(()=>status(host).includes("العربية"));
    assert.deepEqual(chosen,["ar"]);
  }finally{unmount();}
});

test("the accessibility helper reports each class of violation",()=>{
  const page=new JSDOM(`<div><h2>Title</h2><h4>Skipped</h4><input id="a"><input id="a" aria-label="x"><button></button><a href="/x"></a>
    <span tabindex="2">x</span><p aria-describedby="missing">y</p></div>`).window.document.body.firstElementChild;
  const rules=auditAccessibility(page).map(v=>v.rule).sort();
  assert.deepEqual(rules,["broken-reference","button-name","control-label","duplicate-id","heading-order","landmark","link-name","live-region","positive-tabindex"]);
  const good=new JSDOM(`<main><h1>T</h1><label>Name <input></label><p role="status"></p></main>`).window.document.body.firstElementChild;
  assert.deepEqual(auditAccessibility(good),[]);
});
