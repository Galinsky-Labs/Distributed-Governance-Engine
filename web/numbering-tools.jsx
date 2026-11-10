import React,{useEffect,useMemo,useState} from 'react';
const profiles=[['us-federal-v1','US federal'],['corporate-v1','Corporate'],['decimal-v1','Decimal']];
export function NumberingTools({document:doc,editable,live,prepare,apply}){
 const scopes=useMemo(()=>{
  const result=[{id:doc.id,title:'Document sections'}];
  const walk=nodes=>{for(const node of nodes){if(['section','exhibit'].includes(node.kind))result.push({id:node.id,title:node.title+' — child sections'});if(node.children)walk(node.children);}};
  walk(doc.content);return result;
 },[doc]);
 const [profile,setProfile]=useState(doc.metadata.numberingProfile),[parent,setParent]=useState(doc.id),[start,setStart]=useState('1'),[reserved,setReserved]=useState(''),[preview,setPreview]=useState(null),[message,setMessage]=useState('');
 useEffect(()=>{setProfile(doc.metadata.numberingProfile);setPreview(null);setMessage('');if(!scopes.some(scope=>scope.id===parent))setParent(doc.id);},[doc]);
 useEffect(()=>{const rule=doc.metadata.numberingRules?.find(rule=>rule.parentId===parent);setStart(String(rule?.startAt??1));setReserved((rule?.reserved??[]).join(', '));setPreview(null);setMessage('');},[doc,parent]);
 const disabled=!editable||live;
 function change(setter,value){setter(value);setPreview(null);setMessage('');}
 function showPreview(event){
  event.preventDefault();if(disabled)return;
  try{
   if(!/^[1-9]\d{0,6}$/.test(start)||Number(start)>1000000)throw Error('Enter a starting number between 1 and 1,000,000.');
   if(reserved.length>20000)throw Error('Reserved-number input is too long. Use at most 2,000 ordinals.');
   const omitted=reserved.trim()?reserved.split(',').map(value=>{if(!/^\s*[1-9]\d{0,6}\s*$/.test(value)||Number(value)>1000000)throw Error('Enter reserved numbers as increasing, unique integers separated by commas.');return Number(value);}):[];
   const rules=(doc.metadata.numberingRules??[]).filter(rule=>rule.parentId!==parent);
   if(Number(start)!==1||omitted.length)rules.push({parentId:parent,startAt:Number(start),reserved:omitted});
   const result=prepare({profile,rules});setPreview(result);setMessage('Preview only. Review the labels and references before applying.');
  }catch(error){setPreview(null);setMessage(error.message);}
 }
 function commit(){if(!preview||disabled)return;if(apply(preview)){setPreview(null);setMessage('Numbering applied. Use Undo to restore the previous settings.');}else {setPreview(null);setMessage('The preview is no longer current, or the settings are unchanged. Preview again before applying.');}}
 return <section className="numbering-tools" aria-labelledby="numbering-heading">
  <h3 id="numbering-heading">Legal numbering</h3>
  {live&&<p>Exit live editing to change numbering settings.</p>}
  <form onSubmit={showPreview}>
   <label>Numbering profile<select value={profile} disabled={disabled} onChange={event=>change(setProfile,event.target.value)}>{profiles.map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
   <label>Numbering scope<select value={parent} disabled={disabled} onChange={event=>change(setParent,event.target.value)}>{scopes.map(scope=><option key={scope.id} value={scope.id}>{scope.title}</option>)}</select></label>
   <label>Starting number<input type="number" min="1" max="1000000" step="1" value={start} disabled={disabled} onChange={event=>change(setStart,event.target.value)} required /></label>
   <label>Reserved numbers<input maxLength={20000} value={reserved} disabled={disabled} placeholder="For example: 3, 5" onChange={event=>change(setReserved,event.target.value)} /></label>
   <button disabled={disabled}>Preview numbering</button>
  </form>
  <p role="status">{message}</p>
  {preview&&<>
   <table className="numbering-preview"><caption>Proposed section labels</caption><thead><tr><th>Section</th><th>Before</th><th>After</th></tr></thead><tbody>{preview.changed.map(row=><tr key={row.id}><td>{preview.after.find(section=>section.id===row.id)?.title}</td><td>{row.from??'New'}</td><td>{row.to}</td></tr>)}</tbody></table>
   {!preview.changed.length&&<p>No displayed section labels change.</p>}
   <p>{preview.affectedReferences.length} dependent references. Explicit reference labels keep their wording and may need review.</p>
   {!!preview.affectedReferences.length&&<ul>{preview.affectedReferences.map((ref,index)=><li key={index}>{preview.after.find(section=>section.id===ref.targetId)?.title}: {ref.from} → {ref.to}</li>)}</ul>}
   <button disabled={disabled} onClick={commit}>Apply numbering</button>
  </>}
 </section>;
}
