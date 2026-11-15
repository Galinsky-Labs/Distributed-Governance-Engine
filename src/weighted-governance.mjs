import {digest,canonicalize,identifier,integer,invariant,validDigest} from "./integrity.mjs";

/**
 * Exact-integer weighted and class decisions (DCE-012/013). Every quantity is
 * a canonical decimal string on the way in and out and a BigInt inside; no
 * floating point, percentage or rounding is ever used. Pure functions only:
 * the caller authenticates, persists, serializes and freezes snapshots.
 */

export const CLASS_PATTERN=/^[a-z0-9][a-z0-9-]{0,39}$/;
export const DEFAULT_CLASS="default";
export const MAX_CLASS_REQUIREMENTS=16;
export const MAX_ELECTORATE=100000;
const CHOICES=["yes","no","abstain"];
const QUORUM_KINDS=["count","weight","fraction-count","fraction-weight"];
const APPROVAL_BASES=["decisive","participating","eligible"];
const FRACTION_LIMIT=1000000n;

const plain=(value,message)=>invariant(value&&typeof value==="object"&&!Array.isArray(value)&&
  [Object.prototype,null].includes(Object.getPrototypeOf(value)),message);
const only=(value,allowed,required,message)=>{
  plain(value,message);
  invariant(Object.getOwnPropertySymbols(value).length===0,message);
  for(const key of Object.getOwnPropertyNames(value)){
    const descriptor=Object.getOwnPropertyDescriptor(value,key);
    invariant(allowed.includes(key)&&descriptor.enumerable&&Object.hasOwn(descriptor,"value"),message);
  }
  for(const key of required)invariant(Object.hasOwn(value,key),message);
};
export function votingClass(value){
  invariant(typeof value==="string"&&CLASS_PATTERN.test(value),"Invalid voting class");
  return value;
}
export function units(value,{positive=false}={}){return integer(value,{positive});}
const fraction=(value,message)=>{
  only(value,["numerator","denominator"],["numerator","denominator"],message);
  const n=integer(value.numerator,{positive:true}),d=integer(value.denominator,{positive:true});
  invariant(n<=d&&d<=FRACTION_LIMIT,message);
  return {numerator:value.numerator,denominator:value.denominator};
};
const approvalRule=(value)=>{
  only(value,["basis","comparison","numerator","denominator"],["basis","comparison","numerator","denominator"],"Invalid approval rule");
  invariant(APPROVAL_BASES.includes(value.basis),"Invalid approval denominator");
  invariant(["gt","gte"].includes(value.comparison),"Invalid approval comparison");
  const f=fraction({numerator:value.numerator,denominator:value.denominator},"Invalid approval fraction");
  invariant(!(value.comparison==="gt"&&f.numerator===f.denominator),"Approval threshold must be attainable");
  return {basis:value.basis,comparison:value.comparison,...f};
};

/** Normalize caller policy settings for a weighted/class decision. */
export function normalizeWeightedPolicySettings(value,{weighting}){
  invariant(["equal","units"].includes(weighting),"Invalid weighting");
  const input=value??{};
  only(input,["minYes","minimumDeliberationHours","quorum","approval","classRequirements","tieRule","castingPrincipalId","supportFloor"],[],"Invalid weighted policy");
  const minYes=Object.hasOwn(input,"minYes")?input.minYes:"1";
  units(minYes,{positive:true});
  const hours=Object.hasOwn(input,"minimumDeliberationHours")?input.minimumDeliberationHours:0;
  invariant(Number.isSafeInteger(hours)&&!Object.is(hours,-0)&&hours>=0&&hours<=720,"Invalid minimum deliberation");
  const q=Object.hasOwn(input,"quorum")?input.quorum:{kind:"fraction-count",numerator:"1",denominator:"2"};
  plain(q,"Invalid quorum");
  invariant(QUORUM_KINDS.includes(q.kind),"Invalid quorum");
  invariant(weighting==="units"||!q.kind.endsWith("weight"),"Equal-person decisions use head-count quorum");
  let quorum;
  if(q.kind.startsWith("fraction-")){
    only(q,["kind","numerator","denominator"],["kind","numerator","denominator"],"Invalid quorum");
    quorum={kind:q.kind,...fraction({numerator:q.numerator,denominator:q.denominator},"Invalid quorum fraction")};
  }else{
    only(q,["kind","minimum"],["kind","minimum"],"Invalid quorum");
    units(q.minimum,{positive:true});
    quorum={kind:q.kind,minimum:q.minimum};
  }
  const approval=approvalRule(Object.hasOwn(input,"approval")?input.approval:
    {basis:"decisive",comparison:"gt",numerator:"1",denominator:"2"});
  const requirements=Object.hasOwn(input,"classRequirements")?input.classRequirements:[];
  invariant(Array.isArray(requirements)&&requirements.length<=MAX_CLASS_REQUIREMENTS,"Invalid class requirements");
  const seen=new Set();
  const classRequirements=requirements.map(item=>{
    only(item,["class","quorum","approval"],["class","quorum","approval"],"Invalid class requirement");
    votingClass(item.class);
    invariant(!seen.has(item.class),"Duplicate class requirement");seen.add(item.class);
    return {class:item.class,quorum:fraction(item.quorum,"Invalid class quorum"),approval:approvalRule(item.approval)};
  }).sort((a,b)=>a.class<b.class?-1:a.class>b.class?1:0);
  const extra={};
  // DCE-010 tie rules: "fails" keeps the status quo on an exact yes/no tie;
  // "casting-vote" lets one named presiding principal break it after voting.
  if(Object.hasOwn(input,"tieRule")){
    invariant(["fails","casting-vote"].includes(input.tieRule),"Invalid tie rule");
    extra.tieRule=input.tieRule;
    if(input.tieRule==="casting-vote"){identifier(input.castingPrincipalId);extra.castingPrincipalId=input.castingPrincipalId;}
    else invariant(!Object.hasOwn(input,"castingPrincipalId"),"Only a casting-vote rule names a casting principal");
  }else invariant(!Object.hasOwn(input,"castingPrincipalId"),"Only a casting-vote rule names a casting principal");
  // Open-public support floor: advisory only, published with the snapshot.
  if(Object.hasOwn(input,"supportFloor")){
    const f=input.supportFloor;
    only(f,["minimumParticipants","supportNumerator","supportDenominator"],["minimumParticipants","supportNumerator","supportDenominator"],"Invalid support floor");
    units(f.minimumParticipants,{positive:true});
    const r=fraction({numerator:f.supportNumerator,denominator:f.supportDenominator},"Invalid support floor");
    extra.supportFloor={minimumParticipants:f.minimumParticipants,supportNumerator:r.numerator,supportDenominator:r.denominator};
  }
  return {minYes,minimumDeliberationHours:hours,quorum,approval,classRequirements,...extra};
}

export function validateWeightedPolicy(p){
  only(p,["id","weighting","opensAt","closesAt","minYes","quorum","approval","classRequirements",
    "challengeWindowMs","minimumDeliberationHours","proposalPublishedAt","tieRule","castingPrincipalId","supportFloor"],
  ["id","weighting","opensAt","closesAt","minYes","quorum","approval","classRequirements","challengeWindowMs"],"Invalid weighted policy");
  identifier(p.id);
  for(const t of [p.opensAt,p.closesAt])invariant(Number.isSafeInteger(t)&&t>=0,"Invalid timestamp");
  invariant(p.closesAt>p.opensAt,"Invalid voting window");
  invariant(Number.isSafeInteger(p.challengeWindowMs)&&p.challengeWindowMs>=0&&p.challengeWindowMs<=720*3600000,"Invalid challenge window");
  const normalized=normalizeWeightedPolicySettings({minYes:p.minYes,quorum:p.quorum,approval:p.approval,
    classRequirements:p.classRequirements,
    ...(Object.hasOwn(p,"minimumDeliberationHours")?{minimumDeliberationHours:p.minimumDeliberationHours}:{}),
    ...Object.fromEntries(["tieRule","castingPrincipalId","supportFloor"].filter(k=>Object.hasOwn(p,k)).map(k=>[k,p[k]]))},{weighting:p.weighting});
  if(Object.hasOwn(p,"supportFloor"))invariant(canonicalize(normalized.supportFloor)===canonicalize(p.supportFloor),"Support floor must be canonical");
  invariant(canonicalize(normalized.classRequirements)===canonicalize(p.classRequirements),"Class requirements must be canonical");
  if(Object.hasOwn(p,"minimumDeliberationHours")||Object.hasOwn(p,"proposalPublishedAt")){
    invariant(Number.isSafeInteger(p.proposalPublishedAt)&&p.proposalPublishedAt>=0,"Invalid publication time");
    invariant(p.opensAt>=p.proposalPublishedAt+p.minimumDeliberationHours*3600000,"Vote opens before minimum deliberation");
  }
  return p;
}

/**
 * Electorate members carry voting units per class. Under "equal" weighting
 * every member is one head overall and one head in each class it belongs to;
 * units only decide class membership.
 */
export function validateWeightedElectorate(e){
  only(e,["id","kind","source","rosterId","rosterKind","recordDate","members","exclusions"],
    ["id","kind","source","members","exclusions"],"Invalid electorate");
  identifier(e.id);
  invariant(e.kind==="frozen","Only frozen electorates are supported");
  invariant(["membership","roster"].includes(e.source),"Invalid electorate source");
  if(e.source==="roster"){
    identifier(e.rosterId);
    invariant(["membership-derived","unit-register","verified-person-cohort"].includes(e.rosterKind),"Invalid roster kind");
    invariant(Number.isSafeInteger(e.recordDate)&&e.recordDate>=0,"Invalid record date");
  }else invariant(!["rosterId","rosterKind","recordDate"].some(k=>Object.hasOwn(e,k)),"Membership electorates have no roster");
  invariant(Array.isArray(e.members)&&e.members.length>0&&e.members.length<=MAX_ELECTORATE,"Invalid electorate");
  let previous="";
  for(const m of e.members){
    only(m,["principalId","classes"],["principalId","classes"],"Invalid electorate member");
    identifier(m.principalId);
    invariant(m.principalId>previous,"Electorate members must be unique and sorted");previous=m.principalId;
    plain(m.classes,"Invalid member classes");
    const names=Object.keys(m.classes);
    invariant(names.length>0&&names.length<=64,"Invalid member classes");
    for(const name of names){votingClass(name);units(m.classes[name],{positive:true});}
  }
  plain(e.exclusions,"Invalid exclusions");
  for(const [reason,count] of Object.entries(e.exclusions)){
    invariant(/^[a-z][a-z-]{1,40}$/.test(reason)&&Number.isSafeInteger(count)&&count>0,"Invalid exclusion count");
  }
  return e;
}

function freezeDeep(value){
  if(value&&typeof value==="object"){for(const child of Object.values(value))freezeDeep(child);Object.freeze(value);}
  return value;
}
const detached=value=>{canonicalize(value);return freezeDeep(structuredClone(value));};

/** Digest-bound weighted decision snapshot (schemaVersion 2). */
export function createWeightedSnapshot({id,tenantId,documentId,mode,proposals,policy,electorate,createdAt}){
  for(const value of [id,tenantId,documentId])identifier(value);
  invariant(["collaboration","public-input"].includes(mode),"Invalid mode");
  invariant(Array.isArray(proposals)&&proposals.length>=1&&proposals.length<=20,"Invalid proposal bundle");
  const ids=new Set();
  for(const p of proposals){
    only(p,["proposalId","proposalDigest"],["proposalId","proposalDigest"],"Invalid bundle entry");
    identifier(p.proposalId);validDigest(p.proposalDigest);
    invariant(!ids.has(p.proposalId),"Duplicate bundle proposal");ids.add(p.proposalId);
  }
  invariant(Number.isSafeInteger(createdAt)&&createdAt>=0,"Invalid createdAt");
  const fixedPolicy=detached(policy);validateWeightedPolicy(fixedPolicy);
  const fixedElectorate=detached(electorate);validateWeightedElectorate(fixedElectorate);
  for(const req of fixedPolicy.classRequirements)
    invariant(fixedElectorate.members.some(m=>Object.hasOwn(m.classes,req.class)),"Required class has no eligible members");
  const base={
    schemaVersion:2,id,tenantId,documentId,mode,proposals:detached(proposals),
    policy:fixedPolicy,policyDigest:digest("weighted-policy-v1",fixedPolicy),
    electorate:fixedElectorate,electorateDigest:digest("weighted-electorate-v1",fixedElectorate),
    createdAt,
  };
  return freezeDeep({...base,snapshotDigest:digest("weighted-governance-snapshot-v1",base)});
}
export function validateWeightedSnapshot(value){
  only(value,["schemaVersion","id","tenantId","documentId","mode","proposals","policy","policyDigest",
    "electorate","electorateDigest","createdAt","snapshotDigest"],
  ["schemaVersion","id","tenantId","documentId","mode","proposals","policy","policyDigest",
    "electorate","electorateDigest","createdAt","snapshotDigest"],"Unexpected snapshot fields");
  invariant(value.schemaVersion===2,"Unsupported snapshot version");
  const recreated=createWeightedSnapshot(value);
  invariant(recreated.policyDigest===value.policyDigest&&recreated.electorateDigest===value.electorateDigest&&
    recreated.snapshotDigest===value.snapshotDigest,"Weighted snapshot has been modified");
  return recreated;
}

const weightOf=(weighting,classes,name)=>{
  if(name!==undefined)return Object.hasOwn(classes,name)?(weighting==="equal"?1n:classes[name]):0n;
  if(weighting==="equal")return 1n;
  let total=0n;
  for(const amount of Object.values(classes))total+=amount;
  return total;
};
const compare=(comparison,left,right)=>comparison==="gt"?left>right:left>=right;
function approvalResult(rule,totals,eligible,minYes){
  const value=rule.basis==="eligible"?eligible:rule.basis==="participating"?totals.yes+totals.no+totals.abstain:totals.yes+totals.no;
  const name=rule.basis==="eligible"?"eligible-weight":rule.basis==="participating"?"yes+no+abstain-weight":"yes+no-weight";
  const met=value>0n&&(minYes===undefined||totals.yes>=minYes)&&
    compare(rule.comparison,totals.yes*BigInt(rule.denominator),value*BigInt(rule.numerator));
  return {basis:rule.basis,comparison:rule.comparison,numerator:rule.numerator,denominator:rule.denominator,
    measured:"yes-weight",measuredValue:totals.yes.toString(),denominatorName:name,denominatorValue:value.toString(),
    ...(minYes===undefined?{}:{minYes:minYes.toString()}),met};
}

/**
 * Pure evaluator. Ballots never carry weight: direct ballots are
 * {principalId,choice}; proxy ballots add {proxyId,allocation} where
 * allocation is "all" or a class->units map frozen from the grant. A
 * principal's direct ballot supersedes every proxy ballot cast for it.
 */
export function evaluateWeightedDecision({mode,policy,electorate,ballots,now,castingVote=null}){
  invariant(["collaboration","public-input"].includes(mode),"Invalid document mode");
  validateWeightedPolicy(policy);validateWeightedElectorate(electorate);
  invariant(Number.isSafeInteger(now)&&now>=0,"Invalid timestamp");
  invariant(Array.isArray(ballots),"Invalid ballot collection");
  const weighting=policy.weighting;
  const members=new Map(electorate.members.map(m=>[m.principalId,
    Object.fromEntries(Object.entries(m.classes).map(([k,v])=>[k,BigInt(v)]))]));
  const direct=new Map(),proxies=new Map();
  for(const b of ballots){
    plain(b,"Invalid ballot");
    invariant(!Object.hasOwn(b,"weight")&&!Object.hasOwn(b,"units"),"Ballot cannot supply its own weight");
    identifier(b.principalId);
    invariant(members.has(b.principalId),"Ineligible principal");
    invariant(CHOICES.includes(b.choice),"Invalid choice");
    if(b.proxyId===undefined){
      only(b,["principalId","choice"],["principalId","choice"],"Invalid direct ballot");
      invariant(!direct.has(b.principalId),"Duplicate direct ballot");
      direct.set(b.principalId,b.choice);
    }else{
      only(b,["principalId","choice","proxyId","grantId","allocation"],["principalId","choice","proxyId","grantId","allocation"],"Invalid proxy ballot");
      identifier(b.proxyId);identifier(b.grantId);
      invariant(b.proxyId!==b.principalId,"A principal cannot be its own proxy");
      const list=proxies.get(b.principalId)??[];
      invariant(!list.some(x=>x.grantId===b.grantId),"Duplicate proxy ballot");
      list.push(b);proxies.set(b.principalId,list);
    }
  }
  const eligible={weight:0n,heads:0n},participating={weight:0n,heads:0n};
  const totals={yes:0n,no:0n,abstain:0n};
  const classStats=new Map();
  const classStat=name=>{
    if(!classStats.has(name))classStats.set(name,{eligible:0n,heads:0n,participating:0n,yes:0n,no:0n,abstain:0n});
    return classStats.get(name);
  };
  let proxyCounted=0,proxySuperseded=0;
  for(const [principalId,classes] of members){
    eligible.weight+=weightOf(weighting,classes);eligible.heads+=1n;
    for(const name of Object.keys(classes)){const s=classStat(name);s.eligible+=weightOf(weighting,classes,name);s.heads+=1n;}
    const contributions=[];
    if(direct.has(principalId)){
      contributions.push({choice:direct.get(principalId),classes});
      proxySuperseded+=(proxies.get(principalId)??[]).length;
    }else{
      const list=proxies.get(principalId)??[];
      const used=Object.fromEntries(Object.keys(classes).map(k=>[k,0n]));
      for(const b of list){
        let allocated;
        if(b.allocation==="all"){
          invariant(list.length===1,"Proxy allocation exceeds principal units");
          allocated=classes;
        }else{
          invariant(weighting==="units","Equal-person decisions accept only whole-holding proxies");
          plain(b.allocation,"Invalid proxy allocation");
          allocated={};
          for(const [name,amount] of Object.entries(b.allocation)){
            votingClass(name);
            const value=units(amount,{positive:true});
            invariant(Object.hasOwn(classes,name),"Proxy allocation exceeds principal units");
            used[name]+=value;
            invariant(used[name]<=classes[name],"Proxy allocation exceeds principal units");
            allocated[name]=value;
          }
          invariant(Object.keys(allocated).length>0,"Invalid proxy allocation");
        }
        contributions.push({choice:b.choice,classes:allocated});
        proxyCounted++;
      }
    }
    if(!contributions.length)continue;
    participating.heads+=1n;
    // Equal weighting admits one contribution per principal (direct or a
    // single whole-holding proxy), so heads are never counted twice.
    for(const c of contributions){
      const w=weightOf(weighting,c.classes);
      totals[c.choice]+=w;participating.weight+=w;
      for(const name of Object.keys(c.classes)){
        const s=classStat(name),cw=weightOf(weighting,c.classes,name);
        s[c.choice]+=cw;s.participating+=cw;
      }
    }
  }
  const q=policy.quorum;
  const byCount=q.kind==="count"||q.kind==="fraction-count";
  const measuredQuorum=byCount?participating.heads:participating.weight;
  const quorumBase=byCount?eligible.heads:eligible.weight;
  const quorumMet=q.kind.startsWith("fraction-")?
    measuredQuorum*BigInt(q.denominator)>=quorumBase*BigInt(q.numerator):
    measuredQuorum>=BigInt(q.minimum);
  const quorum={kind:q.kind,measured:byCount?"participating-heads":"participating-weight",
    measuredValue:measuredQuorum.toString(),
    ...(q.kind.startsWith("fraction-")?{numerator:q.numerator,denominator:q.denominator,
      denominatorName:byCount?"eligible-heads":"eligible-weight",denominatorValue:quorumBase.toString()}:{minimum:q.minimum}),
    met:quorumMet};
  let approval=approvalResult(policy.approval,totals,eligible.weight,BigInt(policy.minYes));
  let tie=null;
  if(policy.tieRule&&totals.yes===totals.no&&totals.yes>0n){
    if(policy.tieRule==="fails")tie={rule:"fails",outcome:"no",reason:"tie-fails"};
    else if(castingVote===null)tie={rule:"casting-vote",outcome:"no",reason:"casting-vote-missing"};
    else{
      plain(castingVote,"Invalid casting vote");
      invariant(castingVote.principalId===policy.castingPrincipalId,"Casting vote from the wrong principal");
      invariant(["yes","no"].includes(castingVote.choice),"A casting vote must be yes or no");
      tie={rule:"casting-vote",outcome:castingVote.choice,reason:"casting-vote"};
    }
    approval={...approval,met:tie.outcome==="yes"&&totals.yes>=BigInt(policy.minYes),tieBreak:tie.reason};
  }else invariant(castingVote===null,"A casting vote applies only to a tie");
  const classes=policy.classRequirements.map(req=>{
    const s=classStats.get(req.class)??{eligible:0n,heads:0n,participating:0n,yes:0n,no:0n,abstain:0n};
    const classQuorumMet=s.eligible>0n&&s.participating*BigInt(req.quorum.denominator)>=s.eligible*BigInt(req.quorum.numerator);
    const classApproval=approvalResult(req.approval,s,s.eligible);
    return {class:req.class,eligibleWeight:s.eligible.toString(),eligibleHeads:s.heads.toString(),
      participatingWeight:s.participating.toString(),yes:s.yes.toString(),no:s.no.toString(),abstain:s.abstain.toString(),
      quorum:{measured:"participating-class-weight",measuredValue:s.participating.toString(),
        numerator:req.quorum.numerator,denominator:req.quorum.denominator,
        denominatorName:"eligible-class-weight",denominatorValue:s.eligible.toString(),met:classQuorumMet},
      approval:{...classApproval,denominatorName:"class-"+classApproval.denominatorName},
      met:classQuorumMet&&classApproval.met};
  });
  // Overall approval never substitutes for a required class approval.
  const passed=quorumMet&&approval.met&&classes.every(c=>c.met);
  const advisory=mode==="public-input";
  let supportFloor=null;
  if(policy.supportFloor){
    const f=policy.supportFloor,people=participating.heads;
    const participationMet=people>=BigInt(f.minimumParticipants);
    const supportMet=people>0n&&totals.yes*BigInt(f.supportDenominator)>=participating.weight*BigInt(f.supportNumerator);
    supportFloor={...f,participants:people.toString(),support:totals.yes.toString(),oppose:totals.no.toString(),neutral:totals.abstain.toString(),
      status:!participationMet?"insufficient-participation":supportMet?"support-floor-met":"support-floor-not-met",advisory:true};
  }
  const status=advisory?"advisory":now<policy.opensAt?"not-open":now<policy.closesAt?"open":passed?"passed":"failed";
  return {
    schemaVersion:2,weighting,status,passed:advisory?null:passed,
    overall:{eligibleWeight:eligible.weight.toString(),eligibleHeads:eligible.heads.toString(),
      participatingWeight:participating.weight.toString(),participatingHeads:participating.heads.toString(),
      yes:totals.yes.toString(),no:totals.no.toString(),abstain:totals.abstain.toString(),
      quorum:advisory?null:quorum,approval:advisory?null:approval},
    classes:advisory?[]:classes,
    proxies:{counted:proxyCounted,supersededByDirect:proxySuperseded},
    exclusions:{...electorate.exclusions},
    ...(tie&&!advisory?{tie}:{}),
    ...(supportFloor?{supportFloor}:{}),
  };
}

/** Human-readable policy description; every denominator is named. */
export function describeWeightedPolicy(policy){
  const unitsWord=policy.weighting==="units"?"voting units":"eligible members";
  const q=policy.quorum;
  const quorum=q.kind==="count"?"At least "+q.minimum+" participating members":
    q.kind==="weight"?"At least "+q.minimum+" participating voting units":
    "At least "+q.numerator+"/"+q.denominator+" of frozen "+(q.kind==="fraction-weight"?"voting units":"eligible members");
  const denominator=a=>a.basis==="decisive"?"yes/no "+unitsWord:a.basis==="participating"?"all participating "+unitsWord+", including abstentions":"all frozen eligible "+unitsWord;
  const a=policy.approval;
  const approval=(a.comparison==="gt"?"More than ":"At least ")+a.numerator+"/"+a.denominator+" of "+denominator(a);
  const classes=policy.classRequirements.map(r=>"Class "+r.class+": quorum "+r.quorum.numerator+"/"+r.quorum.denominator+
    " of class "+unitsWord+"; "+(r.approval.comparison==="gt"?"more than ":"at least ")+r.approval.numerator+"/"+r.approval.denominator+
    " of class "+denominator(r.approval));
  const tieRule=policy.tieRule==="fails"?"An exact yes/no tie fails":policy.tieRule==="casting-vote"?"An exact yes/no tie is decided by one recorded casting vote of the named presiding member; without it the tie fails":null;
  const f=policy.supportFloor;
  const supportFloor=f?"Advisory support floor: at least "+f.minimumParticipants+" participants and "+f.supportNumerator+"/"+f.supportDenominator+" in support":null;
  return {quorum,approval,minYes:policy.minYes,classes,weighting:policy.weighting,tieRule,supportFloor,
    minimumDeliberationHours:policy.minimumDeliberationHours??0,challengeWindowHours:policy.challengeWindowMs/3600000};
}

export const WEIGHTED_CERTIFICATE_DOMAIN="governance-decision-certificate-v2";
export const certificateDigest=certificate=>digest(WEIGHTED_CERTIFICATE_DOMAIN,certificate);

/** Offline checksum verification of a schemaVersion 2 public receipt. */
export function verifyWeightedDecisionReceipt(input,{documentId=null,proposalId=null}={}){
  try{
    plain(input,"Receipt must be a record");canonicalize(input);
    invariant(Object.keys(input).sort().join(",")==="certificate,certificateDigest,documentId,externalAnchorVerified,legallyExecuted,proposalId,schemaVersion,verification","Unexpected receipt fields");
    invariant(input.schemaVersion===2&&input.verification==="content-digest-only"&&input.externalAnchorVerified===false&&input.legallyExecuted===false,"Unsupported receipt");
    const c=input.certificate;
    invariant(c&&c.schemaVersion===2&&c.kind==="governance-decision-record-not-execution"&&c.executed===false&&c.canAdopt===false,"Unsupported certificate");
    invariant(input.documentId===c.documentId&&input.proposalId===c.proposalId,"Receipt and certificate disagree");
    invariant(documentId===null||documentId===input.documentId,"Unexpected document");
    invariant(proposalId===null||proposalId===input.proposalId,"Unexpected proposal");
    invariant(validDigest(input.certificateDigest)===certificateDigest(c),"Certificate digest mismatch");
    invariant(["provisional","final","void"].includes(c.finality),"Invalid finality");
    return Object.freeze({checksumValid:true,documentId:input.documentId,proposalId:input.proposalId,
      certificateDigest:input.certificateDigest,finality:c.finality,
      appliedToDraft:c.application==="applied-to-public-draft",externalAnchorVerified:false,legallyExecuted:false,
      limitation:"Checksum only. Verify origin and any transparency-log inclusion separately."});
  }catch{
    return Object.freeze({checksumValid:false,externalAnchorVerified:false,legallyExecuted:false,
      limitation:"Receipt cannot be independently verified from the supplied data."});
  }
}
