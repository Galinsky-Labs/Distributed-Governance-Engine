import React,{useEffect,useMemo,useState} from 'react';
import {legalReferenceLabels} from '../src/legal-structure.mjs';
export function ReferenceTools({document:doc,selected,editable,insert,update,remove,navigate,close}){
 const [kind,setKind]=useState(selected?.kind??'reference'),[target,setTarget]=useState(selected?.targetId??''),[label,setLabel]=useState(selected?.label??'');
 useEffect(()=>{setKind(selected?.kind??'reference');setTarget(selected?.targetId??'');setLabel(selected?.label??'');},[selected]);
 const choices=useMemo(()=>{
  const labels=legalReferenceLabels(doc),result=[];let ordinal=0;
  function walk(nodes,context='Document') {for(const node of nodes){
   if(['section','definition','exhibit','footnote'].includes(node.kind)){const value=labels.get(node.id);result.push({id:node.id,kind:node.kind,title:node.kind==='section'?value.text+' '+node.title:node.kind==='definition'?'Definition: '+(node.term||'Unnamed')+' — '+context+' ('+(++ordinal)+')':node.kind==='footnote'?value.text:node.title});}
   if(!['section','definition','exhibit','footnote'].includes(node.kind)&&node.id===selected?.targetId)result.push({id:node.id,kind:node.kind,title:'Existing '+node.kind+' target — '+context});
   if(node.children)walk(node.children,node.kind==='section'?labels.get(node.id).text+' '+node.title:context);
  }}walk(doc.content);if(selected?.targetId===doc.id)result.push({id:doc.id,kind:'document',title:'Current document: '+doc.metadata.title});return result;
 },[doc,selected?.targetId]);
 const targets=kind==='footnote-reference'?choices.filter(choice=>choice.kind==='footnote'):choices,known=targets.some(choice=>choice.id===target),existing=selected?.kind===kind&&selected?.targetId===target,options={kind,targetId:target,label:label.trim()||null};
 return <section className="reference-tools" aria-labelledby="reference-tools-heading">
  <h3 id="reference-tools-heading">Internal reference</h3>
  <p>Targets keep their identity when labels change. Leave the label blank to display the current target label.</p>
  <label>Reference type<select aria-label="Reference type" value={kind} disabled={!editable} onChange={event=>{setKind(event.target.value);setTarget('');}}><option value="reference">Clause, term or exhibit</option><option value="footnote-reference">Footnote</option></select></label>
  <label>Reference target<select aria-label="Reference target" value={target} disabled={!editable} onChange={event=>setTarget(event.target.value)}><option value="">Choose a target</option>{target&&!known&&<option value={target}>Existing unavailable target — choose a replacement</option>}{targets.map(choice=><option key={choice.id} value={choice.id}>{choice.title}</option>)}</select></label>
  <label>Optional reference label<input aria-label="Optional reference label" maxLength={1000} value={label} disabled={!editable} onChange={event=>setLabel(event.target.value)} /></label>
  {!known&&existing&&<p>This reference is still unresolved. Changing its label does not repair the target.</p>}
  <div className="toolbar">
   <button disabled={!editable||!known&&!existing} onMouseDown={event=>event.preventDefault()} onClick={()=>selected?update(options):insert(options)}>{selected?'Update reference':'Insert reference'}</button>
   <button disabled={!selected} onMouseDown={event=>event.preventDefault()} onClick={navigate}>Go to target</button>
   <button disabled={!editable||!selected} onMouseDown={event=>event.preventDefault()} onClick={remove}>Remove reference</button>
   <button onClick={close}>Close reference tools</button>
  </div>
 </section>;
}
export function DefinitionTools({selected,editable,add,rename,close}){
 const [term,setTerm]=useState(selected?.term??''),[meaning,setMeaning]=useState('');
 useEffect(()=>{setTerm(selected?.term??'');setMeaning('');},[selected?.id,selected?.term]);
 return <section className="reference-tools" aria-labelledby="definition-tools-heading"><h3 id="definition-tools-heading">Defined terms</h3>
  <p>New definitions are added at the end of the document. Duplicate terms remain flagged for review.</p>
  <label>Defined term<input aria-label="Defined term" maxLength={1000} value={term} disabled={!editable} onChange={event=>setTerm(event.target.value)} /></label>
  <label>New definition text<textarea aria-label="New definition text" maxLength={10000} value={meaning} disabled={!editable} onChange={event=>setMeaning(event.target.value)} rows={3} /></label>
  <div className="toolbar"><button disabled={!editable||!term.trim()||!meaning.trim()} onClick={()=>add(term,meaning)}>Add definition</button><button disabled={!editable||!selected||!term.trim()} onMouseDown={event=>event.preventDefault()} onClick={()=>rename(term)}>Rename selected term</button><button onClick={close}>Close definition tools</button></div>
 </section>;
}
export function FootnoteTools({editable,add,close}){
 const [text,setText]=useState('');
 return <section className="reference-tools" aria-labelledby="footnote-tools-heading"><h3 id="footnote-tools-heading">New footnote</h3><p>Add a footnote and its reference at the current text selection as one undoable change.</p><label>Footnote text<textarea aria-label="Footnote text" maxLength={10000} value={text} disabled={!editable} onChange={event=>setText(event.target.value)} rows={3} /></label><div className="toolbar"><button disabled={!editable||!text.trim()} onMouseDown={event=>event.preventDefault()} onClick={()=>{if(add(text))setText('');}}>Insert footnote</button><button onClick={close}>Close footnote tools</button></div></section>;
}
