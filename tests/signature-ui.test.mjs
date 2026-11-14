import test from "node:test";
import assert from "node:assert/strict";
import {build} from "esbuild";
import {JSDOM} from "jsdom";
import {signingChallenge} from "../src/signatures.mjs";

const entry=`import React from "react";import {createRoot} from "react-dom/client";
import {SignaturePanel} from "./web/signature-panel.jsx";import {SignerDirectory} from "./web/signer-directory.jsx";import {EditionsPanel} from "./web/editions-panel.jsx";
const components={SignaturePanel,SignerDirectory,EditionsPanel};
window.mount=(name,props)=>createRoot(document.getElementById("root")).render(React.createElement(components[name],props));`;
let script;
async function dom(){
  script??=(await build({stdin:{contents:entry,resolveDir:process.cwd(),loader:"jsx"},bundle:true,write:false,platform:"browser",format:"iife",
    target:"es2022",define:{"process.env.NODE_ENV":'"production"'}})).outputFiles[0].text;
  const window=new JSDOM('<html><body><div id="root"></div></body></html>',{url:"https://quill.example/",runScripts:"dangerously",pretendToBeVisual:true}).window;
  window.eval(script);
  return window;
}
const waitFor=async predicate=>{for(let i=0;i<200;i++){const value=predicate();if(value)return value;await new Promise(r=>setTimeout(r,5));}throw Error("Expected UI state did not appear");};
const button=(window,text)=>[...window.document.querySelectorAll("button")].find(b=>b.textContent===text);
const tenantId="11111111-1111-4111-8111-111111111111",editionId="33333333-3333-4333-8333-333333333333";
const digest="ab".repeat(32);
const issued=(kind,passkey=null)=>({intentId:"55555555-5555-4555-8555-555555555555",signingDigest:digest,passkey,
  intent:{kind,editionDigest:"cd".repeat(32),artifactDigest:null,capacity:kind==="execution"?"Secretary, Acme Inc.":null,
    consentText:"I consent to this exact edition.",consentVersion:kind+"-consent-v1",expiresAt:"2026-11-14T12:15:00.000Z"}});

test("signature panel draws with the keyboard, gates on explicit consent and states marks are not identity proof",async()=>{
  const window=await dom(),calls=[];
  const api=async(path,{method="GET",body}={})=>{
    calls.push({path,method,body});
    if(path.endsWith("/signatures/mine"))return {items:[]};
    if(path.endsWith("/intents"))return issued("approval");
    if(path.endsWith("/signatures"))return {recordDigest:"ef".repeat(32)};
    throw Object.assign(Error("unexpected"),{code:"UNEXPECTED"});
  };
  try{
    window.mount("SignaturePanel",{tenantId,editionId,editionKind:"final",api});
    await waitFor(()=>button(window,"Review and sign"));
    const select=window.document.querySelector("select");
    select.value="approval";select.dispatchEvent(new window.Event("change",{bubbles:true}));
    button(window,"Review and sign").click();
    await waitFor(()=>window.document.querySelector("blockquote"));
    assert.match(window.document.body.textContent,/presentation only\. It is not proof of your identity/);
    [...window.document.querySelectorAll("input[name=mark]")][1].click();
    const pad=await waitFor(()=>window.document.querySelector("[role=application]"));
    const press=key=>pad.dispatchEvent(new window.KeyboardEvent("keydown",{key,bubbles:true}));
    press("Enter");await waitFor(()=>/Pen down/.test(window.document.body.textContent));
    for(const key of ["ArrowRight","ArrowRight","ArrowDown"]){press(key);await new Promise(r=>setTimeout(r,5));}
    press("Escape");
    const submit=button(window,"Sign");
    assert.equal(submit.disabled,true,"no signature without explicit consent");
    window.document.querySelector("input[type=checkbox]").click();
    await waitFor(()=>!button(window,"Sign").disabled);
    button(window,"Sign").click();
    await waitFor(()=>calls.some(c=>c.path.endsWith("/signatures")&&c.method==="POST"));
    const sent=JSON.parse(JSON.stringify(calls.find(c=>c.path.endsWith("/signatures")&&c.method==="POST").body));
    assert.deepEqual(sent,{intentId:issued().intentId,signingDigest:digest,consent:true,
      mark:{type:"drawn",strokes:[[500,200,510,200,520,200,520,210]]},display:{visibility:"private"}});
    await waitFor(()=>/Signature recorded/.test(window.document.body.textContent));
  }finally{window.close();}
});

test("execution signing obtains a passkey assertion for the exact signing challenge",async()=>{
  const window=await dom(),calls=[],challenges=[];
  const passkey={required:true,challenge:signingChallenge(digest),rpId:"quill.example",allowCredentials:[{id:"cred",transports:["internal"]}]};
  const api=async(path,{method="GET",body}={})=>{
    calls.push({path,method,body});
    if(path.endsWith("/signatures/mine"))return {items:[]};
    if(path.endsWith("/intents"))return issued("execution",passkey);
    return {recordDigest:"ef".repeat(32)};
  };
  const authenticate=async options=>{challenges.push(options.challenge);return {id:"cred",response:{}};};
  try{
    window.mount("SignaturePanel",{tenantId,editionId,editionKind:"adopted",api,authenticate});
    await waitFor(()=>button(window,"Review and sign"));
    const select=window.document.querySelector("select");
    select.value="execution";select.dispatchEvent(new window.Event("change",{bubbles:true}));
    button(window,"Review and sign").click();
    await waitFor(()=>/Signing as: Secretary, Acme Inc\./.test(window.document.body.textContent));
    const name=window.document.querySelector("input:not([type])");
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,"value").set.call(name,"Pat Signer");
    name.dispatchEvent(new window.Event("input",{bubbles:true}));
    window.document.querySelector("input[type=checkbox]").click();
    const go=await waitFor(()=>{const b=button(window,"Confirm with passkey and sign");return b&&!b.disabled&&b;});
    go.click();
    await waitFor(()=>calls.some(c=>c.path.endsWith("/signatures")&&c.method==="POST"));
    assert.deepEqual(challenges,[passkey.challenge]);
    const sent=JSON.parse(JSON.stringify(calls.find(c=>c.path.endsWith("/signatures")&&c.method==="POST").body));
    assert.deepEqual(sent.passkey,{id:"cred",response:{}});
    assert.deepEqual(sent.mark,{type:"typed",text:"Pat Signer",fontId:"dancing-script"});
  }finally{window.close();}
});

test("signer directory shows counts, opted-in names only and pages with the server cursor",async()=>{
  const window=await dom(),paths=[];
  const api=async path=>{
    paths.push(path);
    if(path.includes("/manifests?"))return {items:[]};
    return path.includes("after=")
      ?{total:3,publiclyNamed:2,items:[{name:"Blair",signedAt:"2026-11-14T00:00:00.000Z",recordDigest:"2".repeat(64)}],nextCursor:null}
      :{total:3,publiclyNamed:2,items:[{name:"Avery",signedAt:"2026-11-14T00:00:00.000Z",recordDigest:"1".repeat(64)}],nextCursor:"WzEsMl0"};
  };
  try{
    window.mount("SignerDirectory",{editionId,kind:"support",api});
    await waitFor(()=>/3 active signature\(s\); 2 publicly named/.test(window.document.body.textContent));
    button(window,"Load more signers").click();
    await waitFor(()=>window.document.querySelectorAll("ol li").length===2);
    assert.ok(paths.some(p=>p.includes("after=WzEsMl0")));
    assert.equal(button(window,"Load more signers"),undefined);
  }finally{window.close();}
});

test("editions panel freezes only after the immutability acknowledgement and reuses the command on retry",async()=>{
  const window=await dom(),posts=[];let fail=true;
  const api=async(path,{method="GET",body}={})=>{
    if(method==="POST"){posts.push(body);if(fail){fail=false;throw Object.assign(Error("offline"),{status:503,code:"SERVICE_UNAVAILABLE"});}
      return {sequence:1,editionDigest:"9".repeat(64)};}
    if(path.includes("/history"))return {items:[{version:2,digest:"8".repeat(64)}]};
    return {items:[]};
  };
  try{
    window.mount("EditionsPanel",{tenantId,documentId:editionId,role:"owner",api});
    const freeze=await waitFor(()=>button(window,"Freeze edition"));
    await waitFor(()=>window.document.querySelectorAll("option").length>3);
    assert.equal(freeze.disabled,true);
    window.document.querySelector("input[type=checkbox]").click();
    await waitFor(()=>!button(window,"Freeze edition").disabled);
    button(window,"Freeze edition").click();
    await waitFor(()=>/Retrying sends the same command/.test(window.document.body.textContent));
    button(window,"Freeze edition").click();
    await waitFor(()=>/Edition 1 frozen/.test(window.document.body.textContent));
    assert.equal(posts.length,2);
    assert.equal(posts[0].commandId,posts[1].commandId);
    assert.deepEqual({...posts[0],commandId:undefined},{commandId:undefined,kind:"final",sourceVersion:2,sourceDigest:"8".repeat(64)});
  }finally{window.close();}
});
