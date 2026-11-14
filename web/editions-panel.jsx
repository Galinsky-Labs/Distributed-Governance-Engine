import React,{useEffect,useRef,useState} from "react";
import {createAccountAPI} from "./account-api.mjs";

const defaultApi=createAccountAPI();
const managers=["owner","admin"];
const KIND_HELP={
  final:"Final: an explicit steward finalization of a collaboration version.",
  adopted:"Adopted: requires the closed, passed decision whose certificate produced exactly this version.",
  "consultation-source":"Consultation source: the frozen text of a public-input consultation.",
};
const message=error=>({
  LEGAL_REFERENCE_ISSUES:"Resolve unresolved references or definition problems before freezing.",
  EDITION_EXISTS:"This version is already frozen as that kind of edition.",
  EDITION_KIND_MODE_MISMATCH:"That edition kind does not match this document's mode.",
  DECISION_CERTIFICATE_REQUIRED:"An adopted edition needs the decision and its certificate digest.",
  DECISION_DID_NOT_PRODUCE_VERSION:"That decision did not pass and produce this exact version.",
  DECISION_CERTIFICATE_MISMATCH:"The certificate digest does not match the closed decision.",
  SOURCE_DIGEST_MISMATCH:"The selected version changed. Refresh and choose again.",
  REAUTHENTICATION_REQUIRED:"Sign in again before freezing an edition.",
})[error?.code]??"The edition could not be frozen. Nothing is assumed to have changed.";

/**
 * Lists a document's immutable editions and lets managers freeze an exact saved
 * version. Props: tenantId, documentId, role, api, onSelect(edition).
 */
export function EditionsPanel({tenantId,documentId,role,api=defaultApi,onSelect}){
  const [editions,setEditions]=useState([]);
  const [versions,setVersions]=useState([]);
  const [kind,setKind]=useState("final");
  const [version,setVersion]=useState("");
  const [decisionId,setDecisionId]=useState("");
  const [certificateDigest,setCertificateDigest]=useState("");
  const [artifact,setArtifact]=useState("");
  const [acknowledged,setAcknowledged]=useState(false);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  const [notice,setNotice]=useState("");
  const [revision,setRevision]=useState(0);
  const pending=useRef(null);
  useEffect(()=>{
    let live=true;
    api("/api/public/editions?documentId="+documentId+"&limit=100").then(r=>{if(live)setEditions(r.items);}).catch(()=>{if(live)setError("Editions are unavailable.");});
    api("/api/public/documents/"+documentId+"/history?limit=20").then(r=>{if(live){setVersions(r.items);setVersion(v=>v||String(r.items[0]?.version??""));}}).catch(()=>{});
    return ()=>{live=false;};
  },[documentId,revision]);
  const selected=versions.find(v=>String(v.version)===version);
  async function freeze(){
    if(busy||!selected)return;
    setBusy(true);setError("");setNotice("");
    // A retry after a network failure reuses the same command ID, so it cannot create a second edition.
    pending.current??={commandId:crypto.randomUUID(),kind,sourceVersion:selected.version,sourceDigest:selected.digest,
      ...(kind==="adopted"?{decisionId:decisionId.trim(),certificateDigest:certificateDigest.trim()}:{}),
      ...(artifact.trim()?{artifact:{sha256:artifact.trim(),mediaType:"application/pdf"}}:{})};
    try{
      const edition=await api("/api/workspaces/"+tenantId+"/documents/"+documentId+"/editions",{method:"POST",body:pending.current});
      pending.current=null;setAcknowledged(false);
      setNotice("Edition "+edition.sequence+" frozen. Digest "+edition.editionDigest+". Later draft edits will not change it.");
      setRevision(r=>r+1);
    }catch(reason){
      if(reason.status>=400&&reason.status<500)pending.current=null;
      setError(message(reason)+(pending.current?" Retrying sends the same command.":""));
    }finally{setBusy(false);}
  }
  if(!documentId)return null;
  return <section className="editions-panel" aria-label="Final editions">
    <p className="eyebrow">IMMUTABLE EDITIONS</p>
    {!!error&&<p role="alert">{error}</p>}
    {!!notice&&<p role="status">{notice}</p>}
    {editions.length===0?<p>No edition has been frozen yet.</p>:<ol>{editions.map(e=><li key={e.id}>
      <strong>Edition {e.sequence}</strong> · {e.kind} ({e.lifecycle}) from version {e.sourceVersion} · <code>{e.editionDigest.slice(0,16)}…</code>
      {e.artifact&&<> · artifact <code>{e.artifact.sha256.slice(0,16)}…</code></>}
      {onSelect&&<button onClick={()=>onSelect(e)}>Open signing</button>}
    </li>)}</ol>}
    {managers.includes(role)&&<fieldset disabled={busy}><legend>Freeze a saved version</legend>
      <label>Kind <select value={kind} onChange={e=>{setKind(e.target.value);pending.current=null;}}>
        <option value="final">Final</option><option value="adopted">Adopted</option><option value="consultation-source">Consultation source</option></select></label>
      <p>{KIND_HELP[kind]}</p>
      <label>Saved version <select value={version} onChange={e=>{setVersion(e.target.value);pending.current=null;}}>
        {versions.map(v=><option key={v.version} value={v.version}>Version {v.version} · {v.digest.slice(0,12)}…</option>)}</select></label>
      {kind==="adopted"&&<>
        <label>Decision ID <input value={decisionId} onChange={e=>setDecisionId(e.target.value)} spellCheck={false}/></label>
        <label>Decision certificate digest <input value={certificateDigest} onChange={e=>setCertificateDigest(e.target.value)} spellCheck={false}/></label>
      </>}
      <label>Rendered PDF SHA-256 from the export step (optional) <input value={artifact} onChange={e=>setArtifact(e.target.value)} spellCheck={false}/></label>
      <label><input type="checkbox" checked={acknowledged} onChange={e=>setAcknowledged(e.target.checked)}/>
        I understand this edition can never be edited or deleted. Changed wording needs a new edition and new signatures.</label>
      <button disabled={!acknowledged||!selected} onClick={freeze}>Freeze edition</button>
    </fieldset>}
  </section>;
}
