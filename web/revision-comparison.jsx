import React,{useEffect,useRef,useState} from 'react';
import {createAccountAPI} from './account-api.mjs';
import {compareLegalRevisions,verifyRevisionSnapshot} from '../src/revision-comparison.mjs';

const api=createAccountAPI();
const json=value=>JSON.stringify(value,null,2);
export function RevisionComparison({documentId,tenantId,versions}){
 const [open,setOpen]=useState(false),[from,setFrom]=useState(''),[to,setTo]=useState(''),[result,setResult]=useState(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[limit,setLimit]=useState(100);
 const dialog=useRef(null),trigger=useRef(null);
 useEffect(()=>{if(open&&!dialog.current.open)dialog.current.showModal();},[open]);
 useEffect(()=>{
  if(!open)return;
  const abort=new AbortController();setResult(null);setError('');setBusy(true);setLimit(100);
  (async()=>{
   const get=async value=>{
    const version=Number(value),item=versions.find(row=>row.version===version);
    if(!item)throw Error('Unknown edition');
    const snapshot=await api(`/api/public/documents/${documentId}?version=${version}`,{signal:abort.signal});
    return verifyRevisionSnapshot(snapshot,{documentId,tenantId,version,digest:item.digest});
   };
   const [before,after]=await Promise.all([get(from),get(to)]);
   if(abort.signal.aborted)return;
   const comparison=compareLegalRevisions(before.document,after.document);
   setResult({from,to,before:{version:before.version,digest:before.digest},after:{version:after.version,digest:after.digest},comparison});
  })().catch(()=>{if(!abort.signal.aborted)setError('These exact saved editions could not be verified or compared. Reload version history and try again.');}).finally(()=>{if(!abort.signal.aborted)setBusy(false);});
  return ()=>abort.abort();
 },[open,from,to,documentId,tenantId,versions]);
 function close(){dialog.current?.close();setOpen(false);trigger.current?.focus();}
 const shown=result?.from===from&&result?.to===to?result:null;
 function download(){
  if(!shown)return;
  const report={schemaVersion:1,profile:'quill-stable-id-comparison-v1',verification:'content-checksums-only',legallyExecuted:false,before:shown.before,after:shown.after,comparison:shown.comparison};
  const url=URL.createObjectURL(new Blob([json(report)],{type:'application/json'})),link=document.createElement('a');
  link.href=url;link.download='Quill-comparison-v'+shown.before.version+'-v'+shown.after.version+'.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
 }
 return <>
  <button ref={trigger} disabled={versions.length<2} onClick={()=>{setFrom(String(versions[1].version));setTo(String(versions[0].version));setOpen(true);}}>Compare saved versions</button>
  {open&&<dialog ref={dialog} className="revision-comparison" aria-labelledby="revision-comparison-title" onCancel={event=>{event.preventDefault();close();}}>
   <div className="revision-comparison-heading"><h2 id="revision-comparison-title">Compare saved editions</h2><button onClick={close}>Close comparison</button></div>
   <p>Choose two saved editions. Current unsaved and unacknowledged live edits are excluded.</p>
   <div className="revision-comparison-selectors">
    <label>From saved version<select aria-label="From saved version" value={from} onChange={event=>setFrom(event.target.value)}>{versions.map(row=><option key={row.version} value={row.version}>Version {row.version}</option>)}</select></label>
    <label>To saved version<select aria-label="To saved version" value={to} onChange={event=>setTo(event.target.value)}>{versions.map(row=><option key={row.version} value={row.version}>Version {row.version}</option>)}</select></label>
   </div>
   {busy&&!shown&&<p role="status">Loading and checking exact saved editions…</p>}
   {error&&<p role="alert">{error}</p>}
   {shown&&<div className="revision-comparison-result">
    <p role="status">{shown.comparison.unchanged?'No semantic content, structure or metadata changes.':`${shown.comparison.changes.length} changed nodes; ${shown.comparison.metadata.length} document metadata changes.`}</p>
    <p>Highlights group each node’s wording changes into one span. Expand semantic details to inspect formatting and references.</p>
    {shown.comparison.metadata.map(change=><details key={change.field} className="revision-metadata-change"><summary>Document {change.field} changed</summary><div className="revision-comparison-columns"><div><h4>Before</h4><pre>{json(change.before)}</pre></div><div><h4>After</h4><pre>{json(change.after)}</pre></div></div></details>)}
    <ol className="revision-node-changes">{shown.comparison.changes.slice(0,limit).map(change=><li key={change.id}>
     <h3>{change.kind==='added'?'Added':change.kind==='removed'?'Removed':'Changed'} {(change.after??change.before).kind} <code>{change.id}</code></h3>
     {(change.before?.label||change.after?.label)&&<p>Label: {change.before?.label??'None'} → {change.after?.label??'None'}</p>}
     {change.moved&&<p>Moved or reordered. Parent: {change.before.parentId} → {change.after.parentId}; sibling position: {change.before.order+1} → {change.after.order+1}</p>}
     {(change.text.removed||change.text.inserted)&&<p className="revision-text-change">{change.text.prefix}<del aria-label="Removed wording">{change.text.removed}</del><ins aria-label="Added wording">{change.text.inserted}</ins>{change.text.suffix}</p>}
     <details><summary>{change.fields.length?'Semantic fields changed: '+change.fields.join(', '):'Semantic source'}</summary><div className="revision-comparison-columns"><div><h4>Before</h4><pre>{json(change.before?.source??null)}</pre></div><div><h4>After</h4><pre>{json(change.after?.source??null)}</pre></div></div></details>
    </li>)}</ol>
    {shown.comparison.changes.length>limit&&<button onClick={()=>setLimit(value=>value+100)}>Show 100 more changes</button>}
    <details className="revision-comparison-checksums"><summary>Saved edition checksums</summary>
     <p className="revision-comparison-binding">Version {shown.before.version}: <code>{shown.before.digest}</code><br/>Version {shown.after.version}: <code>{shown.after.digest}</code></p>
     <p>Content matches the selected history checksums. Publisher identity, signatures and external anchors require separate verification.</p>
    </details>
    <button onClick={download}>Download comparison JSON</button>
   </div>}
  </dialog>}
 </>;
}
