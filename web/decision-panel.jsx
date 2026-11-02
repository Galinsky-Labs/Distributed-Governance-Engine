import React,{useEffect,useRef,useState} from "react";
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
  if(error?.code==="AUTHENTICATION_REQUIRED")return "Sign in to view your workspace decision.";
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
  const [disclosed,setDisclosed]=useState(false);
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
  async function run(kind,body){
    if(busy)return;
    setBusy(true);setError("");setNotice("");
    try{
      if(!pending.current)pending.current={kind,body:body()};
      const active=pending.current;
      if(active.kind!==kind)return;
      const result=await api(path+(kind==="ballot"?"/ballots":kind==="close"?"/close":""),{
        method:"POST",body:active.body
      });
      pending.current=null;
      if(kind==="close")setNotice("Decision closure recorded. The document has not been executed or adopted.");
      else if(kind==="ballot")setNotice("Your ballot was saved; the record is bound to this proposal.");
      else setNotice("Voting window opened for the current frozen electorate.");
      if(result.receiptDigest)setNotice("Ballot committed. Receipt digest: "+result.receiptDigest);
      setRevision(r=>r+1);
    }catch(reason){
      if(reason.status>=400&&reason.status<500)pending.current=null;
      setError(statusText(reason)+(pending.current?" Retry sends the same command ID.":""));
    }finally{setBusy(false);}
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
          <select value={hours} onChange={e=>setHours(e.target.value)} disabled={busy}>
            <option value="1">1 hour</option><option value="24">24 hours</option>
            <option value="168">7 days</option><option value="720">30 days</option>
          </select>
        </label>
        <label className="decision-ack"><input type="checkbox" checked={disclosed} onChange={e=>setDisclosed(e.target.checked)}/>
          Freeze the current eligible members. Each will have one vote; no new member can enter this electorate. This decision will not automatically execute the document.
        </label>
        <button disabled={busy||!disclosed} onClick={()=>run("open",()=>({hours:Number(hours),commandId:crypto.randomUUID()}))}>
          Open recorded vote
        </button>
      </div>}
      {!canManage&&<p>Only workspace owners or administrators can open a vote.</p>}
    </div>}
    {decision&&<div className="decision-details">
      <p className="decision-window">Electorate: <strong>{decision.eligibleCount} eligible members</strong> · Closes: <strong>{new Date(decision.closesAt).toLocaleString()}</strong></p>
      <p className="decision-rule">Rule: {decision.rule.quorum}; {decision.rule.approval}. Votes are frozen to this proposal and may be replaced until the deadline.</p>
      <div className="decision-tally" aria-label="Decision totals">
        <div><strong>{decision.outcome.yes}</strong><span>Yes</span></div>
        <div><strong>{decision.outcome.no}</strong><span>No</span></div>
        <div><strong>{decision.outcome.abstain}</strong><span>Abstain</span></div>
      </div>
      <p className="decision-state">Status: <strong>{decision.outcome.status}</strong> · Your ballot: {decision.mine.choice??"Not cast"}</p>
      {canVote&&decision.state==="open"&&new Date(decision.closesAt).getTime()>Date.now()&&
        <div className="decision-ballot" aria-label="Cast or replace ballot">
          {["yes","no","abstain"].map(choice=><button key={choice} disabled={busy} aria-pressed={decision.mine.choice===choice}
            onClick={()=>run("ballot",()=>({
              choice,expectedVersion:decision.mine.version,commandId:crypto.randomUUID()
            }))}>{choice==="yes"?"Vote yes":choice==="no"?"Vote no":"Abstain"}</button>)}
        </div>}
      {canManage&&decision.state==="open"&&
        <button disabled={busy} onClick={()=>run("close",()=>({}))}>Close vote after deadline</button>}
      {decision.certificateDigest&&<p className="decision-certificate">Recorded closure digest: <code>{decision.certificateDigest}</code></p>}
      <p className="decision-legal-note">These tallies and receipts document an internal governance choice. They are not signed, externally anchored or legally executed; no document language is automatically adopted.</p>
    </div>}
  </section>;
}
