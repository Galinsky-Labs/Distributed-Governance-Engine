import {test} from "node:test";
import assert from "node:assert/strict";
import {
  evaluateWeightedDecision,normalizeWeightedPolicySettings,createWeightedSnapshot,
  validateWeightedSnapshot,describeWeightedPolicy,verifyWeightedDecisionReceipt,certificateDigest,
} from "../src/weighted-governance.mjs";

const policy=(over={})=>{
  const weighting=over.weighting??"units";
  const settings=normalizeWeightedPolicySettings(over.settings??{},{weighting});
  return {id:"policy-1",weighting,opensAt:0,closesAt:10,challengeWindowMs:0,
    minYes:settings.minYes,quorum:settings.quorum,approval:settings.approval,classRequirements:settings.classRequirements};
};
const electorate=(members,exclusions={})=>({id:"electorate-1",kind:"frozen",source:"roster",rosterId:"roster-1",
  rosterKind:"unit-register",recordDate:0,members,exclusions});
const evaluate=(p,e,ballots,now=10)=>evaluateWeightedDecision({mode:"collaboration",policy:p,electorate:e,ballots,now});

test("exact integer weighted tallies stay exact for 78-digit unit holdings",()=>{
  const huge="9".repeat(77);
  const e=electorate([
    {principalId:"a",classes:{common:huge}},
    {principalId:"b",classes:{common:huge,preferred:"1"}},
    {principalId:"c",classes:{common:"1"}},
  ]);
  const p=policy({settings:{quorum:{kind:"fraction-weight",numerator:"1",denominator:"2"}}});
  const r=evaluate(p,e,[{principalId:"a",choice:"yes"},{principalId:"b",choice:"no"},{principalId:"c",choice:"yes"}]);
  assert.equal(r.overall.eligibleWeight,(BigInt(huge)*2n+2n).toString());
  assert.equal(r.overall.yes,(BigInt(huge)+1n).toString());
  assert.equal(r.overall.no,(BigInt(huge)+1n).toString());
  assert.equal(r.status,"failed","an exact tie fails a strict majority");
  assert.equal(r.overall.approval.denominatorName,"yes+no-weight");
  assert.equal(r.overall.quorum.denominatorName,"eligible-weight");
  const once=evaluate(p,e,[{principalId:"a",choice:"yes"},{principalId:"b",choice:"no"},{principalId:"c",choice:"abstain"}]);
  assert.equal(once.status,"failed");
  const win=evaluate(p,e,[{principalId:"a",choice:"yes"},{principalId:"c",choice:"yes"}]);
  assert.equal(win.status,"passed","participation of exactly half the units meets an at-least-half quorum");
  assert.equal(win.overall.quorum.met,true);
  assert.equal(win.overall.approval.met,true);
  assert.equal(win.passed,true);
});

test("a required class approval can never be bypassed by the overall majority",()=>{
  const e=electorate([
    {principalId:"a",classes:{common:"1000"}},
    {principalId:"b",classes:{"preferred-a":"10"}},
    {principalId:"c",classes:{"preferred-a":"10"}},
  ]);
  const p=policy({settings:{quorum:{kind:"fraction-weight",numerator:"1",denominator:"2"},classRequirements:[
    {class:"preferred-a",quorum:{numerator:"1",denominator:"2"},approval:{basis:"decisive",comparison:"gt",numerator:"1",denominator:"2"}},
  ]}});
  const vetoed=evaluate(p,e,[{principalId:"a",choice:"yes"},{principalId:"b",choice:"no"},{principalId:"c",choice:"no"}]);
  assert.equal(vetoed.overall.approval.met,true);
  assert.equal(vetoed.classes[0].approval.met,false);
  assert.equal(vetoed.classes[0].approval.denominatorName,"class-yes+no-weight");
  assert.equal(vetoed.status,"failed");
  const silent=evaluate(p,e,[{principalId:"a",choice:"yes"}]);
  assert.equal(silent.classes[0].quorum.met,false,"class quorum is independent of overall quorum");
  assert.equal(silent.status,"failed");
  const approved=evaluate(p,e,[{principalId:"a",choice:"yes"},{principalId:"b",choice:"yes"}]);
  assert.equal(approved.status,"passed");
  assert.throws(()=>createWeightedSnapshot({id:"d",tenantId:"t",documentId:"x",mode:"collaboration",
    proposals:[{proposalId:"p",proposalDigest:"a".repeat(64)}],createdAt:1,
    policy:policy({settings:{classRequirements:[{class:"absent",quorum:{numerator:"1",denominator:"2"},approval:{basis:"decisive",comparison:"gt",numerator:"1",denominator:"2"}}]}}),
    electorate:e}),/Required class has no eligible members/);
});

test("proxies: direct vote wins, allocations cannot exceed units, ballots cannot carry weight",()=>{
  const e=electorate([{principalId:"p",classes:{common:"100"}},{principalId:"x",classes:{common:"50"}},{principalId:"y",classes:{common:"1"}}]);
  const p=policy();
  const split=[
    {principalId:"p",proxyId:"x",grantId:"g1",choice:"yes",allocation:{common:"60"}},
    {principalId:"p",proxyId:"y",grantId:"g2",choice:"no",allocation:{common:"40"}},
  ];
  const r=evaluate(p,e,split);
  assert.equal(r.overall.yes,"60");assert.equal(r.overall.no,"40");assert.equal(r.overall.participatingHeads,"1");
  assert.equal(r.proxies.counted,2);
  const direct=evaluate(p,e,[...split,{principalId:"p",choice:"abstain"}]);
  assert.equal(direct.overall.abstain,"100");assert.equal(direct.overall.yes,"0");
  assert.equal(direct.proxies.supersededByDirect,2);
  assert.throws(()=>evaluate(p,e,[...split,{principalId:"p",proxyId:"y",grantId:"g3",choice:"no",allocation:{common:"1"}}]),/exceeds/);
  assert.throws(()=>evaluate(p,e,[{principalId:"p",proxyId:"x",grantId:"g1",choice:"yes",allocation:"all"},
    {principalId:"p",proxyId:"y",grantId:"g2",choice:"yes",allocation:{common:"1"}}]),/exceeds/);
  assert.throws(()=>evaluate(p,e,[{principalId:"p",choice:"yes",weight:"1000"}]),/own weight/);
  assert.throws(()=>evaluate(p,e,[{principalId:"p",choice:"yes"},{principalId:"p",choice:"no"}]),/Duplicate/);
  assert.throws(()=>evaluate(p,e,[{principalId:"z",choice:"yes"}]),/Ineligible/);
  const equal=policy({weighting:"equal"});
  assert.throws(()=>evaluate(equal,e,[split[0]]),/whole-holding/);
  const whole=evaluate(equal,e,[{principalId:"p",proxyId:"x",grantId:"g1",choice:"yes",allocation:"all"}]);
  assert.equal(whole.overall.yes,"1");assert.equal(whole.overall.eligibleWeight,"3");
});

test("snapshots are digest bound, frozen and describe every denominator",()=>{
  const e=electorate([{principalId:"a",classes:{common:"2"}}],{"duplicate-person-key":2});
  const snapshot=createWeightedSnapshot({id:"d",tenantId:"t",documentId:"x",mode:"collaboration",
    proposals:[{proposalId:"p",proposalDigest:"a".repeat(64)}],createdAt:1,policy:policy(),electorate:e});
  assert.equal(validateWeightedSnapshot(structuredClone(snapshot)).snapshotDigest,snapshot.snapshotDigest);
  const tampered=structuredClone(snapshot);tampered.electorate.members[0].classes.common="3";
  assert.throws(()=>validateWeightedSnapshot(tampered),/modified/);
  assert.ok(Object.isFrozen(snapshot.electorate.members[0]));
  const description=describeWeightedPolicy(snapshot.policy);
  assert.match(description.approval,/yes\/no voting units/);
  const certificate={schemaVersion:2,kind:"governance-decision-record-not-execution",documentId:"x",proposalId:"p",
    executed:false,canAdopt:false,finality:"final",application:"not-passed"};
  const receipt={schemaVersion:2,documentId:"x",proposalId:"p",certificate,certificateDigest:certificateDigest(certificate),
    verification:"content-digest-only",externalAnchorVerified:false,legallyExecuted:false};
  assert.equal(verifyWeightedDecisionReceipt(receipt).checksumValid,true);
  assert.equal(verifyWeightedDecisionReceipt({...receipt,certificate:{...certificate,finality:"void"}}).checksumValid,false);
});

// Deterministic property campaign against an independent naive reference.
function prng(seed){let s=seed>>>0;return()=>{s=(s+0x6d2b79f5)>>>0;let t=s;t=Math.imul(t^(t>>>15),t|1);t^=t+Math.imul(t^(t>>>7),t|61);return((t^(t>>>14))>>>0)/4294967296;};}
function reference({policy:p,members,ballots}){
  // Plain Number arithmetic over tiny values; exactness is guaranteed by the bounds.
  const equal=p.weighting==="equal";
  const effective=[];
  for(const m of members){
    const own=ballots.find(b=>b.principalId===m.principalId&&b.proxyId===undefined);
    if(own){effective.push({m,choice:own.choice,alloc:m.classes});continue;}
    for(const b of ballots.filter(b=>b.principalId===m.principalId&&b.proxyId!==undefined))
      effective.push({m,choice:b.choice,alloc:b.allocation==="all"?m.classes:b.allocation});
  }
  const sum=o=>Object.values(o).reduce((a,v)=>a+Number(v),0);
  const weight=alloc=>equal?1:sum(alloc);
  const eligibleWeight=members.reduce((a,m)=>a+weight(m.classes),0),eligibleHeads=members.length;
  const tally={yes:0,no:0,abstain:0};
  for(const e of effective)tally[e.choice]+=weight(e.alloc);
  const heads=new Set(effective.map(e=>e.m.principalId)).size;
  const participatingWeight=tally.yes+tally.no+tally.abstain;
  const q=p.quorum;
  const quorumMet=q.kind==="count"?heads>=Number(q.minimum):q.kind==="weight"?participatingWeight>=Number(q.minimum):
    q.kind==="fraction-count"?heads*Number(q.denominator)>=eligibleHeads*Number(q.numerator):
    participatingWeight*Number(q.denominator)>=eligibleWeight*Number(q.numerator);
  const approve=(rule,t,eligible,minYes=0)=>{
    const d=rule.basis==="eligible"?eligible:rule.basis==="participating"?t.yes+t.no+t.abstain:t.yes+t.no;
    if(d===0||t.yes<minYes)return false;
    const l=t.yes*Number(rule.denominator),r=d*Number(rule.numerator);
    return rule.comparison==="gt"?l>r:l>=r;
  };
  const approvalMet=approve(p.approval,tally,eligibleWeight,Number(p.minYes));
  const classes=p.classRequirements.map(req=>{
    const cw=(alloc)=>alloc[req.class]===undefined?0:equal?1:Number(alloc[req.class]);
    const eligible=members.reduce((a,m)=>a+cw(m.classes),0);
    const t={yes:0,no:0,abstain:0};
    for(const e of effective)t[e.choice]+=cw(e.alloc);
    const part=t.yes+t.no+t.abstain;
    const qm=eligible>0&&part*Number(req.quorum.denominator)>=eligible*Number(req.quorum.numerator);
    return qm&&approve(req.approval,t,eligible);
  });
  return {quorumMet,approvalMet,passed:quorumMet&&approvalMet&&classes.every(Boolean),tally,classes,eligibleWeight};
}
test("property campaign: evaluator agrees with a naive reference on 3000 random decisions",()=>{
  const rand=prng(20261114);
  const int=(lo,hi)=>lo+Math.floor(rand()*(hi-lo+1));
  const pick=a=>a[int(0,a.length-1)];
  const classNames=["common","preferred-a","preferred-b"];
  let passedCount=0,checked=0;
  for(let run=0;run<3000;run++){
    const weighting=rand()<0.3?"equal":"units";
    const members=[];
    const n=int(1,12);
    for(let i=0;i<n;i++){
      const classes={};
      for(const c of classNames)if(rand()<0.5)classes[c]=String(int(1,1000));
      if(!Object.keys(classes).length)classes.common=String(int(1,1000));
      members.push({principalId:"m"+String(i).padStart(3,"0"),classes});
    }
    const fractionValue=()=>{const d=int(1,7);return {numerator:String(int(1,d)),denominator:String(d)};};
    const approval=()=>{const f=fractionValue();const comparison=f.numerator===f.denominator?"gte":pick(["gt","gte"]);
      return {basis:pick(["decisive","participating","eligible"]),comparison,...f};};
    const kinds=weighting==="units"?["count","weight","fraction-count","fraction-weight"]:["count","fraction-count"];
    const kind=pick(kinds);
    const quorum=kind.startsWith("fraction")?{kind,...fractionValue()}:{kind,minimum:String(int(1,kind==="weight"?2000:n))};
    const present=[...new Set(members.flatMap(m=>Object.keys(m.classes)))];
    const requirements=present.filter(()=>rand()<0.35).map(c=>({class:c,quorum:fractionValue(),approval:approval()}));
    const p=policy({weighting,settings:{minYes:String(int(1,weighting==="equal"?3:500)),quorum,approval:approval(),classRequirements:requirements}});
    const ballots=[];
    for(const m of members){
      const r=rand();
      if(r<0.45)ballots.push({principalId:m.principalId,choice:pick(["yes","no","abstain"])});
      if(r>0.3&&r<0.75){
        if(weighting==="equal"||rand()<0.3)ballots.push({principalId:m.principalId,proxyId:"proxy-1",grantId:"g-"+m.principalId,choice:pick(["yes","no","abstain"]),allocation:"all"});
        else{
          const [first]=Object.keys(m.classes);const total=BigInt(m.classes[first]);
          const a=BigInt(int(1,Number(total)));
          ballots.push({principalId:m.principalId,proxyId:"proxy-1",grantId:"g1-"+m.principalId,choice:pick(["yes","no","abstain"]),allocation:{[first]:a.toString()}});
          if(total-a>0n)ballots.push({principalId:m.principalId,proxyId:"proxy-2",grantId:"g2-"+m.principalId,choice:pick(["yes","no","abstain"]),allocation:{[first]:(total-a).toString()}});
        }
      }
    }
    const e=electorate(members);
    const actual=evaluate(p,e,ballots);
    const expected=reference({policy:p,members,ballots});
    assert.equal(actual.overall.quorum.met,expected.quorumMet,"quorum run "+run);
    assert.equal(actual.overall.approval.met,expected.approvalMet,"approval run "+run);
    assert.deepEqual(actual.classes.map(c=>c.met),expected.classes,"classes run "+run);
    assert.equal(actual.passed,expected.passed,"outcome run "+run);
    assert.equal(actual.overall.eligibleWeight,String(expected.eligibleWeight));
    for(const choice of ["yes","no","abstain"])assert.equal(actual.overall[choice],String(expected.tally[choice]));
    // Partition: per-class eligible totals sum to the overall eligible weight under unit weighting.
    if(weighting==="units"&&p.classRequirements.length===present.length)
      assert.equal(actual.classes.reduce((a,c)=>a+BigInt(c.eligibleWeight),0n).toString(),actual.overall.eligibleWeight);
    if(actual.passed)passedCount++;
    checked++;
  }
  assert.equal(checked,3000);
  assert.ok(passedCount>100&&passedCount<2900,"campaign exercises both outcomes: "+passedCount);
});
