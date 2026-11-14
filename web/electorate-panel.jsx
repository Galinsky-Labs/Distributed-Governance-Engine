import React,{useEffect,useRef,useState} from "react";
import {createAccountAPI} from "./account-api.mjs";

const api=createAccountAPI();
const managers=["owner","admin"];
const KINDS=[["unit-register","Share or unit register"],["verified-person-cohort","Verified-person cohort"],["membership-derived","Workspace membership"]];
const message=error=>({
  PRINCIPAL_NOT_IN_WORKSPACE:"That account is not a member of this workspace.",
  ROSTER_ENTRY_VERSION_CONFLICT:"This entry changed in another session. Refresh and try again.",
  COHORT_UNITS_MUST_BE_ONE:"Verified-person cohorts give each person exactly one unit.",
  INVALID_PERSON_KEY:"Enter the verification identifier (8–512 characters). It is stored only as a keyed digest.",
  PERSON_KEY_UNAVAILABLE:"Person-uniqueness keys are not configured on this server.",
  RECORD_DATE_NOT_PAST:"Choose a record date in the past.",
  PROXY_OVER_ALLOCATION:"These grants would exceed your recorded voting units.",
  PROXY_CYCLE:"That member already holds a proxy from you in reverse; proxies cannot form cycles.",
  PROXY_GRANTEE_NOT_ELIGIBLE:"The proxy must be a voting member of this workspace.",
  GRANTOR_HAS_NO_VOTING_UNITS:"You hold no voting units in this roster.",
  REAUTHENTICATION_REQUIRED:"Sign in again before changing rosters or proxies.",
  ACCESS_DENIED:"Your workspace role does not allow this action.",
}[error?.code]??"The electorate service could not complete the request. No success is being assumed.");
const isoOrNull=value=>value?new Date(value).toISOString():null;

/**
 * Rosters, record-date snapshots and proxy powers for one workspace.
 * Snapshots show counts and class totals only; person keys and evidence
 * references are never displayed to members.
 */
export function ElectoratePanel({tenantId,role}){
  const canManage=managers.includes(role);
  const [rosters,setRosters]=useState([]),[selected,setSelected]=useState(null),[proxies,setProxies]=useState({given:[],received:[]});
  const [error,setError]=useState(""),[notice,setNotice]=useState(""),[busy,setBusy]=useState(false),[revision,setRevision]=useState(0);
  const [draft,setDraft]=useState({kind:"unit-register",name:""});
  const [entry,setEntry]=useState({principalId:"",units:"1",class:"default",personKey:"",validFrom:"",validTo:"",evidenceRef:""});
  const [recordDate,setRecordDate]=useState(""),[snapshot,setSnapshot]=useState(null);
  const [grant,setGrant]=useState({granteeId:"",rosterId:"",units:"",class:"default",expiresAt:""});
  const pending=useRef(null);
  const base="/api/workspaces/"+tenantId;
  useEffect(()=>{
    if(!tenantId)return;
    const abort=new AbortController();
    Promise.all([api(base+"/rosters",{signal:abort.signal}),api(base+"/proxies",{signal:abort.signal})])
      .then(([r,p])=>{if(!abort.signal.aborted){setRosters(r.items);setProxies(p);}})
      .catch(reason=>{if(!abort.signal.aborted)setError(message(reason));});
    return ()=>abort.abort();
  },[tenantId,revision]);
  useEffect(()=>{
    if(!selected?.id)return;
    const abort=new AbortController();
    api(base+"/rosters/"+selected.id,{signal:abort.signal}).then(r=>{if(!abort.signal.aborted)setSelected(r);}).catch(reason=>setError(message(reason)));
    return ()=>abort.abort();
  },[selected?.id,revision]);
  // A retry after a lost response resends the same command ID.
  async function post(kind,path,makeBody,success){
    setBusy(true);setError("");setNotice("");
    if(pending.current?.kind!==kind)pending.current={kind,body:makeBody()};
    try{
      const result=await api(base+path,{method:"POST",body:pending.current.body});
      pending.current=null;setNotice(success);setRevision(r=>r+1);
      return result;
    }catch(reason){
      if(reason.status>=400&&reason.status<500)pending.current=null;
      setError(message(reason)+(pending.current?" Retry sends the same command.":""));
      return null;
    }finally{setBusy(false);}
  }
  if(!tenantId)return null;
  const current=selected?.entries?.find(e=>e.principalId===entry.principalId&&e.class===entry.class);
  return <section className="decision-panel electorate-panel" aria-label="Electorates and proxies">
    <div className="decision-heading"><div><p className="eyebrow">GOVERNANCE / ELECTORATES</p><h3>Rosters, record dates and proxies</h3></div>
      <button onClick={()=>{pending.current=null;setRevision(r=>r+1);}} disabled={busy}>Refresh</button></div>
    {!!error&&<p role="alert" className="decision-error">{error}</p>}
    {!!notice&&<p role="status" className="decision-success">{notice}</p>}
    <ul className="proposal-list">{rosters.map(r=><li key={r.id}>
      <button aria-pressed={selected?.id===r.id} onClick={()=>{setSelected({id:r.id});setSnapshot(null);}}>{r.name} · {KINDS.find(([k])=>k===r.kind)?.[1]}</button></li>)}</ul>
    {rosters.length===0&&<p className="small">No rosters yet.</p>}
    {canManage&&<fieldset disabled={busy} className="decision-policy-advanced"><legend>New roster</legend>
      <label>Kind<select value={draft.kind} onChange={e=>setDraft({...draft,kind:e.target.value})}>{KINDS.map(([k,t])=><option key={k} value={k}>{t}</option>)}</select></label>
      <label>Name<input maxLength={200} value={draft.name} onChange={e=>setDraft({...draft,name:e.target.value})}/></label>
      <button disabled={!draft.name.trim()} onClick={()=>post("roster","/rosters",()=>({kind:draft.kind,name:draft.name.trim(),commandId:crypto.randomUUID()}),"Roster created.")}>Create roster</button>
    </fieldset>}
    {selected?.entries&&<div className="decision-details">
      <h4>{selected.name}</h4>
      <p className="small">{selected.scope==="all-entries"?"All current entries":"Your own entries"} · units are exact decimal integers.</p>
      <table className="roster-table"><thead><tr><th>Member</th><th>Class</th><th>Units</th><th>Valid</th><th>Verified key</th></tr></thead>
        <tbody>{selected.entries.map(e=><tr key={e.principalId+e.class}><td><code>{e.principalId.slice(0,8)}</code></td><td>{e.class}</td>
          <td style={{overflowWrap:"anywhere"}}>{e.units}</td><td>{new Date(e.validFrom).toLocaleDateString()}{e.validTo?" – "+new Date(e.validTo).toLocaleDateString():""}</td>
          <td>{e.personKeyRecorded?"recorded":"—"}</td></tr>)}</tbody></table>
      {canManage&&selected.kind==="membership-derived"&&<button disabled={busy} onClick={()=>post("sync","/rosters/"+selected.id+"/sync-membership",()=>({commandId:crypto.randomUUID()}),"Roster synchronized with active voting members.")}>Synchronize with membership</button>}
      {canManage&&selected.kind!=="membership-derived"&&<fieldset disabled={busy} className="decision-policy-advanced"><legend>Record an entry version</legend>
        <label>Member account ID<input value={entry.principalId} onChange={e=>setEntry({...entry,principalId:e.target.value.trim()})}/></label>
        <label>Class<input value={entry.class} onChange={e=>setEntry({...entry,class:e.target.value.trim()})}/></label>
        <label>Voting units<input inputMode="numeric" value={entry.units} onChange={e=>setEntry({...entry,units:e.target.value.trim()})} disabled={selected.kind==="verified-person-cohort"}/></label>
        <label>Valid from<input type="datetime-local" value={entry.validFrom} onChange={e=>setEntry({...entry,validFrom:e.target.value})}/></label>
        <label>Valid until (optional)<input type="datetime-local" value={entry.validTo} onChange={e=>setEntry({...entry,validTo:e.target.value})}/></label>
        <label>Evidence reference (opaque; never shown publicly)<input value={entry.evidenceRef} onChange={e=>setEntry({...entry,evidenceRef:e.target.value.trim()})}/></label>
        {selected.kind==="verified-person-cohort"&&<label>Person-uniqueness identifier (stored only as a keyed digest)<input type="password" autoComplete="off" value={entry.personKey} onChange={e=>setEntry({...entry,personKey:e.target.value})}/></label>}
        <button disabled={!entry.principalId||!entry.validFrom} onClick={()=>post("entry","/rosters/"+selected.id+"/entries",()=>({
          principalId:entry.principalId,units:selected.kind==="verified-person-cohort"?"1":entry.units,class:entry.class||"default",
          validFrom:new Date(entry.validFrom).toISOString(),validTo:isoOrNull(entry.validTo),evidenceRef:entry.evidenceRef||null,
          ...(entry.personKey?{personKey:entry.personKey}:{}),expectedVersion:current?.version??0,commandId:crypto.randomUUID()}),"Entry version recorded.").then(()=>setEntry(x=>({...x,personKey:""})))}>Record entry</button>
      </fieldset>}
      {canManage&&<fieldset disabled={busy} className="decision-policy-advanced"><legend>Freeze a snapshot at a record date</legend>
        <label>Record date<input type="datetime-local" value={recordDate} onChange={e=>setRecordDate(e.target.value)}/></label>
        <button disabled={!recordDate} onClick={async()=>{const r=await post("snapshot","/rosters/"+selected.id+"/snapshots",()=>({recordDate:new Date(recordDate).toISOString(),commandId:crypto.randomUUID()}),"Snapshot frozen.");if(r)setSnapshot(r);}}>Freeze snapshot</button>
      </fieldset>}
      {snapshot&&<p className="decision-rule">Snapshot <code>{snapshot.snapshotDigest.slice(0,16)}…</code>: {snapshot.principals} principals, {snapshot.totalUnits} units ({Object.entries(snapshot.classTotals).map(([c,u])=>c+" "+u).join(", ")}).
        {" "}{snapshot.entriesIncluded} of {snapshot.entriesConsidered} entries included{Object.keys(snapshot.exclusions).length>0&&<>; excluded: {Object.entries(snapshot.exclusions).map(([r,n])=>r+" ×"+n).join(", ")}</>}.</p>}
    </div>}
    <h4>Proxy powers</h4>
    <fieldset disabled={busy} className="decision-policy-advanced"><legend>Grant my voting power for a roster</legend>
      <label>Proxy account ID<input value={grant.granteeId} onChange={e=>setGrant({...grant,granteeId:e.target.value.trim()})}/></label>
      <label>Roster<select value={grant.rosterId} onChange={e=>setGrant({...grant,rosterId:e.target.value})}><option value="">Choose</option>{rosters.map(r=><option key={r.id} value={r.id}>{r.name}</option>)}</select></label>
      <label>Units to allocate (blank: whole holding)<input inputMode="numeric" value={grant.units} onChange={e=>setGrant({...grant,units:e.target.value.trim()})}/></label>
      {grant.units&&<label>Class<input value={grant.class} onChange={e=>setGrant({...grant,class:e.target.value.trim()})}/></label>}
      <label>Expires (optional)<input type="datetime-local" value={grant.expiresAt} onChange={e=>setGrant({...grant,expiresAt:e.target.value})}/></label>
      <button disabled={!grant.granteeId||!grant.rosterId} onClick={()=>post("grant","/proxies",()=>({granteeId:grant.granteeId,rosterId:grant.rosterId,
        allocation:grant.units?{[grant.class||"default"]:grant.units}:null,expiresAt:isoOrNull(grant.expiresAt),commandId:crypto.randomUUID()}),"Proxy granted. Your own direct vote always takes precedence.")}>Grant proxy</button>
    </fieldset>
    {[["Given",proxies.given],["Received",proxies.received]].map(([title,list])=><div key={title}><p className="eyebrow">{title.toUpperCase()}</p>
      {list.length===0&&<p className="small">None.</p>}
      <ul className="proposal-list">{list.map(g=><li key={g.id}>
        {(title==="Given"?"To ":"From ")}<code>{(title==="Given"?g.granteeId:g.grantorId).slice(0,8)}</code> · {g.allocation?Object.entries(g.allocation).map(([c,u])=>u+" "+c).join(", "):"whole holding"}
        {" "}· {g.active?"active":g.revokedAt?"revoked":"expired"}{g.expiresAt?" · until "+new Date(g.expiresAt).toLocaleString():""}
        {title==="Given"&&g.active&&<button disabled={busy} onClick={()=>post("revoke:"+g.id,"/proxies/"+g.id+"/revoke",()=>({commandId:crypto.randomUUID()}),"Proxy revoked; its ballots stop counting unless the decision already closed.")}>Revoke</button>}
      </li>)}</ul></div>)}
    <p className="decision-legal-note">Rosters record the governing entitlement you configure; they do not create shareholder or voting rights. Person-uniqueness is only as strong as the verification source behind each identifier and is not legal proof of identity.</p>
  </section>;
}
