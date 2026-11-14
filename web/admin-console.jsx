import React,{useEffect,useMemo,useState} from "react";
import {SETTINGS_REGISTRY,validateSettingsChange} from "../src/settings-registry.mjs";
import {createAccountAPI} from "./account-api.mjs";

const SCOPE_TITLES={platform:"Platform defaults",product:"Product defaults",tenant:"Workspace settings",document:"Document settings"};
const messages={
  SETTINGS_VERSION_CONFLICT:"Someone else saved a newer version. Reload, then preview your change again.",
  PLATFORM_ADMIN_REQUIRED:"Only platform administrators can change these settings.",
  ACCESS_DENIED:"Your role cannot change settings at this scope.",
  REAUTHENTICATION_REQUIRED:"Sign in again before changing settings.",
  RECOVERY_SESSION_RESTRICTED:"Recovery sessions cannot change settings. Sign in with your identity provider.",
  AUTHENTICATION_REQUIRED:"Sign in to view settings.",
  SETTING_LOCKED_ACTIVE_VOTE:"Vote rules are locked while a vote is open on this document.",
  NO_SETTINGS_CHANGE:"Nothing would change.",
  SETTINGS_VERSION_NOT_FOUND:"That version cannot be restored.",
};
const describe=error=>messages[error?.code]??(error?.code?.startsWith("INVARIANT_")?"This rule is a fixed platform invariant and cannot be changed.":
  "The settings service could not complete the request. Nothing is assumed saved.");
const show=value=>typeof value==="string"?value:JSON.stringify(value);
const sourceLabel=source=>source==="default"?"Built-in default":source==="invariant"?"Fixed invariant":source.startsWith("product:")?"Product ("+source.slice(8)+")":
  source==="tenant"?"Workspace":source==="document"?"Document":"Platform";
const settingsPath=target=>target.scope==="document"?"/api/workspaces/"+target.tenantId+"/documents/"+target.documentId+"/settings":
  target.scope==="tenant"?"/api/workspaces/"+target.tenantId+"/settings":"/api/settings";
const platformFields=target=>target.scope==="platform"?{scope:"platform"}:target.scope==="product"?{scope:"product",product:target.product}:{};

/** Parses an edited control value into the JSON value sent to the server. */
function parseInput(definition,text){
  if(["integer","duration-hours"].includes(definition.type))return text.trim()===""?NaN:Number(text);
  if(["decimal","string","enum"].includes(definition.type))return text;
  try{return JSON.parse(text);}catch{return text;}
}
function Editor({definition,value,onChange,disabled}){
  const label="New value for "+definition.label;
  if(definition.type==="boolean")return <input type="checkbox" aria-label={label} checked={value===true} disabled={disabled} onChange={e=>onChange(e.target.checked)}/>;
  if(definition.type==="enum")return <select aria-label={label} value={value} disabled={disabled} onChange={e=>onChange(e.target.value)}>
    {definition.values.map(option=><option key={option} value={option}>{option}</option>)}</select>;
  if(["integer","duration-hours","decimal","string"].includes(definition.type))
    return <input aria-label={label} inputMode={definition.type==="string"?undefined:"decimal"} value={Number.isNaN(value)?"":String(value)} disabled={disabled}
      onChange={e=>onChange(parseInput(definition,e.target.value))}/>;
  return <textarea aria-label={label} rows={4} defaultValue={JSON.stringify(value,null,2)} disabled={disabled} onChange={e=>onChange(parseInput(definition,e.target.value))}/>;
}

/**
 * Role-aware settings editor for one scope. Shows each effective value and
 * where it comes from, validates locally, requires a server simulation of the
 * exact pending change before saving, and offers rollback from history.
 */
export function AdminConsole({target,api=createAccountAPI()}){
  const path=settingsPath(target),scopeQuery=target.scope==="product"?"?scope=product&product="+target.product:target.scope==="platform"?"?scope=platform":"";
  const [state,setState]=useState(null);
  const [error,setError]=useState("");
  const [notice,setNotice]=useState("");
  const [pending,setPending]=useState({});
  const [preview,setPreview]=useState(null);
  const [reason,setReason]=useState("");
  const [history,setHistory]=useState(null);
  const [busy,setBusy]=useState(false);
  const [revision,setRevision]=useState(0);
  useEffect(()=>{
    const abort=new AbortController();
    setError("");
    api(path+scopeQuery,{signal:abort.signal}).then(result=>{if(!abort.signal.aborted){setState(result);setPending({});setPreview(null);}})
      .catch(reason=>{if(!abort.signal.aborted)setError(describe(reason));});
    return ()=>abort.abort();
  },[path,scopeQuery,revision]);
  const local=useMemo(()=>Object.keys(pending).length?validateSettingsChange({scope:target.scope,changes:pending,
    context:{activeVote:state?.activeVote,visibility:target.scope==="document"?"public":"organization"}}):null,[pending,state,target.scope]);
  const fieldErrors=Object.fromEntries((local?.errors??[]).map(e=>[e.key,e.message]));
  const pendingText=JSON.stringify(pending);
  const previewCurrent=preview&&preview.changes===pendingText&&preview.result.valid&&!preview.result.stale;
  async function send(kind,body){
    setBusy(true);setError("");setNotice("");
    try{return await api(path+(kind==="change"?"":"/"+kind),{method:"POST",body:{...platformFields(target),...body}});}
    catch(reason){setError(describe(reason));return null;}
    finally{setBusy(false);}
  }
  async function simulate(){
    const result=await send("simulate",{changes:pending,expectedVersion:state.version});
    if(result)setPreview({changes:pendingText,result});
  }
  async function save(){
    const result=await send("change",{changes:pending,expectedVersion:state.version,reason});
    if(result){setNotice("Saved as version "+result.version+".");setReason("");setHistory(null);setRevision(r=>r+1);}
  }
  async function loadHistory(){
    setBusy(true);setError("");
    try{setHistory(await api(path+"/history"+(scopeQuery?scopeQuery+"&":"?")+"limit=20"));}
    catch(reason){setError(describe(reason));}
    finally{setBusy(false);}
  }
  async function rollback(version){
    const result=await send("rollback",{toVersion:version,expectedVersion:state.version,reason});
    if(result){setNotice("Restored version "+version+" as new version "+result.version+".");setReason("");setHistory(null);setRevision(r=>r+1);}
  }
  if(!state)return <section className="admin-console" aria-label="Settings">{error?<p role="alert">{error}</p>:<p role="status">Loading settings…</p>}</section>;
  const editable=new Set(state.editableKeys);
  const groups=[...new Set(SETTINGS_REGISTRY.map(d=>d.group))];
  return <section className="admin-console" aria-label={SCOPE_TITLES[target.scope]}>
    <header><p className="eyebrow">ADMINISTRATION</p><h2>{SCOPE_TITLES[target.scope]}{target.scope==="product"?" — "+target.product:""}</h2>
      <p className="small">Version {state.version}{state.role?" · Your role: "+state.role:""}{editable.size?"":" · Read only"}</p>
      {state.activeVote&&<p role="status">A vote is open on this document. Its frozen rules cannot change; vote-rule settings are locked here.</p>}</header>
    {!!error&&<p role="alert">{error}</p>}
    {!!notice&&<p role="status">{notice}</p>}
    {groups.map(group=><fieldset key={group} className="settings-group"><legend>{group}</legend>
      <table><thead><tr><th scope="col">Setting</th><th scope="col">Effective value</th><th scope="col">Source</th><th scope="col">Change</th></tr></thead>
        <tbody>{SETTINGS_REGISTRY.filter(d=>d.group===group).map(definition=>{
          const entry=state.effective[definition.key],changing=Object.hasOwn(pending,definition.key),overridden=Object.hasOwn(state.overrides,definition.key);
          return <tr key={definition.key} data-setting={definition.key}>
            <th scope="row">{definition.label}<br/><code className="small">{definition.key}</code></th>
            <td><code>{show(entry.value)}</code></td>
            <td><span className="setting-source">{sourceLabel(entry.source)}</span>{entry.locked&&<span className="small"> · locked</span>}</td>
            <td>{editable.has(definition.key)?<>
              {changing&&pending[definition.key]!==null?<Editor definition={definition} value={pending[definition.key]} disabled={busy} onChange={value=>setPending(p=>({...p,[definition.key]:value}))}/>
                :changing?<span>Inherit from the scope above</span>:null}
              {!changing&&<button type="button" disabled={busy} onClick={()=>setPending(p=>({...p,[definition.key]:entry.value}))}>Edit</button>}
              {!changing&&overridden&&<button type="button" disabled={busy} onClick={()=>setPending(p=>({...p,[definition.key]:null}))}>Inherit</button>}
              {changing&&<button type="button" disabled={busy} onClick={()=>setPending(p=>{const next={...p};delete next[definition.key];return next;})}>Discard</button>}
              {fieldErrors[definition.key]&&<p role="alert" className="small">{fieldErrors[definition.key]}</p>}
            </>:<span className="small">{definition.mutability==="invariant"?"Never changeable":"Not editable here"}</span>}</td>
          </tr>;
        })}</tbody></table></fieldset>)}
    {Object.keys(pending).length>0&&<div className="settings-review">
      <button type="button" disabled={busy||!local?.valid} onClick={simulate}>Preview changes</button>
      {preview&&preview.changes===pendingText&&<div className="settings-preview" aria-label="Simulation preview">
        {preview.result.valid?<>
          {preview.result.stale&&<p role="alert">These settings changed since you loaded them. Reload before saving.</p>}
          <p>Affected: {preview.result.affected.tenants!==undefined?preview.result.affected.tenants+" workspaces, ":""}{preview.result.affected.documents} documents, {preview.result.affected.openDecisions} open decisions.</p>
          {preview.result.frozenDecisionNotice&&<p>{preview.result.frozenDecisionNotice}</p>}
          <ul>{preview.result.diff.map(item=><li key={item.key}>{item.label}: <code>{show(item.before.value)}</code> ({sourceLabel(item.before.source)}) → <code>{show(item.after.value)}</code> ({sourceLabel(item.after.source)})</li>)}</ul>
          {!preview.result.diff.length&&<p>No effective value changes at this scope.</p>}
        </>:<ul role="alert">{preview.result.errors.map(e=><li key={e.key+e.code}>{e.message}</li>)}</ul>}
      </div>}
      <label>Reason for this change<input value={reason} maxLength={500} onChange={e=>setReason(e.target.value)}/></label>
      <button type="button" disabled={busy||!previewCurrent||!reason.trim()} onClick={save}>Save new version</button>
    </div>}
    {editable.size>0&&<div className="settings-history">
      <button type="button" disabled={busy} onClick={loadHistory}>{history?"Refresh history":"Show history"}</button>
      {history&&<>
        <p className="small">{history.verified?"History digests verified.":"History verification failed: a stored version does not match its digest chain."}</p>
        <ol>{history.items.map(item=><li key={item.version}>
          Version {item.version} · {new Date(item.createdAt).toLocaleString()} · {item.reason}{item.rollbackOf?" (restores version "+item.rollbackOf+")":""}
          <code className="small"> {Object.keys(item.changes).join(", ")}</code>
          {item.version<state.version&&<button type="button" disabled={busy||!reason.trim()} onClick={()=>rollback(item.version)}>Restore as new version</button>}
        </li>)}</ol>
        {Object.keys(pending).length===0&&history.items.length>1&&<label>Reason for restoring<input value={reason} maxLength={500} onChange={e=>setReason(e.target.value)}/></label>}
      </>}
    </div>}
  </section>;
}
