import React,{useEffect,useRef,useState} from "react";
import {createAccountAPI} from "./account-api.mjs";

const api=createAccountAPI();
const managers=["owner","admin"];
export const REPORT_REASONS=[["spam","Spam"],["harassment","Harassment"],["off-topic","Off-topic"],
  ["private-information","Private information"],["illegal-content","Illegal content"],["impersonation","Impersonation"],["other","Other"]];
const label=code=>(REPORT_REASONS.find(([value])=>value===code)?.[1])??(code==="review-reversed"?"Reversed on review":code==="appeal-granted"?"Restored on appeal":code);
const message=error=>({
  REPORT_RATE_LIMITED:"You have reached your report limit for now. Try again later.",
  ALREADY_REPORTED:"You already reported this item.",
  ONLY_AUTHOR_MAY_APPEAL:"Only the author can appeal this removal.",
  APPEAL_EXISTS:"An appeal for this removal already exists.",
  APPEAL_REVIEWER_CONFLICT:"Another manager must decide an appeal against your own action.",
  MODERATION_VERSION_CONFLICT:"This item changed in another session. Refresh first.",
  ACCESS_DENIED:"Your workspace role does not allow this action.",
  AUTHENTICATION_REQUIRED:"Sign in to continue.",
}[error?.code]??"The moderation service could not complete the request. No success is being assumed.");

/** Public placeholder for content a moderator removed; nothing is deleted. */
export function RemovedNotice({moderation}){
  if(!moderation)return null;
  return <p className="small moderation-removed" role="note">Removed by moderator · {label(moderation.reasonCategory)}. The item stays in the record and its votes are unchanged.</p>;
}

/** Report a proposal or discussion point to the workspace moderators. */
export function ReportButton({tenantId,targetKind,targetId}){
  const [open,setOpen]=useState(false),[reason,setReason]=useState("spam"),[note,setNote]=useState("");
  const [busy,setBusy]=useState(false),[status,setStatus]=useState("");
  const pending=useRef(null);
  if(!tenantId)return null;
  async function submit(){
    setBusy(true);setStatus("");
    pending.current??={targetKind,targetId,reasonCategory:reason,...(note.trim()?{note}:{}),commandId:crypto.randomUUID()};
    try{
      await api("/api/workspaces/"+tenantId+"/reports",{method:"POST",body:pending.current});
      pending.current=null;setOpen(false);setNote("");
      setStatus("Report sent to the moderators. Reports never hide content automatically.");
    }catch(error){
      if(error.status>=400&&error.status<500)pending.current=null;
      setStatus(message(error));
    }finally{setBusy(false);}
  }
  return <div className="point-actions">
    {!open&&<button onClick={()=>setOpen(true)} disabled={busy}>Report</button>}
    {open&&<>
      <label>Reason<select value={reason} onChange={e=>{setReason(e.target.value);pending.current=null;}} disabled={busy}>
        {REPORT_REASONS.map(([value,text])=><option key={value} value={value}>{text}</option>)}</select></label>
      <label>Note for moderators (optional, private)<textarea maxLength={1000} value={note} onChange={e=>{setNote(e.target.value);pending.current=null;}} disabled={busy}/></label>
      <button onClick={submit} disabled={busy}>Send report</button>
      <button onClick={()=>{setOpen(false);pending.current=null;}} disabled={busy}>Cancel</button>
    </>}
    {!!status&&<span className="small" role="status">{status}</span>}
  </div>;
}

/**
 * Moderator queue for owners and admins plus removal notices and appeals
 * for every member. Coordinated-flagging signals are shown, never acted on.
 */
export function ModerationPanel({tenantId,role}){
  const canModerate=managers.includes(role);
  const [queue,setQueue]=useState(null),[mine,setMine]=useState([]),[error,setError]=useState(""),[notice,setNotice]=useState("");
  const [busy,setBusy]=useState(false),[revision,setRevision]=useState(0);
  const [reasons,setReasons]=useState({}),[appealText,setAppealText]=useState({});
  useEffect(()=>{
    if(!tenantId)return;
    const abort=new AbortController();
    setError("");
    const base="/api/workspaces/"+tenantId+"/moderation";
    Promise.all([canModerate?api(base,{signal:abort.signal}):Promise.resolve(null),api(base+"/mine",{signal:abort.signal})])
      .then(([q,m])=>{if(!abort.signal.aborted){setQueue(q);setMine(m.items);}})
      .catch(reason=>{if(!abort.signal.aborted)setError(message(reason));});
    return ()=>abort.abort();
  },[tenantId,canModerate,revision]);
  async function post(path,body,success){
    setBusy(true);setError("");setNotice("");
    try{await api("/api/workspaces/"+tenantId+"/moderation"+path,{method:"POST",body});setNotice(success);setRevision(r=>r+1);}
    catch(reason){setError(message(reason));}
    finally{setBusy(false);}
  }
  if(!tenantId)return null;
  return <section className="decision-panel moderation-panel" aria-label="Moderation">
    <div className="decision-heading"><div><p className="eyebrow">GOVERNANCE / MODERATION</p><h3>Moderation and appeals</h3></div>
      <button onClick={()=>setRevision(r=>r+1)} disabled={busy}>Refresh</button></div>
    {!!error&&<p role="alert" className="decision-error">{error}</p>}
    {!!notice&&<p role="status" className="decision-success">{notice}</p>}
    {canModerate&&queue&&<>
      <h4>Report queue</h4>
      {queue.items.length===0&&<p className="small">No reports.</p>}
      {queue.items.map(item=>{
        const key=item.targetKind+":"+item.targetId,hideReason=reasons[key]??Object.keys(item.categories)[0]??"other";
        return <article className="point-card" key={key}>
          <p className="point-position">{item.targetKind} · {item.openReports} open of {item.totalReports} reports · {item.hidden?"hidden":"visible"}</p>
          <p className="small">Categories: {Object.entries(item.categories).map(([c,n])=>label(c)+" ×"+n).join(", ")}</p>
          {item.coordinatedFlagging.flagged&&<p className="decision-error" role="note">Possible coordinated flagging: {item.coordinatedFlagging.recentAccountReports} of {item.coordinatedFlagging.reportsInWindow} reports in {item.coordinatedFlagging.windowMinutes} minutes came from accounts that joined within {item.coordinatedFlagging.newAccountDays} days. Review the content on its merits; no automatic action was taken.</p>}
          {item.notes.map((n,i)=><blockquote key={i}>{label(n.reasonCategory)}: {n.note}</blockquote>)}
          <div className="point-actions">
            {!item.hidden&&<><select aria-label="Public removal reason" value={hideReason} onChange={e=>setReasons({...reasons,[key]:e.target.value})}>
              {REPORT_REASONS.map(([value,text])=><option key={value} value={value}>{text}</option>)}</select>
              <button disabled={busy} onClick={()=>post("/actions",{targetKind:item.targetKind,targetId:item.targetId,action:"hide",
                reasonCategory:hideReason,expectedVersion:item.version,commandId:crypto.randomUUID()},"Hidden with a public placeholder.")}>Hide</button></>}
            {item.hidden&&<button disabled={busy} onClick={()=>post("/actions",{targetKind:item.targetKind,targetId:item.targetId,action:"restore",
              reasonCategory:"review-reversed",expectedVersion:item.version,commandId:crypto.randomUUID()},"Restored.")}>Restore</button>}
          </div>
        </article>;
      })}
      <h4>Pending appeals</h4>
      {queue.appeals.length===0&&<p className="small">No pending appeals.</p>}
      {queue.appeals.map(a=><article className="point-card" key={a.id}>
        <p className="point-position">{a.targetKind} removed for {label(a.reasonCategory)}</p>
        <blockquote>{a.statement}</blockquote>
        <div className="point-actions">
          <button disabled={busy} onClick={()=>post("/appeals/"+a.id+"/resolve",{decision:"grant",commandId:crypto.randomUUID()},"Appeal granted; content restored.")}>Grant and restore</button>
          <button disabled={busy} onClick={()=>post("/appeals/"+a.id+"/resolve",{decision:"deny",commandId:crypto.randomUUID()},"Appeal denied; content stays hidden.")}>Deny</button>
        </div>
      </article>)}
    </>}
    <h4>Moderation of your contributions</h4>
    {mine.length===0&&<p className="small">None of your proposals or points has been moderated.</p>}
    {mine.map(item=><article className="point-card" key={item.actionId}>
      <p className="point-position">{item.targetKind} {item.action==="hide"?"hidden":"restored"} · {label(item.reasonCategory)} · {new Date(item.createdAt).toLocaleString()}</p>
      {item.appeal&&<p className="small">Appeal: {item.appeal.status}</p>}
      {item.action==="hide"&&!item.appeal&&<div className="point-actions">
        <label>Appeal statement<textarea maxLength={2000} value={appealText[item.actionId]??""} onChange={e=>setAppealText({...appealText,[item.actionId]:e.target.value})}/></label>
        <button disabled={busy||!(appealText[item.actionId]??"").trim()} onClick={()=>post("/appeals",{actionId:item.actionId,statement:appealText[item.actionId],commandId:crypto.randomUUID()},"Appeal filed.")}>Appeal</button>
      </div>}
    </article>)}
    <p className="decision-legal-note">Moderation changes public visibility only. Removed items show a placeholder with a reason category, remain in the audit record, and never change ballots or decision history.</p>
  </section>;
}
