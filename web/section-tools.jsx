import React,{useEffect,useState} from 'react';
export function SectionTools({selection,document:doc,editable,live,prepare,apply}){
 const [preview,setPreview]=useState(null),[message,setMessage]=useState('');
 useEffect(()=>{setPreview(null);setMessage('');},[doc,selection?.id]);
 const disabled=!editable||live||!selection;
 function show(direction){if(disabled)return;try{setPreview(prepare(direction));setMessage('Preview only. Review changed labels and references before applying.');}catch(error){setPreview(null);setMessage(error.message);}}
 function commit(){if(disabled||!preview)return;if(!apply(preview))setMessage('The preview is no longer current. Select the section and preview again.');setPreview(null);}
 return <section className="section-tools" aria-labelledby="section-hierarchy-heading">
  <h3 id="section-hierarchy-heading">Section hierarchy</h3>
  <p>{selection?'Selected section: '+selection.title:'Select text within one section to preview indent or outdent.'}</p>
  {live&&<p>Exit live editing to restructure sections.</p>}
  <div className="toolbar">
   <button disabled={disabled||!selection?.canIndent} onMouseDown={event=>event.preventDefault()} onClick={()=>show('indent')}>Preview indent</button>
   <button disabled={disabled||!selection?.canOutdent} onMouseDown={event=>event.preventDefault()} onClick={()=>show('outdent')}>Preview outdent</button>
  </div>
  <p role="status">{message}</p>
  {preview&&<>
   <p>{preview.direction==='indent'?'Indent':'Outdent'} “{preview.title}” {preview.placement.relation} “{preview.placement.title}”.</p>
   <table className="numbering-preview"><caption>Section move preview</caption><thead><tr><th>Section</th><th>Before</th><th>After</th></tr></thead><tbody>{preview.renamed.map(row=><tr key={row.id}><td>{preview.preview.find(section=>section.id===row.id)?.title}</td><td>{row.from}</td><td>{row.to}</td></tr>)}</tbody></table>
   <p>{preview.affectedReferences.length} dependent references. Explicit labels retain their wording and may need review.</p>
   {!!preview.affectedReferences.length&&<ul>{preview.affectedReferences.map((ref,index)=><li key={index}>{preview.preview.find(section=>section.id===ref.targetId)?.title}: {ref.from} → {ref.to}</li>)}</ul>}
   {!!preview.issues.length&&<p>{preview.issues.length} reference issues remain. Resolve them before finalization.</p>}
   <button disabled={disabled} onMouseDown={event=>event.preventDefault()} onClick={commit}>Apply section move</button>
  </>}
 </section>;
}
