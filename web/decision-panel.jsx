import React,{useEffect,useRef,useState} from "react";
import {normalizeVotePolicySettings,describeVotePolicy} from "../src/vote-policy-settings.mjs";
import {normalizeWeightedPolicySettings} from "../src/weighted-governance.mjs";
import {createAccountAPI} from "./account-api.mjs";

const api=createAccountAPI();
const roles=["owner","admin","editor","participant"];
const manager=["owner","admin"];
const statusText=(error)=>{
  if(error?.code==="DECISION_NOT_FOUND")return "No decision has been opened for this proposal.";
  if(error?.code==="DECISION_ALREADY_EXISTS")return "A decision already exists. Refresh to load it.";
  if(error?.code==="VOTE_WINDOW_CLOSED"||error?.code==="VOTE_CLOSED")return "The voting window is closed.";
  if(error?.code==="BALLOT_VERSION_CONFLICT")return "Your ballot was changed in another session. Refresh before voting again.";
  if(error?.code==="NOT_IN_FROZEN_ELECTORATE")return "You were not in the frozen electorate when voting opened.";
  if(error?.code==="VOTE_STILL_OPEN")return "The voting deadline has not passed.";
  if(error?.code==="INVALID_VOTE_POLICY"||error?.code==="UNATTAINABLE_VOTE_POLICY")return "Choose attainable voting rules for the current eligible accounts.";
  if(error?.code==="REAUTHENTICATION_REQUIRED")return "Sign in again before freezing a new voting policy.";
  if(error?.code==="AUTHENTICATION_REQUIRED")return "Sign in to view your workspace decision.";
  if(error?.code==="CHALLENGE_WINDOW_OPEN")return "The challenge window has not ended yet.";
  if(error?.code==="CHALLENGE_PENDING")return "A challenge is pending; resolve it before finalizing.";
  if(error?.code==="CHALLENGE_WINDOW_CLOSED")return "The challenge window is closed.";
  if(error?.code==="CHALLENGER_CANNOT_RESOLVE")return "Another manager must resolve your own challenge.";
  if(error?.code==="DECISION_VOID")return "This decision was voided. A new decision with a new electorate snapshot is required.";
  if(error?.code==="PROXY_OVER_ALLOCATION")return "This principal's proxy grants exceed its frozen voting units.";
  if(error?.code==="PROXY_REVOKED"||error?.code==="PROXY_EXPIRED")return "This proxy grant is no longer active.";
  if(error?.code==="RECORD_DATE_NOT_PAST")return "Choose a record date in the past.";
  if(error?.code==="EMPTY_ELECTORATE")return "No eligible voter remains in the frozen electorate for this clause.";
  if(error?.code==="ROSTER_NOT_FOUND")return "Choose an existing roster.";
  if(error?.code==="ACCESS_DENIED")return "Your current workspace permissions do not allow this action.";
  return "The decision service could not complete the request. No success is being assumed.";
};

/** Honest application of the durable decision service. No law or charter
 * amendment is automatically adopted, signed, or executed by this panel.
 */
export function DecisionPanel({tenantId,documentId,proposalId,role}){
  const path="/api/workspaces/"+tenantId+"/documents/"+documentId+"/proposals/"+proposalId+"/decision";
  const [decision,setDecision]=useState(null);
  const [notStarted,setNotStarted]=useState(false);
  const [error,setError]=useState("");
  const [notice,setNotice]=useState("");
  const [loading,setLoading]=useState(false);
  const [busy,setBusy]=useState(false);
  const [hours,setHours]=useState("24");
  const [settings,setSettings]=useState({minYes:"1",minimumDeliberationHours:0,quorum:{kind:"fraction-count",numerator:"1",denominator:"2"},approval:{basis:"decisive",comparison:"gt",numerator:"1",denominator:"2"}});
  let policy,policyError="";
  try{policy=normalizeVotePolicySettings(settings);}catch{policyError="Complete the voting rules with positive whole numbers and attainable fractions.";}
  const preview=policy?describeVotePolicy(policy):null;
  function changeSettings(next){setSettings(next);setDisclosed(false);}
  const [disclosed,setDisclosed]=useState(false);
  // Version 2 options: roster electorate, weighting, class rule, bundle and challenge window.
  const [advanced,setAdvanced]=useState({enabled:false,source:"membership",rosterId:"",recordDate:"",weighting:"equal",
    challengeWindowHours:"0",classRule:null,bundle:""});
  const [rosters,setRosters]=useState([]);
  const [challenges,setChallenges]=useState(null);
  const [challengeForm,setChallengeForm]=useState({reasonCategory:"procedure",statement:""});
  function changeAdvanced(next){setAdvanced(next);setDisclosed(false);}
  let advancedBody=null,advancedError="";
  if(advanced.enabled){
    try{
      const recordMs=Date.parse(advanced.recordDate);
      if(advanced.source==="roster"&&!(advanced.rosterId&&Number.isFinite(recordMs)))throw Error("roster");
      const extra=advanced.bundle.split(/[\s,]+/).filter(Boolean);
      const classRequirements=advanced.classRule?[advanced.classRule]:[];
      const weightedSettings=normalizeWeightedPolicySettings({...(policy??settings),classRequirements},{weighting:advanced.weighting});
      advancedBody={
        electorate:advanced.source==="roster"?{source:"roster",rosterId:advanced.rosterId,recordDate:new Date(recordMs).toISOString()}:{source:"membership"},
        weighting:advanced.weighting,challengeWindowHours:Number(advanced.challengeWindowHours),
        ...(extra.length?{bundle:[proposalId,...extra]}:{}),policySettings:weightedSettings,
      };
    }catch{advancedError="Complete the roster, record date, class rule and bundle fields, or turn the advanced options off.";}
  }
  const [revision,setRevision]=useState(0);
  const pending=useRef(null);
  const canVote=roles.includes(role);
  const canManage=manager.includes(role);
  useEffect(()=>{
    const abort=new AbortController();
    setLoading(true);setNotStarted(false);setDecision(null);setError("");setNotice("");
    pending.current=null;
    api(path,{signal:abort.signal}).then(result=>{
      if(!abort.signal.aborted)setDecision(result);
    }).catch(reason=>{
      if(abort.signal.aborted)return;
      if(reason.status===404)setNotStarted(true);
      else setError(statusText(reason));
    }).finally(()=>{if(!abort.signal.aborted)setLoading(false);});
    return ()=>abort.abort();
  },[path,revision]);
  useEffect(()=>{
    if(!canManage||!notStarted||!tenantId)return;
    const abort=new AbortController();
    api("/api/workspaces/"+tenantId+"/rosters",{signal:abort.signal}).then(r=>{if(!abort.signal.aborted)setRosters(r.items);}).catch(()=>{});
    return ()=>abort.abort();
  },[tenantId,canManage,notStarted]);
  useEffect(()=>{
    if(decision?.schemaVersion!==2||!decision.finality){setChallenges(null);return;}
    const abort=new AbortController();
    api(path+"/challenges",{signal:abort.signal}).then(r=>{if(!abort.signal.aborted)setChallenges(r);}).catch(()=>{});
    return ()=>abort.abort();
  },[path,decision]);
  async function run(kind,body){
    if(busy)return;
    setBusy(true);setError("");setNotice("");
    try{
      if(!pending.current)pending.current={kind,body:body()};
      const active=pending.current;
      if(active.kind!==kind)return;
      const suffix={ballot:"/ballots","proxy-ballot":"/ballots",close:"/close",finalize:"/finalize",challenge:"/challenges"}[kind]??
        (kind.startsWith("resolve:")?"/challenges/"+kind.slice(8)+"/resolve":"");
      const result=await api(path+suffix,{
        method:"POST",body:active.body
      });
      pending.current=null;
      if(kind==="close")setNotice(result.certificate?.finality==="provisional"?
        "Provisional result recorded. Nothing is applied until the challenge window ends and the result is final.":
        "Decision closure recorded. The document has not been executed or adopted.");
      else if(kind==="finalize")setNotice("Final result recorded. Passed collaboration wording is applied exactly once.");
      else if(kind==="challenge"){setNotice("Challenge filed; the result is held until a manager resolves it.");setChallengeForm({reasonCategory:"procedure",statement:""});}
      else if(kind.startsWith("resolve:"))setNotice("Challenge resolved: "+result.status+". Decision is now "+result.finality+".");
      else if(kind==="ballot")setNotice("Your ballot was saved; the record is bound to this proposal.");
      else setNotice("Voting window recorded for the current frozen electorate; check its opening time.");
      if(result.receiptDigest)setNotice("Ballot committed. Receipt digest: "+result.receiptDigest);
      setRevision(r=>r+1);
    }catch(reason){
      if(reason.status>=400&&reason.status<500)pending.current=null;
      setError(statusText(reason)+(pending.current?" Retry sends the same command ID.":""));
    }finally{setBusy(false);}
  }
  async function downloadReceipt(){
    setError("");
    try{
      const receipt=await api("/api/public/documents/"+documentId+"/proposals/"+proposalId+"/decision/receipt");
      const blob=new Blob([JSON.stringify(receipt,null,2)],{type:"application/json"});
      const url=URL.createObjectURL(blob),link=document.createElement("a");
      link.href=url;link.download="Quill-decision-"+proposalId+".json";
      link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
      setNotice("Decision receipt downloaded. Its checksum can be verified independently, but it is not a signature or blockchain proof.");
    }catch(error){setError(statusText(error));}
  }
  if(!tenantId||!proposalId)return null;
  return <section className="decision-panel" aria-label="Proposal decision">
    <div className="decision-heading"><div><p className="eyebrow">GOVERNANCE / VOTING</p><h3>Decision record</h3></div><button onClick={()=>{pending.current=null;setRevision(r=>r+1)}} disabled={loading||busy}>Refresh</button></div>
    {loading&&<p role="status">Loading authenticated decision record…</p>}
    {!!error&&<p role="alert" className="decision-error">{error}</p>}
    {!!notice&&<p role="status" className="decision-success">{notice}</p>}
    {notStarted&&!loading&&<div className="decision-empty">
      <p>No recorded vote has opened on this amendment.</p>
      {canManage&&<div className="decision-open">
        <label>Voting window
          <select value={hours} onChange={e=>{setHours(e.target.value);setDisclosed(false);}} disabled={busy||!!pending.current}>
            <option value="1">1 hour</option><option value="24">24 hours</option>
            <option value="168">7 days</option><option value="720">30 days</option>
          </select>
        </label>
        <fieldset disabled={busy||!!pending.current} className="decision-policy"><legend>Rules frozen for this vote</legend>
          <label>Quorum type<select aria-label="Quorum type" value={settings.quorum.kind} onChange={e=>changeSettings({...settings,quorum:e.target.value==="count"?{kind:"count",minimum:"1"}:{kind:"fraction-count",numerator:"1",denominator:"2"}})}><option value="fraction-count">Fraction of eligible accounts</option><option value="count">Number of eligible accounts</option></select></label>
          {settings.quorum.kind==="count"?<label>Minimum participating accounts<input aria-label="Minimum participating accounts" type="number" min="1" max="100000" value={settings.quorum.minimum} onChange={e=>changeSettings({...settings,quorum:{...settings.quorum,minimum:e.target.value}})}/></label>:<>
            <label>Quorum numerator<input aria-label="Quorum numerator" type="number" min="1" max="1000000" value={settings.quorum.numerator} onChange={e=>changeSettings({...settings,quorum:{...settings.quorum,numerator:e.target.value}})}/></label>
            <label>Quorum denominator<input aria-label="Quorum denominator" type="number" min="1" max="1000000" value={settings.quorum.denominator} onChange={e=>changeSettings({...settings,quorum:{...settings.quorum,denominator:e.target.value}})}/></label></>}
          <label>Approval denominator<select aria-label="Approval denominator" value={settings.approval.basis} onChange={e=>changeSettings({...settings,approval:{...settings.approval,basis:e.target.value}})}><option value="decisive">Yes and no votes</option><option value="participating">All participants, including abstentions</option><option value="eligible">All frozen eligible accounts</option></select></label>
          <label>Approval comparison<select aria-label="Approval comparison" value={settings.approval.comparison} onChange={e=>changeSettings({...settings,approval:{...settings.approval,comparison:e.target.value}})}><option value="gt">More than (ties fail)</option><option value="gte">At least (exact threshold passes)</option></select></label>
          <label>Approval numerator<input aria-label="Approval numerator" type="number" min="1" max="1000000" value={settings.approval.numerator} onChange={e=>changeSettings({...settings,approval:{...settings.approval,numerator:e.target.value}})}/></label>
          <label>Approval denominator number<input aria-label="Approval denominator number" type="number" min="1" max="1000000" value={settings.approval.denominator} onChange={e=>changeSettings({...settings,approval:{...settings.approval,denominator:e.target.value}})}/></label>
          <label>Minimum yes votes<input aria-label="Minimum yes votes" type="number" min="1" max="100000" value={settings.minYes} onChange={e=>changeSettings({...settings,minYes:e.target.value})}/></label>
          <label>Minimum deliberation hours since proposal publication<input aria-label="Minimum deliberation hours" type="number" min="0" max="720" value={settings.minimumDeliberationHours} onChange={e=>changeSettings({...settings,minimumDeliberationHours:e.target.value===""?"":Number(e.target.value)})}/></label>
        </fieldset>
        {policyError?<p role="alert">{policyError}</p>:<p className="decision-policy-preview">{preview.quorum}; {preview.approval}; at least {preview.minYes} yes vote(s). Voting begins after {preview.minimumDeliberationHours} hours of proposal deliberation. Public-input mode remains advisory.</p>}
        <label className="decision-ack"><input type="checkbox" checked={disclosed} onChange={e=>setDisclosed(e.target.checked)}/>
          {advanced.enabled?
            "Freeze these rules and the selected electorate snapshot. Ballot weight comes only from the snapshot; later roster or membership changes require a new decision. This decision will not automatically execute the document.":
            "Freeze these rules and the current eligible member accounts. Each will have one vote; no new member can enter this electorate. This decision will not automatically execute the document."}
        </label>
        <button disabled={busy||!disclosed||!policy||(advanced.enabled&&!advancedBody)} onClick={()=>run("open",()=>advanced.enabled?
          {hours:Number(hours),commandId:crypto.randomUUID(),...advancedBody}:
          {hours:Number(hours),commandId:crypto.randomUUID(),policySettings:policy})}>
          Open recorded vote
        </button>
        <details className="decision-advanced">
          <summary>Roster electorate, weighting, class approval, bundle and challenge window</summary>
          <fieldset disabled={busy||!!pending.current} className="decision-policy-advanced">
            <label className="decision-ack"><input type="checkbox" checked={advanced.enabled} onChange={e=>changeAdvanced({...advanced,enabled:e.target.checked})}/>Use these options for this decision</label>
            <label>Electorate<select value={advanced.source} onChange={e=>changeAdvanced({...advanced,source:e.target.value,weighting:e.target.value==="roster"?advanced.weighting:"equal",classRule:e.target.value==="roster"?advanced.classRule:null})}>
              <option value="membership">Current voting members (one each)</option><option value="roster">Roster snapshot at a record date</option></select></label>
            {advanced.source==="roster"&&<>
              <label>Roster<select value={advanced.rosterId} onChange={e=>changeAdvanced({...advanced,rosterId:e.target.value})}>
                <option value="">Choose a roster</option>{rosters.map(r=><option key={r.id} value={r.id}>{r.name} ({r.kind})</option>)}</select></label>
              <label>Record date (must be in the past)<input type="datetime-local" value={advanced.recordDate} onChange={e=>changeAdvanced({...advanced,recordDate:e.target.value})}/></label>
              <label>Weighting<select value={advanced.weighting} onChange={e=>changeAdvanced({...advanced,weighting:e.target.value})}>
                <option value="equal">One vote per eligible person</option><option value="units">Recorded voting units</option></select></label>
              <label>Required class approval (optional)<input placeholder="class, for example preferred-a" value={advanced.classRule?.class??""} onChange={e=>changeAdvanced({...advanced,
                classRule:e.target.value?{class:e.target.value.trim(),quorum:{numerator:"1",denominator:"2"},approval:{basis:"decisive",comparison:"gt",numerator:"1",denominator:"2"}}:null})}/></label>
              {advanced.classRule&&<p className="small">Class {advanced.classRule.class} must separately reach a quorum of half its units and a strict majority of its yes/no units. The overall majority cannot override it.</p>}
            </>}
            <label>Challenge window<select value={advanced.challengeWindowHours} onChange={e=>changeAdvanced({...advanced,challengeWindowHours:e.target.value})}>
              <option value="0">None: closing is final</option><option value="24">24 hours</option><option value="72">72 hours</option><option value="168">7 days</option></select></label>
            <label>Bundle further proposals on the same base (IDs, comma separated; all apply or none)<input value={advanced.bundle} onChange={e=>changeAdvanced({...advanced,bundle:e.target.value})}/></label>
          </fieldset>
          {!!advancedError&&<p role="alert">{advancedError}</p>}
        </details>
      </div>}
      {!canManage&&<p>Only workspace owners or administrators can open a vote.</p>}
    </div>}
    {decision&&<div className="decision-details">
      <p className="decision-window">Electorate: <strong>{decision.eligibleCount} eligible members</strong> · Opens: <strong>{new Date(decision.opensAt).toLocaleString()}</strong> · Closes: <strong>{new Date(decision.closesAt).toLocaleString()}</strong></p>
      <p className="decision-rule">Rule: {decision.rule.quorum}; {decision.rule.approval}; at least {decision.rule.minYes} yes vote(s). Policy <code>{decision.policyId}</code> is frozen. Votes are frozen to this proposal and may be replaced until the deadline.</p>
      <div className="decision-tally" aria-label="Decision totals">
        <div><strong>{decision.outcome.yes}</strong><span>Yes</span></div>
        <div><strong>{decision.outcome.no}</strong><span>No</span></div>
        <div><strong>{decision.outcome.abstain}</strong><span>Abstain</span></div>
      </div>
      <p className="decision-state">Status: <strong>{decision.outcome.status}</strong> · Your ballot: {decision.mine.choice??"Not cast"}</p>
      {decision.schemaVersion===2&&<div className="decision-weighted">
        <p className="decision-rule">Weighting: {decision.weighting==="units"?"recorded voting units":"one vote per eligible person"} · Eligible weight: <code style={{overflowWrap:"anywhere"}}>{decision.eligibleWeight}</code>
          {decision.electorate.recordDate&&<> · Record date {new Date(decision.electorate.recordDate).toLocaleString()}</>}
          {Object.keys(decision.electorate.exclusions).length>0&&<> · Excluded: {Object.entries(decision.electorate.exclusions).map(([reason,n])=>reason+" ×"+n).join(", ")}</>}</p>
        {decision.rule.classes.map(text=><p className="decision-rule" key={text}>{text}</p>)}
        {decision.bundle.length>1&&<p className="decision-rule">Atomic bundle of {decision.bundle.length} proposals: all apply or none.</p>}
        {decision.finality&&<p className="decision-state">Finality: <strong>{decision.finality}</strong>{decision.challengeClosesAt&&<> · Challenge window ends {new Date(decision.challengeClosesAt).toLocaleString()}</>}{decision.application&&<> · Application: {decision.application}</>}</p>}
        {decision.outcome.classes.map(c=><p className="decision-rule" key={c.class}>Class {c.class}: yes {c.yes}, no {c.no}, abstain {c.abstain} of {c.eligibleWeight} eligible; quorum {c.quorum.met?"met":"not met"} ({c.quorum.denominatorName}); approval {c.approval.met?"met":"not met"} ({c.approval.denominatorName}).</p>)}
        {decision.state==="open"&&decision.proxies.map(proxy=><div className="decision-ballot" key={proxy.grantId} aria-label="Cast a proxy ballot">
          <span className="small">Proxy {proxy.allocation?Object.entries(proxy.allocation).map(([k,v])=>v+" "+k).join(", "):"whole holding"} · {proxy.choice??"not cast"}</span>
          {["yes","no","abstain"].map(choice=><button key={choice} disabled={busy} aria-pressed={proxy.choice===choice}
            onClick={()=>run("proxy-ballot",()=>({choice,expectedVersion:proxy.version,commandId:crypto.randomUUID(),onBehalfOf:proxy.grantId}))}>Proxy {choice}</button>)}
        </div>)}
        {challenges&&challenges.items.length>0&&<ul className="decision-challenges">{challenges.items.map(c=><li key={c.id}>
          {c.reasonCategory} · {c.status}{c.statement&&<blockquote>{c.statement}</blockquote>}
          {canManage&&c.status==="pending"&&!c.mine&&<span>
            <button disabled={busy} onClick={()=>run("resolve:"+c.id,()=>({resolution:"dismiss",commandId:crypto.randomUUID()}))}>Dismiss</button>
            <button disabled={busy} onClick={()=>run("resolve:"+c.id,()=>({resolution:"uphold",commandId:crypto.randomUUID()}))}>Uphold and void</button></span>}
        </li>)}</ul>}
        {decision.mine.eligible&&["provisional","held"].includes(decision.finality)&&new Date(decision.challengeClosesAt).getTime()>Date.now()&&<div className="decision-challenge-form">
          <label>Challenge reason<select value={challengeForm.reasonCategory} onChange={e=>setChallengeForm({...challengeForm,reasonCategory:e.target.value})}>
            <option value="eligibility">Eligibility</option><option value="ballot-irregularity">Ballot irregularity</option><option value="procedure">Procedure</option>
            <option value="conflict-of-interest">Conflict of interest</option><option value="other">Other</option></select></label>
          <label>Statement<textarea maxLength={2000} value={challengeForm.statement} onChange={e=>setChallengeForm({...challengeForm,statement:e.target.value})}/></label>
          <button disabled={busy||!challengeForm.statement.trim()} onClick={()=>run("challenge",()=>({...challengeForm,commandId:crypto.randomUUID()}))}>File challenge</button>
        </div>}
        {canManage&&decision.finality==="provisional"&&<button disabled={busy} onClick={()=>run("finalize",()=>({}))}>Finalize after challenge window</button>}
      </div>}
      {canVote&&decision.state==="open"&&new Date(decision.opensAt).getTime()<=Date.now()&&new Date(decision.closesAt).getTime()>Date.now()&&
        <div className="decision-ballot" aria-label="Cast or replace ballot">
          {["yes","no","abstain"].map(choice=><button key={choice} disabled={busy} aria-pressed={decision.mine.choice===choice}
            onClick={()=>run("ballot",()=>({
              choice,expectedVersion:decision.mine.version,commandId:crypto.randomUUID()
            }))}>{choice==="yes"?"Vote yes":choice==="no"?"Vote no":"Abstain"}</button>)}
        </div>}
      {canManage&&decision.state==="open"&&
        <button disabled={busy} onClick={()=>run("close",()=>({}))}>Close vote after deadline</button>}
      {decision.certificateDigest&&<div className="decision-certificate"><p>Recorded closure digest: <code>{decision.certificateDigest}</code></p><button onClick={downloadReceipt} disabled={busy}>Download publicly verifiable checksum receipt</button></div>}
      <p className="decision-legal-note">These tallies and receipts document an internal governance choice. They are not signed, externally anchored or legally executed; a passed collaboration vote can update the public working draft, while public-input votes remain advisory. Legal adoption requires a separate authorized process.</p>
    </div>}
  </section>;
}
