import {before,after,test} from "node:test";
import assert from "node:assert/strict";
import {build} from "esbuild";
import {JSDOM} from "jsdom";
import {openWorld,origin,id} from "./governance-fixture.mjs";

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
window.mountGovernance=(props)=>createRoot(document.getElementById("root")).render(<>
  <DecisionPanel tenantId={props.tenantId} documentId={props.documentId} proposalId={props.proposalId} role="owner"/>
  <ModerationPanel tenantId={props.tenantId} role="owner"/>
  <ElectoratePanel tenantId={props.tenantId} role="owner"/>
  <SectionGrantsPanel tenantId={props.tenantId} documentId={props.documentId} role="owner" sections={[{id:"s-board",title:"Board"}]}/>
</>);`;

test("governance panels render live server state and act through the real routes with CSRF",async()=>{
  const {tenantId,owner}=w,doc=await w.document(),author=await w.member();
  const proposal=await w.propose(author,doc);
  await w.decisions.open(owner,tenantId,doc.id,proposal.proposal.id,{hours:1,commandId:id(),challengeWindowHours:24});
  await w.decisions.cast(owner,tenantId,doc.id,proposal.proposal.id,{choice:"yes",expectedVersion:0,commandId:id()});
  w.time+=3600001;
  await w.decisions.close(owner,tenantId,doc.id,proposal.proposal.id);
  for(let i=0;i<3;i++)await w.moderation.report(await w.member(),tenantId,{targetKind:"proposal",targetId:proposal.proposal.id,reasonCategory:"spam",commandId:id()});
  await w.electorates.createRoster(owner,tenantId,{kind:"unit-register",name:"Share register",commandId:id()});
  await w.sectionGrants.grant(owner,tenantId,doc.id,{sectionId:"s-board",grantee:{kind:"role",role:"participant"},rights:["propose"],commandId:id()});
  const output=await build({stdin:{contents:entry,resolveDir:process.cwd(),loader:"jsx"},bundle:true,write:false,outdir:"unused",
    platform:"browser",format:"iife",target:"es2022",define:{"process.env.NODE_ENV":'"production"'},logLevel:"error"});
  const dom=new JSDOM('<html><body><div id="root"></div></body></html>',{url:origin+"/",runScripts:"dangerously",pretendToBeVisual:true,
    beforeParse(window){
      window.structuredClone=value=>window.JSON.parse(window.JSON.stringify(value));
      window.TextEncoder=TextEncoder;
      if(!window.crypto?.randomUUID)Object.defineProperty(window,"crypto",{value:globalThis.crypto});
      Object.defineProperty(window.document,"cookie",{get:()=>"__Host-dge_csrf="+owner.csrfToken});
      window.fetch=async(path,init={})=>w.handler(new Request(origin+path,{method:init.method??"GET",body:init.body,
        headers:{...init.headers,origin,cookie:"__Host-dge_session="+owner.sessionToken}}),{peerAddress:"127.0.0.1"});
    }});
  const document=dom.window.document;
  const waitFor=async(predicate,label)=>{for(let i=0;i<300;i++){if(predicate())return;await new Promise(r=>setTimeout(r,10));}throw Error("UI never showed: "+label);};
  try{
    dom.window.eval(output.outputFiles[0].text);
    dom.window.mountGovernance({tenantId,documentId:doc.id,proposalId:proposal.proposal.id});
    const text=()=>document.body.textContent;
    await waitFor(()=>text().includes("Finality: provisional"),"provisional finality");
    assert.ok([...document.querySelectorAll("button")].some(b=>b.textContent==="Finalize after challenge window"));
    await waitFor(()=>text().includes("Possible coordinated flagging"),"coordinated flag");
    await waitFor(()=>text().includes("Share register"),"roster list");
    await waitFor(()=>text().includes("Restricted: only unlocked sections"),"restriction state");
    assert.match(text(),/Allow propose on Board to role participant/);
    assert.ok(!text().includes(author.accountId),"panels never print the author's account ID");
    [...document.querySelectorAll("button")].find(b=>b.textContent==="Hide").click();
    await waitFor(()=>text().includes("Hidden with a public placeholder."),"hide acknowledgment");
    assert.equal((await w.proposals.read(doc.id,proposal.proposal.id)).moderation.state,"removed");
  }finally{dom.window.close();}
});
