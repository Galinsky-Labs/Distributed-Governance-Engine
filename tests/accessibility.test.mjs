// DCE-033: automated axe-core audit of rendered engine UI in jsdom. jsdom has
// no layout engine, so colour contrast, target size and reflow are out of
// scope here and stay with manual and real-browser checks.
import {before,after,test} from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {createRequire} from "node:module";
import {build} from "esbuild";
import {JSDOM} from "jsdom";
import {openWorld,origin,id} from "./governance-fixture.mjs";

const axeSource=await readFile(createRequire(import.meta.url).resolve("axe-core/axe.min.js"),"utf8");
let w;
before(async()=>{w=await openWorld();await w.reset();});
after(async()=>w?.db.close());

const entry=`
import React from "react";
import {createRoot} from "react-dom/client";
import {DecisionPanel} from "./web/decision-panel.jsx";
import {ModerationPanel} from "./web/moderation-panel.jsx";
import {ElectoratePanel} from "./web/electorate-panel.jsx";
import {SectionGrantsPanel} from "./web/section-grants-panel.jsx";
import {LanguagePicker} from "./web/language-picker.jsx";
import {VerifyPage} from "./web/verify-page.jsx";
import {SigninPage} from "./web/signin-page.jsx";
window.mountAll=(props)=>createRoot(document.getElementById("root")).render(<main>
  <h1>Accessibility audit</h1>
  <LanguagePicker value="en" onChange={()=>{}}/>
  <DecisionPanel tenantId={props.tenantId} documentId={props.documentId} proposalId={props.proposalId} role="owner"/>
  <ModerationPanel tenantId={props.tenantId} role="owner"/>
  <ElectoratePanel tenantId={props.tenantId} role="owner"/>
  <SectionGrantsPanel tenantId={props.tenantId} documentId={props.documentId} role="owner" sections={[{id:"s-board",title:"Board"}]}/>
  <VerifyPage/>
  <SigninPage/>
</main>);`;

async function render(lang){
  const {tenantId,owner}=w,doc=await w.document(),author=await w.member();
  const proposal=await w.propose(author,doc);
  await w.decisions.open(owner,tenantId,doc.id,proposal.proposal.id,{hours:1,commandId:id()});
  await w.electorates.createRoster(owner,tenantId,{kind:"unit-register",name:"Share register",commandId:id()});
  const output=await build({stdin:{contents:entry,resolveDir:process.cwd(),loader:"jsx"},bundle:true,write:false,outdir:"unused",
    platform:"browser",format:"iife",target:"es2022",define:{"process.env.NODE_ENV":'"production"'},logLevel:"error"});
  const dom=new JSDOM(`<!doctype html><html lang="${lang}"><head><title>Audit</title></head><body><div id="root"></div></body></html>`,{url:origin+"/",runScripts:"dangerously",pretendToBeVisual:true,
    beforeParse(window){
      window.structuredClone=value=>window.JSON.parse(window.JSON.stringify(value));
      window.TextEncoder=TextEncoder;
      if(!window.crypto?.randomUUID)Object.defineProperty(window,"crypto",{value:globalThis.crypto});
      Object.defineProperty(window.document,"cookie",{get:()=>"__Host-dge_csrf="+owner.csrfToken});
      window.fetch=async(path,init={})=>w.handler(new Request(new URL(path,origin),{method:init.method??"GET",body:init.body,
        headers:{...init.headers,origin,cookie:"__Host-dge_session="+owner.sessionToken}}),{peerAddress:"127.0.0.1"});
    }});
  dom.window.eval(output.outputFiles[0].text);
  dom.window.mountAll({tenantId,documentId:doc.id,proposalId:proposal.proposal.id});
  const text=()=>dom.window.document.body.textContent;
  for(let i=0;i<300&&!(text().includes("Share register"));i++)await new Promise(r=>setTimeout(r,10));
  await new Promise(r=>setTimeout(r,100));
  return dom;
}

async function audit(dom){
  dom.window.eval(axeSource);
  return dom.window.axe.run(dom.window.document,{
    runOnly:{type:"tag",values:["wcag2a","wcag2aa","wcag21a","wcag21aa","wcag22aa"]},
    rules:{"color-contrast":{enabled:false},"target-size":{enabled:false}},
  });
}

test("rendered governance, sign-in, verify and language UI has no automated WCAG A/AA violations",async()=>{
  const dom=await render("en");
  try{
    const result=await audit(dom);
    const report=[...result.violations].map(v=>v.id+" ("+v.impact+"): "+v.nodes.slice(0,3).map(n=>n.target.join(" ")).join(", "));
    assert.equal(report.length,0,"axe violations:\n"+report.join("\n"));
    assert.ok(result.passes.length>10,"axe actually evaluated rules");
    // Control: the same harness does report a known failure.
    const probe=dom.window.document.createElement("input");probe.type="text";
    dom.window.document.querySelector("main").append(probe);
    const control=await audit(dom);
    assert.ok([...control.violations].some(v=>v.id==="label"),"axe flags an unlabeled input in this harness");
  }finally{dom.window.close();}
});

test("every interactive control is reachable without a pointer: named, focusable and not removed from tab order",async()=>{
  const dom=await render("en");
  try{
    const controls=[...dom.window.document.querySelectorAll("button,input,select,textarea,a[href]")];
    assert.ok(controls.length>5);
    for(const c of controls){
      assert.notEqual(c.getAttribute("tabindex"),"-1","control removed from tab order: "+c.outerHTML.slice(0,80));
      const named=(c.textContent.trim()||c.getAttribute("aria-label")||c.getAttribute("aria-labelledby")||c.labels?.length||c.getAttribute("title"));
      assert.ok(named,"unnamed control: "+c.outerHTML.slice(0,120));
    }
  }finally{dom.window.close();}
});
