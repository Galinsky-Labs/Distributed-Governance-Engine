import React,{useEffect,useState} from "react";
import {createAccountAPI} from "./account-api.mjs";

const api=createAccountAPI();
const managers=["owner","admin"];
const RIGHTS=["read","propose","discuss","vote","sign"];
const ROLES=["owner","admin","editor","participant","viewer"];
const message=error=>({
  SECTION_NOT_FOUND:"Choose a section or the whole document.",
  GRANTEE_NOT_IN_WORKSPACE:"That account is not a member of this workspace.",
  SECTION_ACCESS_VERSION_CONFLICT:"Access settings changed in another session. Refresh first.",
  REAUTHENTICATION_REQUIRED:"Sign in again before changing clause permissions.",
  ACCESS_DENIED:"Only workspace owners and administrators manage clause permissions.",
}[error?.code]??"Clause permissions could not be changed. No success is being assumed.");

/**
 * Clause-level grants for one document. Once any grant exists the document
 * is restricted: text outside an unlocked section cannot be amended,
 * discussed or voted on, and expired unlocks fall back to deny.
 */
export function SectionGrantsPanel({tenantId,documentId,role,sections=[]}){
  const canManage=managers.includes(role);
  const [state,setState]=useState(null),[error,setError]=useState(""),[notice,setNotice]=useState("");
  const [busy,setBusy]=useState(false),[revision,setRevision]=useState(0);
  const [form,setForm]=useState({sectionId:documentId,granteeKind:"role",role:"participant",accountId:"",rosterId:"",class:"default",
    rights:["propose","discuss","vote"],effect:"allow",expiresAt:""});
  const base="/api/workspaces/"+tenantId+"/documents/"+documentId+"/section-grants";
  useEffect(()=>{
    if(!tenantId||!documentId)return;
    const abort=new AbortController();
    api(base,{signal:abort.signal}).then(r=>{if(!abort.signal.aborted)setState(r);}).catch(reason=>{if(!abort.signal.aborted)setError(message(reason));});
    return ()=>abort.abort();
  },[base,revision]);
  async function post(path,body,success){
    setBusy(true);setError("");setNotice("");
    try{await api(base+path,{method:"POST",body});setNotice(success);setRevision(r=>r+1);}
    catch(reason){setError(message(reason));}
    finally{setBusy(false);}
  }
  if(!tenantId||!documentId)return null;
  const titleOf=id=>id===documentId?"Whole document":(sections.find(s=>s.id===id)?.title??id);
  const grantee=form.granteeKind==="role"?{kind:"role",role:form.role}:form.granteeKind==="account"?{kind:"account",accountId:form.accountId}:
    {kind:"roster-class",rosterId:form.rosterId,class:form.class};
  return <section className="decision-panel section-grants-panel" aria-label="Clause permissions">
    <div className="decision-heading"><div><p className="eyebrow">GOVERNANCE / CLAUSE PERMISSIONS</p><h3>Clause permissions</h3></div>
      <button onClick={()=>setRevision(r=>r+1)} disabled={busy}>Refresh</button></div>
    {!!error&&<p role="alert" className="decision-error">{error}</p>}
    {!!notice&&<p role="status" className="decision-success">{notice}</p>}
    {state&&<>
      <p className="decision-rule">{state.restricted?"Restricted: only unlocked sections can be amended, discussed or voted on.":"Open: ordinary workspace roles apply to every section."}</p>
      {state.restricted&&<ul className="proposal-list">{state.mine.map(m=><li key={m.sectionId}>{titleOf(m.sectionId)}: {m.rights.length?m.rights.join(", "):"no rights"}</li>)}</ul>}
      {canManage&&state.grants&&<>
        <h4>Grants</h4>
        <ul className="proposal-list">{state.grants.map(g=><li key={g.id}>
          {g.effect==="deny"?"Deny ":"Allow "}{g.rights.join(", ")} on {titleOf(g.sectionId)} to {g.grantee.kind==="role"?"role "+g.grantee.role:g.grantee.kind==="account"?"account "+g.grantee.accountId.slice(0,8):"roster class "+g.grantee.class}
          {g.expiresAt?" until "+new Date(g.expiresAt).toLocaleString():""}{g.revokedAt?" · revoked":""}
          {!g.revokedAt&&<button disabled={busy} onClick={()=>post("/"+g.id+"/revoke",{commandId:crypto.randomUUID()},"Grant revoked.")}>Revoke</button>}
        </li>)}</ul>
        <fieldset disabled={busy} className="decision-policy-advanced"><legend>Add a grant</legend>
          <label>Section<select value={form.sectionId} onChange={e=>setForm({...form,sectionId:e.target.value})}>
            <option value={documentId}>Whole document</option>{sections.map(s=><option key={s.id} value={s.id}>{s.label?s.label+" ":""}{s.title}</option>)}</select></label>
          <label>Grantee<select value={form.granteeKind} onChange={e=>setForm({...form,granteeKind:e.target.value})}>
            <option value="role">Workspace role</option><option value="account">Account</option><option value="roster-class">Roster class</option></select></label>
          {form.granteeKind==="role"&&<label>Role<select value={form.role} onChange={e=>setForm({...form,role:e.target.value})}>{ROLES.map(r=><option key={r}>{r}</option>)}</select></label>}
          {form.granteeKind==="account"&&<label>Account ID<input value={form.accountId} onChange={e=>setForm({...form,accountId:e.target.value.trim()})}/></label>}
          {form.granteeKind==="roster-class"&&<><label>Roster ID<input value={form.rosterId} onChange={e=>setForm({...form,rosterId:e.target.value.trim()})}/></label>
            <label>Class<input value={form.class} onChange={e=>setForm({...form,class:e.target.value.trim()})}/></label></>}
          <div className="point-actions">{RIGHTS.map(r=><label key={r} className="decision-ack"><input type="checkbox" checked={form.rights.includes(r)}
            onChange={e=>setForm({...form,rights:e.target.checked?[...form.rights,r]:form.rights.filter(x=>x!==r)})}/>{r}</label>)}</div>
          <label>Effect<select value={form.effect} onChange={e=>setForm({...form,effect:e.target.value})}><option value="allow">Allow (unlock)</option><option value="deny">Deny (overrides nested allows)</option></select></label>
          <label>Expires (optional)<input type="datetime-local" value={form.expiresAt} onChange={e=>setForm({...form,expiresAt:e.target.value})}/></label>
          <button disabled={!form.rights.length} onClick={()=>post("",{sectionId:form.sectionId,grantee,rights:form.rights,effect:form.effect,
            expiresAt:form.expiresAt?new Date(form.expiresAt).toISOString():null,commandId:crypto.randomUUID()},
            state.restricted?"Grant recorded.":"Grant recorded. The document is now restricted to its grants.")}>Add grant</button>
        </fieldset>
        {state.restricted&&<button disabled={busy} onClick={()=>post("/access",{restricted:false,expectedVersion:state.version,commandId:crypto.randomUUID()},"Restriction lifted; grants stay on record.")}>Lift restriction</button>}
      </>}
    </>}
    <p className="decision-legal-note">Clause permissions govern amendment, discussion and voting. Published public documents remain publicly readable; read and sign rights are recorded for private and signing workflows.</p>
  </section>;
}
