import {Plugin} from 'prosemirror-state';
import {DOMSerializer} from 'prosemirror-model';
import {legalReferenceLabels,legalReferenceText} from '../src/legal-structure.mjs';
/** NodeViews deliberately never dispatch or persist derived reference labels. */
export function referencePresentation(documentForState){
 const mounted=new Set(),clipboard=new DOMSerializer({},{});let cachedDoc=null,cachedLabels;
 const labelsFor=view=>{if(cachedDoc!==view.state.doc){cachedLabels=legalReferenceLabels(documentForState(view.state));cachedDoc=view.state.doc;}return cachedLabels;};
 function nodeView(initial,view){
  let node=initial;const footnote=node.type.name==='footnote_reference',dom=view.dom.ownerDocument.createElement(footnote?'sup':'span');
  dom.contentEditable='false';
  const entry={render(){
   const labels=labelsFor(view),target=labels.get(node.attrs.targetId),run={kind:footnote?'footnote-reference':'reference',...node.attrs};
   const text=legalReferenceText(run,labels),missing=!target||footnote&&target.kind!=='footnote';
   dom.textContent=text;
   dom.setAttribute(footnote?'data-footnote-reference':'data-reference',node.attrs.targetId);
   dom.setAttribute('data-reference-state',missing?'unresolved':'resolved');
   dom.classList.toggle('internal-reference-unresolved',missing);
   dom.title=missing?'Reference target unavailable. Choose a replacement before finalization.':footnote?'Footnote reference':'Internal reference';
   dom.setAttribute('aria-label',(missing?'Unresolved reference: ':footnote?'Footnote reference: ':'Reference: ')+text);
  }};
  mounted.add(entry);entry.render();
  return {dom,update(next){if(next.type!==node.type)return false;node=next;entry.render();return true;},destroy(){mounted.delete(entry);}};
 }
 return new Plugin({props:{clipboardSerializer:clipboard,nodeViews:{reference:nodeView,footnote_reference:nodeView},clipboardTextSerializer(slice,view){const labels=labelsFor(view);return slice.content.textBetween(0,slice.content.size,'\n\n',node=>{if(['reference','footnote_reference'].includes(node.type.name))return legalReferenceText({kind:node.type.name==='reference'?'reference':'footnote-reference',...node.attrs},labels);return ['external_link','citation'].includes(node.type.name)?node.attrs.label:'';});}},view(view){
  const standard=DOMSerializer.fromSchema(view.state.schema);Object.assign(clipboard.nodes,standard.nodes);Object.assign(clipboard.marks,standard.marks);
  clipboard.nodes.reference=node=>['span',{'data-reference':node.attrs.targetId},legalReferenceText({kind:'reference',...node.attrs},labelsFor(view))];
  clipboard.nodes.footnote_reference=node=>['sup',{'data-footnote-reference':node.attrs.targetId},legalReferenceText({kind:'footnote-reference',...node.attrs},labelsFor(view))];
  return {update(view,previous){if(view.state.doc!==previous.doc)for(const entry of mounted)entry.render();},destroy(){mounted.clear();cachedDoc=null;cachedLabels=null;}};}});
}
