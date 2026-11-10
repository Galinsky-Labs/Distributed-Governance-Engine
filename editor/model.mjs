import {Schema,DOMParser,DOMSerializer} from 'prosemirror-model';
import {EditorState,Plugin,NodeSelection,TextSelection} from 'prosemirror-state';
import {EditorView} from 'prosemirror-view';
import {baseKeymap,toggleMark} from 'prosemirror-commands';
import {history,undo,redo} from 'prosemirror-history';
import {keymap} from 'prosemirror-keymap';
import {wrapInList,splitListItem} from 'prosemirror-schema-list';
import {validateLegalDocument,legalOutline,normalizeExternalUrl,normalizeCitationMetadata} from '../src/legal-structure.mjs';
import {findNextText,findTextMatches} from './search.mjs';
import {validateTextSelection} from '../src/text-selections.mjs';
import {moveTableCell} from './tables.mjs';
import {numberingCapability,prepareNumbering,applyPreparedNumbering} from './numbering.mjs';
import {sectionMoveCapability,prepareSectionMove,applyPreparedSectionMove} from './sections.mjs';

const attrs={id:{default:null}};
const blockAttrs=node=>({'data-block-id':node.attrs.id});
export const editorSchema=new Schema({
 nodes:{
  doc:{content:'block+',attrs:{numberingProfile:{default:null},numberingRules:{default:null},numberingRulesPresent:{default:null}}},
  text:{group:'inline'},
  paragraph:{group:'block',content:'inline*',attrs,parseDOM:[{tag:'p'}],toDOM:node=>['p',blockAttrs(node),0]},
  section:{group:'block',content:'(section|paragraph|legal_list|table|definition|exhibit)+',attrs:{...attrs,title:{default:'Section'},numberLabel:{default:''}},defining:true,toDOM:node=>['section',blockAttrs(node),['h2',{contenteditable:'false'},(node.attrs.numberLabel?node.attrs.numberLabel+' ':'')+node.attrs.title],['div',{'data-section-content':'true'},0]]},
  legal_list:{group:'block',content:'list_item+',attrs:{...attrs,style:{default:'decimal'}},parseDOM:[{tag:'ol',getAttrs:()=>({style:'decimal'})},{tag:'ul',getAttrs:()=>({style:'bullet'})}],toDOM:node=>[node.attrs.style==='bullet'?'ul':'ol',{...blockAttrs(node),'data-list-style':node.attrs.style},0]},
  list_item:{content:'paragraph (paragraph|legal_list|table)*',attrs,defining:true,parseDOM:[{tag:'li'}],toDOM:node=>['li',blockAttrs(node),0]},
  table:{group:'block',content:'table_row+',attrs,isolating:true,parseDOM:[{tag:'table'}],toDOM:node=>['table',blockAttrs(node),['tbody',0]]},
  table_row:{content:'table_cell+',attrs,parseDOM:[{tag:'tr'}],toDOM:node=>['tr',blockAttrs(node),0]},
  table_cell:{content:'(paragraph|legal_list)+',attrs,isolating:true,parseDOM:[{tag:'td'},{tag:'th'}],toDOM:node=>['td',blockAttrs(node),0]},
  definition:{group:'block',content:'inline*',attrs:{...attrs,term:{default:''}},toDOM:node=>['p',{...blockAttrs(node),'data-definition':node.attrs.term},['strong',{contenteditable:'false'},node.attrs.term+'—'],['span',0]]},
  exhibit:{group:'block',content:'(section|paragraph|legal_list|table|definition)+',attrs:{...attrs,title:{default:'Exhibit'}},defining:true,toDOM:node=>['section',blockAttrs(node),['h2',{contenteditable:'false'},node.attrs.title],['div',0]]},
  footnote:{group:'block',content:'inline*',attrs,toDOM:node=>['aside',{...blockAttrs(node),'data-footnote':'true'},0]},
  reference:{inline:true,group:'inline',atom:true,attrs:{targetId:{},label:{default:null}},toDOM:node=>['span',{'data-reference':node.attrs.targetId},node.attrs.label??'['+node.attrs.targetId+']']},
  footnote_reference:{inline:true,group:'inline',atom:true,attrs:{targetId:{},label:{default:null}},toDOM:node=>['sup',{'data-footnote-reference':node.attrs.targetId},node.attrs.label??'['+node.attrs.targetId+']']},
  external_link:{inline:true,group:'inline',atom:true,attrs:{targetUrl:{},label:{},title:{default:null}},toDOM:node=>['a',{href:node.attrs.targetUrl,title:node.attrs.title,rel:'noreferrer noopener'},node.attrs.label]},
  citation:{inline:true,group:'inline',atom:true,attrs:{targetUrl:{},label:{},title:{default:null},citationMetadata:{default:null}},toDOM:node=>['cite',['a',{href:node.attrs.targetUrl,title:node.attrs.title,rel:'noreferrer noopener'},node.attrs.label]]}
 },
 marks:{
  bold:{parseDOM:[{tag:'strong'},{tag:'b'}],toDOM:()=>['strong',0]},
  italic:{parseDOM:[{tag:'em'},{tag:'i'}],toDOM:()=>['em',0]},
  underline:{parseDOM:[{tag:'u'}],toDOM:()=>['u',0]},
  strike:{parseDOM:[{tag:'s'},{tag:'del'},{tag:'strike'}],toDOM:()=>['s',0]}
 }
});
const types={'list':'legal_list','list-item':'list_item','table-row':'table_row','table-cell':'table_cell','footnote-reference':'footnote_reference',link:'external_link'};
const kinds=Object.fromEntries(Object.entries(types).map(([a,b])=>[b,a]));
const newId=()=> 'b-'+globalThis.crypto.randomUUID();
function toNode(node,labels) {
 if(node.kind==='text')return node.text?editorSchema.text(node.text,(node.marks??[]).map(name=>editorSchema.marks[name].create())):null;
 const {kind,inlines,children,...attributes}=node;
 if(kind==='section')attributes.numberLabel=labels.get(node.id)??'';
 if(attributes.label===undefined&&['reference','footnote-reference'].includes(kind))attributes.label=null;
 if(attributes.title===undefined&&['link','citation'].includes(kind))attributes.title=null;
 if(kind==='citation'&&attributes.citationMetadata===undefined)attributes.citationMetadata=null;
 return editorSchema.nodes[types[kind]??kind].createChecked(attributes,(inlines??children??[]).map(child=>toNode(child,labels)).filter(Boolean));
}
function fromNode(node) {
 if(node.isText)return {kind:'text',text:node.text,...(node.marks.length?{marks:node.marks.map(m=>m.type.name)}:{})};
 const kind=kinds[node.type.name]??node.type.name,attributes={...node.attrs};if(attributes.label===null)delete attributes.label;if(attributes.title===null)delete attributes.title;if(attributes.citationMetadata===null)delete attributes.citationMetadata;
 delete attributes.numberLabel;
 const base={kind,...attributes};
 if(['reference','footnote-reference','link','citation'].includes(kind))return base;
 const children=[];node.forEach(child=>children.push(fromNode(child)));
 return {...base,...(['paragraph','definition','footnote'].includes(kind)?{inlines:children}:{children})};
}
export function legalToEditor(document) {const doc=validateLegalDocument(document),labels=new Map(legalOutline(doc).map(x=>[x.id,x.label]));return editorSchema.nodes.doc.createChecked({numberingProfile:doc.metadata.numberingProfile,numberingRules:doc.metadata.numberingRules??[],numberingRulesPresent:Object.hasOwn(doc.metadata,'numberingRules')},doc.content.map(node=>toNode(node,labels)));}
export function editorToLegal(doc,base,{increment=false}={}) {
 const content=[];doc.forEach(node=>content.push(fromNode(node)));
 const metadata={...structuredClone(base.metadata)};
 if(doc.attrs.numberingProfile!==null)metadata.numberingProfile=doc.attrs.numberingProfile;
 if(doc.attrs.numberingRulesPresent===false)delete metadata.numberingRules;
 else if(doc.attrs.numberingRulesPresent===true)metadata.numberingRules=structuredClone(doc.attrs.numberingRules);
 else if(doc.attrs.numberingRules!==null)metadata.numberingRules=structuredClone(doc.attrs.numberingRules);
 return validateLegalDocument({...structuredClone(base),metadata,revision:base.revision+(increment?1:0),content});
}
export const canDirectlyEdit=document=>document.mode==='collaboration'&&document.lifecycle==='draft';
export function identityPlugin(baseDocument) {
 return new Plugin({appendTransaction(transactions,_old,state){
  if(!transactions.some(t=>t.docChanged))return null;
  const seen=new Set(),tr=state.tr;
  state.doc.descendants((node,pos)=>{if(node.isText||node.isInline)return;let id=node.attrs.id;if(typeof id!=='string'||seen.has(id)){id=newId();tr.setNodeMarkup(pos,undefined,{...node.attrs,id});}seen.add(id);});
  const labels=new Map(legalOutline(editorToLegal(tr.doc,baseDocument)).map(x=>[x.id,x.label]));
  tr.doc.descendants((node,pos)=>{if(node.type.name==='section'&&node.attrs.numberLabel!==labels.get(node.attrs.id))tr.setNodeMarkup(pos,undefined,{...node.attrs,numberLabel:labels.get(node.attrs.id)});});
  return tr.docChanged?tr:null;
 }});
}
export function createLegalEditorState(document,{readOnly=false}={}) {
 const editable=canDirectlyEdit(document)&&!readOnly;
 return EditorState.create({schema:editorSchema,doc:legalToEditor(document),plugins:[
  new Plugin({filterTransaction:tr=>editable||!tr.docChanged}),numberingCapability(editable),sectionMoveCapability(editable),identityPlugin(document),history(),
  keymap({'Mod-z':undo,'Mod-y':redo,'Mod-Shift-z':redo,'Mod-b':toggleMark(editorSchema.marks.bold),'Mod-i':toggleMark(editorSchema.marks.italic),'Mod-u':toggleMark(editorSchema.marks.underline),'Enter':splitListItem(editorSchema.nodes.list_item),'Tab':moveTableCell({grow:editable}),'Shift-Tab':moveTableCell({backward:true})}),keymap(baseKeymap)
 ]});
}
export function applyLegalTransaction(state,transaction,base) {
 if(transaction.docChanged&&!canDirectlyEdit(base))return {state,document:base,changed:false};
 const result=state.applyTransaction(transaction),changed=result.transactions.some(t=>t.docChanged);
 return {state:result.state,document:changed?editorToLegal(result.state.doc,base,{increment:true}):base,changed};
}
export function mountLegalEditor(element,initial,{onChange=()=>{},onError=()=>{},onSelectionChange=()=>{},readOnly=false}={}) {
 let current=validateLegalDocument(initial),rejectedTransactions=0;
 const view=new EditorView(element,{state:createLegalEditorState(current,{readOnly}),editable:()=>canDirectlyEdit(current)&&!readOnly,transformPastedHTML:html=>cleanPastedHTML(html,element.ownerDocument).innerHTML,attributes:{role:'textbox','aria-label':'Legal document text','aria-multiline':'true',spellcheck:'true'},dispatchTransaction(transaction){
  try{const next=applyLegalTransaction(view.state,transaction,current);current=next.document;view.updateState(next.state);onSelectionChange(view.state);if(next.changed)onChange(current);}catch(error){rejectedTransactions++;onError(error.message);}
 }});
 onSelectionChange(view.state);
 return {view,getDocument:()=>current,
 previewNumbering:options=>prepareNumbering(view.state,current,options),
 previewSectionMove:direction=>prepareSectionMove(view.state,current,direction),
 applySectionMove(preview){return this.command(applyPreparedSectionMove(preview));},
 applyNumbering(preview){return this.command(applyPreparedNumbering(preview));},
 getTextSelection(){
  const native=element.ownerDocument.defaultView.getSelection();
  let selection=view.state.selection;
  if(native&&!native.isCollapsed&&view.dom.contains(native.anchorNode)&&view.dom.contains(native.focusNode)){
   const a=view.posAtDOM(native.anchorNode,native.anchorOffset),b=view.posAtDOM(native.focusNode,native.focusOffset);selection=TextSelection.create(view.state.doc,Math.min(a,b),Math.max(a,b));
  }
  if(selection.empty||!selection.$from.sameParent(selection.$to)||!selection.$from.parent.isTextblock)throw Error('Select text within one body paragraph.');
  const start=selection.$from.parentOffset,end=selection.$to.parentOffset;
  return validateTextSelection(current,{blockId:selection.$from.parent.attrs.id,start,end,quote:selection.$from.parent.textBetween(start,end,'','\uFFFC')});
 },destroy:()=>view.destroy(),findNext(query,options={}){const result=findTextMatches(view.state,query,options);const found=findNextText(query,options)(view.state,view.dispatch);if(found)view.focus();return {...result,found};},command(command){if(readOnly||!canDirectlyEdit(current))return false;const before=rejectedTransactions,done=command(view.state,view.dispatch,view);view.focus();return done&&before===rejectedTransactions;}};
}
export const commands={undo,redo,bold:toggleMark(editorSchema.marks.bold),italic:toggleMark(editorSchema.marks.italic),underline:toggleMark(editorSchema.marks.underline),strike:toggleMark(editorSchema.marks.strike),numberedList:wrapInList(editorSchema.nodes.legal_list,{style:'decimal'}),bulletList:wrapInList(editorSchema.nodes.legal_list,{style:'bullet'})};
function insertExternalInline(kind,targetUrl,label,title,citationMetadata) {return (state,dispatch)=>{
 let url,metadata=null;try{url=normalizeExternalUrl(targetUrl);metadata=kind==='citation'?normalizeCitationMetadata(citationMetadata):null;}catch{return false;}
 const selected=state.selection.empty?'':state.doc.textBetween(state.selection.from,state.selection.to,'','');const text=(label??selected).trim();
 if(!text||text.length>1000||title!==undefined&&title!==null&&(typeof title!=='string'||title.length>1000)||!state.selection.$from.sameParent(state.selection.$to)||!state.selection.$from.parent.isTextblock)return false;
 if(dispatch){const node=editorSchema.nodes[kind].createChecked({targetUrl:url,label:text,title:title??null,...(kind==='citation'?{citationMetadata:metadata}: {})});dispatch(state.tr.replaceSelectionWith(node).scrollIntoView());}return true;
};}
export const insertExternalLink=(targetUrl,label,title)=>insertExternalInline('external_link',targetUrl,label,title);
export const insertCitation=(targetUrl,label,title,citationMetadata)=>insertExternalInline('citation',targetUrl,label,title,citationMetadata);
function externalInlineSelection(state) {
 const {selection}=state;
 if(!(selection instanceof NodeSelection)||!['external_link','citation'].includes(selection.node.type.name))return null;
 return {node:selection.node,from:selection.from,to:selection.to};
}
export function selectedExternalInline(state) {
 const selected=externalInlineSelection(state);if(!selected)return null;
 const {targetUrl,label,title,citationMetadata}=selected.node.attrs;
 return {kind:selected.node.type.name==='external_link'?'link':'citation',targetUrl,label,...(title===null?{}:{title}),...(citationMetadata==null?{}:{citationMetadata:structuredClone(citationMetadata)})};
}
export function updateExternalInline({targetUrl,label,title,citationMetadata}={}) {return (state,dispatch)=>{
 const selected=externalInlineSelection(state);if(!selected)return false;
 let url,nextMetadata;try{url=normalizeExternalUrl(targetUrl);nextMetadata=selected.node.type.name==='citation'?citationMetadata===undefined?selected.node.attrs.citationMetadata:normalizeCitationMetadata(citationMetadata):null;}catch{return false;}
 if(selected.node.type.name==='external_link'&&citationMetadata!==undefined)return false;
 const text=typeof label==='string'?label.trim():'',nextTitle=title===undefined?selected.node.attrs.title:title;
 if(!text||text.length>1000||nextTitle!==null&&(typeof nextTitle!=='string'||nextTitle.length>1000))return false;
 if(dispatch)dispatch(state.tr.setNodeMarkup(selected.from,selected.node.type,{targetUrl:url,label:text,title:nextTitle??null,...(selected.node.type.name==='citation'?{citationMetadata:nextMetadata}: {})}).scrollIntoView());
 return true;
};}
export function removeExternalInline(state,dispatch) {
 const selected=externalInlineSelection(state);if(!selected)return false;
 if(dispatch)dispatch(state.tr.replaceWith(selected.from,selected.to,state.schema.text(selected.node.attrs.label)).scrollIntoView());
 return true;
}
export function appendSection(title) {return (state,dispatch)=>{
 if(typeof title!=='string'||!title.trim()||title.length>200)return false;
 if(dispatch){const section=editorSchema.nodes.section.createChecked({id:newId(),title:title.trim()},editorSchema.nodes.paragraph.create({id:newId()}));const pos=state.doc.content.size;const tr=state.tr.insert(pos,section);tr.setSelection(TextSelection.near(tr.doc.resolve(pos+2)));dispatch(tr.scrollIntoView());}return true;
};}
export function appendTable(rows=2,columns=2) {return (state,dispatch)=>{
 if(!Number.isInteger(rows)||!Number.isInteger(columns)||rows<1||rows>20||columns<1||columns>10)return false;
 if(dispatch){const children=Array.from({length:rows},()=>editorSchema.nodes.table_row.createChecked({id:newId()},Array.from({length:columns},()=>editorSchema.nodes.table_cell.createChecked({id:newId()},editorSchema.nodes.paragraph.create({id:newId()})))));const table=editorSchema.nodes.table.createChecked({id:newId()},children);const position=state.doc.content.size,tr=state.tr.insert(position,table);tr.setSelection(TextSelection.near(tr.doc.resolve(position+3),1));dispatch(tr.scrollIntoView());}return true;
};}
function cleanPastedHTML(html,domDocument) {
 const container=domDocument.createElement('div');container.innerHTML=html;
 for(const node of container.querySelectorAll('script,style,iframe,object,embed,svg,math,template,link,meta'))node.remove();
 return container;
}
export function parsePastedHTML(html,domDocument) {return DOMParser.fromSchema(editorSchema).parseSlice(cleanPastedHTML(html,domDocument));}
export function renderedFragment(document,domDocument) {return DOMSerializer.fromSchema(editorSchema).serializeFragment(legalToEditor(document).content,{document:domDocument});}
