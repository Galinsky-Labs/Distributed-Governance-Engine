// DCE-031: role/mode-aware walkthrough with resume, reset, Escape/focus return,
// reduced motion and missing targets; it never performs governance actions.
import test from "node:test";
import assert from "node:assert/strict";
import {build} from "esbuild";
import {JSDOM} from "jsdom";
import {planWalkthrough,savedStep,WALKTHROUGH_STEPS} from "../web/walkthrough-plan.mjs";

test("planner: roles, modes, missing targets and feedback-mode explanations",()=>{
  const all=()=>true;
  const viewer=planWalkthrough({role:"viewer",mode:"collaboration",present:all}).map(s=>s.target);
  assert.ok(!viewer.includes("ballot")&&!viewer.includes("admin")&&!viewer.includes("suggest"),"viewers are not shown controls they cannot use");
  const owner=planWalkthrough({role:"owner",mode:"collaboration",present:all}).map(s=>s.target);
  assert.ok(owner.includes("admin")&&owner.includes("ballot"));
  assert.ok(!planWalkthrough({role:"participant",mode:"collaboration",present:all}).some(s=>s.target==="admin"));
  const feedback=planWalkthrough({role:"participant",mode:"public-input",present:all});
  assert.ok(!feedback.some(s=>s.target==="editor"),"fixed sources skip editing steps");
  assert.match(feedback.find(s=>s.target==="ballot").body,/advisory/);
  assert.match(feedback.find(s=>s.target==="suggest").body,/cannot change this text/);
  assert.deepEqual(planWalkthrough({role:"owner",present:t=>t==="history"}).map(s=>s.target),["history"]);
  assert.throws(()=>planWalkthrough({mode:"consultation"}),/Invalid document mode/);
  // Console pages do not know the viewer's role: presence of the rendered control decides.
  assert.deepEqual(planWalkthrough({present:t=>["admin","signatures"].includes(t)}).map(s=>s.target),["signatures","admin"]);
  for(const [, , body] of WALKTHROUGH_STEPS)assert.ok(!/click here to vote|will cast/i.test(body));
});

test("saved step tolerates broken storage and out-of-range values",()=>{
  assert.equal(savedStep("x",5,{getItem(){throw Error("blocked");}}),0);
  assert.equal(savedStep("x",5,{getItem:()=>"9"}),0);
  assert.equal(savedStep("x",5,{getItem:()=>"3"}),3);
});

const entry=`import React from "react";import {createRoot} from "react-dom/client";import {Walkthrough} from "./web/walkthrough.jsx";
window.mount=(props)=>{const root=createRoot(document.getElementById("tour"));const render=open=>root.render(open?<Walkthrough {...props} onClose={()=>{window.closed++;render(false);}}/>:null);render(true);};`;
async function page(){
  const out=await build({stdin:{contents:entry,resolveDir:process.cwd(),loader:"jsx"},bundle:true,write:false,outdir:"x",platform:"browser",format:"iife",define:{"process.env.NODE_ENV":'"production"'},logLevel:"error"});
  const dom=new JSDOM(`<body><button id="opener">Take a tour</button><div data-tour="mode">Mode</div><div data-tour="points">Points</div><div data-tour="ballot">Ballot</div><div data-tour="history">History</div><div id="tour"></div></body>`,
    {url:"https://quill.example/",runScripts:"dangerously",pretendToBeVisual:true,beforeParse(w){
      w.fetch=()=>{w.fetched=(w.fetched??0)+1;return Promise.reject(Error("no network"));};
      w.matchMedia=q=>({matches:q.includes("reduce"),media:q});w.closed=0;w.scrolls=[];
      w.Element.prototype.scrollIntoView=function(o){w.scrolls.push(o);};
    }});
  dom.window.eval(out.outputFiles[0].text);
  return dom;
}
const tick=()=>new Promise(r=>setTimeout(r,60));

test("browser behaviour: resume, reset, Escape with focus return, reduced motion, no network actions",async()=>{
  const dom=await page(),{document}=dom.window,store=new Map();
  const storage={getItem:k=>store.get(k)??null,setItem:(k,v)=>store.set(k,v),removeItem:k=>store.delete(k)};
  const button=t=>[...document.querySelectorAll("button")].find(b=>b.textContent===t);
  try{
    document.getElementById("opener").focus();
    dom.window.mount({id:"t1",role:"participant",mode:"collaboration",storage});await tick();
    assert.match(document.querySelector(".tour").textContent,/STEP 1 OF 4/,"missing targets are skipped");
    assert.equal(document.activeElement.id,"walkthrough-title");
    assert.ok(document.querySelector('[data-tour="mode"]').classList.contains("tour-target"));
    assert.equal(dom.window.scrolls.at(-1).behavior,"auto","reduced motion avoids smooth scrolling");
    button("Next").click();await tick();button("Next").click();await tick();
    assert.match(document.querySelector(".tour").textContent,/Vote on frozen wording/);
    dom.window.dispatchEvent(new dom.window.KeyboardEvent("keydown",{key:"Escape"}));await tick();
    assert.equal(document.querySelector(".tour"),null);
    assert.equal(document.activeElement.id,"opener","focus returns to the control that opened the tour");
    assert.equal(store.get("dge-walkthrough:t1"),"2");
    dom.window.mount({id:"t1",role:"participant",mode:"collaboration",storage});await tick();
    assert.match(document.querySelector(".tour").textContent,/STEP 3 OF 4/,"resumes at the saved step");
    button("Start over").click();await tick();
    assert.match(document.querySelector(".tour").textContent,/STEP 1 OF 4/);
    for(let i=0;i<3;i++){button("Next").click();await tick();}
    button("Finish").click();await tick();
    assert.equal(store.has("dge-walkthrough:t1"),false,"finishing clears the saved step");
    assert.equal(dom.window.fetched??0,0,"the walkthrough performs no requests and so cannot vote or sign");
  }finally{dom.window.close();}
});
