/**
 * Redlines between two editions of one legal document: a format-neutral model
 * (inserted/deleted/unchanged segments per block, built from
 * compareLegalRevisions) and PDF, DOCX and HTML renderers. Changes are shown by
 * text markers and decoration as well as colour.
 */
import {validateLegalDocument,legalOutline,legalReferenceLabels,legalReferenceText} from '../legal-structure.mjs';
import {compareLegalRevisions} from '../revision-comparison.mjs';
import {Structure,layoutFlow,normalizeLayoutOptions,documentMeta} from './layout.mjs';
import {writePdf,parseFontSet,profileKey,NOTDEF_WARNING} from './pdf.mjs';
import {DocxContext,docxPackage,docxMeta} from './docx.mjs';
import {htmlDocument} from './html.mjs';
import {ExportError,xmlEscape,utf8,prepareExport,exportManifest,fontEntries,requireTimestamp,legalEditionDigest} from './common.mjs';

const TEXT_KINDS=new Set(['section','exhibit','paragraph','definition','footnote']);
export const MARKERS=Object.freeze({insert:['{+','+}'],delete:['[-','-]']});
export const LEGEND='Legend: [-deleted text-] is struck through in red; {+inserted text+} is underlined in blue.';

function segmentsOf(diff) {
 return [['equal',diff.prefix],['delete',diff.removed],['insert',diff.inserted],['equal',diff.suffix]].filter(([,text])=>text).map(([op,text])=>({op,text}));
}

/**
 * Builds the redline model: entries in the after-edition's reading order, with
 * deleted blocks placed after their nearest surviving preceding sibling.
 */
export function redlineModel(beforeDocument,afterDocument) {
 let comparison;
 try{comparison=compareLegalRevisions(beforeDocument,afterDocument);}
 catch(error){throw new ExportError('INVALID_COMPARISON','Editions cannot be compared: '+error.message,{cause:error});}
 const before=validateLegalDocument(beforeDocument),after=validateLegalDocument(afterDocument);
 const changes=new Map(comparison.changes.map(c=>[c.id,c]));
 const index=doc=>{
  const nodes=new Map(),children=new Map([[doc.id,doc.content]]);
  (function walk(list,parentId){list.forEach((node,order)=>{nodes.set(node.id,{node,parentId,order});if(node.children){children.set(node.id,node.children);walk(node.children,node.id);}});})(doc.content,doc.id);
  return {nodes,children};
 };
 const old=index(before),next=index(after);
 const oldLabels=new Map(legalOutline(before).map(r=>[r.id,r.label])),newLabels=new Map(legalOutline(after).map(r=>[r.id,r.label]));
 const entries=[];

 function entryFor(node,depth,status) {
  if(!TEXT_KINDS.has(node.kind))return;
  const change=changes.get(node.id);
  let segments,kind=status;
  if(status==='deleted')segments=[{op:'delete',text:change.before.text}];
  else if(!change){kind='unchanged';segments=[{op:'equal',text:currentText(node)}];}
  else if(change.kind==='added'){kind='inserted';segments=[{op:'insert',text:change.after.text}];}
  else {
   segments=segmentsOf(change.text);
   kind=change.moved?'moved':change.before.text===change.after.text&&change.before.label===change.after.label&&!change.fields.length?'unchanged':'changed';
  }
  const labelIn=(labels,present)=>present?labels.get(node.id)??(node.kind==='exhibit'?'EXHIBIT':null):null;
  const label={before:labelIn(oldLabels,old.nodes.has(node.id)),after:labelIn(newLabels,status!=='deleted')};
  const note=kind==='moved'?'Moved'+(change.before.label&&change.before.label!==change.after.label?' from '+change.before.label:''):null;
  entries.push({id:node.id,kind:node.kind,depth,status:kind,label,note,segments});
 }
 // Same block text as compareLegalRevisions uses, for blocks the comparison reports as untouched.
 const afterLabels=legalReferenceLabels(after);
 const inlineText=run=>run.kind==='text'?run.text:run.kind==='reference'||run.kind==='footnote-reference'?legalReferenceText(run,afterLabels):run.label+' <'+run.targetUrl+'>';
 const currentText=node=>{const heading=node.title??node.term??'',body=(node.inlines??[]).map(inlineText).join('');return heading+(heading&&body?' \u2014 ':'')+body;};

 function walkDeleted(nodeId,depth) {
  const {node}=old.nodes.get(nodeId);
  entryFor(node,depth,'deleted');
  for(const child of node.children??[])walkDeleted(child.id,depth+1);
 }
 function walk(parentId,depth) {
  const current=(next.children.get(parentId)??[]).map(n=>n.id);
  const removed=(old.children.get(parentId)??[]).map(n=>n.id).filter(id=>!next.nodes.has(id));
  const merged=[...current];
  for(const id of removed) {
   const siblings=old.children.get(parentId).map(n=>n.id);
   let at=0;
   for(let i=siblings.indexOf(id)-1;i>=0;i--){const pos=merged.indexOf(siblings[i]);if(pos>=0){at=pos+1;break;}}
   merged.splice(at,0,id);
  }
  for(const id of merged) {
   if(next.nodes.has(id)&&next.nodes.get(id).parentId===parentId){const {node}=next.nodes.get(id);entryFor(node,depth,'present');if(node.children)walk(id,node.kind==='section'||node.kind==='exhibit'?depth+1:depth);}
   else walkDeleted(id,depth);
  }
 }
 walk(after.id,0);
 return Object.freeze({documentId:after.id,tenantId:after.tenantId,beforeRevision:before.revision,afterRevision:after.revision,metadata:comparison.metadata,unchanged:comparison.unchanged,entries});
}

/** Plain-text rendering of the model with explicit markers (also the PDF's text content). */
export function redlineText(model) {
 return model.entries.map(entry=>markedLabel(entry)+entry.segments.map(s=>s.op==='equal'?s.text:MARKERS[s.op][0]+s.text+MARKERS[s.op][1]).join('')+(entry.note?' ('+entry.note+')':'')).join('\n');
}
function markedLabel(entry) {
 const {before,after}=entry.label;
 if(before===after)return before?before+' ':'';
 return (before?MARKERS.delete[0]+before+MARKERS.delete[1]:'')+(after?MARKERS.insert[0]+after+MARKERS.insert[1]:'')+' ';
}

const RED=[0.7,0,0],BLUE=[0,0,0.7];
function flowSpans(entry,span) {
 const spans=[];
 const add=(op,text,style)=>{
  if(op==='equal'){spans.push(span(text,{style}));return;}
  const props=op==='delete'?{strike:true,color:RED,style}:{underline:true,color:BLUE,style};
  spans.push(span(MARKERS[op][0]+text+MARKERS[op][1],props));
 };
 const style=entry.kind==='section'||entry.kind==='exhibit'?'bold':'regular';
 const {before,after}=entry.label;
 if(before===after){if(before)add('equal',before+' ',style);}
 else{if(before)add('delete',before,style);if(after)add('insert',after,style);add('equal',' ',style);}
 for(const s of entry.segments)add(s.op,s.text,style);
 if(entry.note)spans.push(span(' ('+entry.note+')',{style:'italic'}));
 return spans;
}

const flowSpan=(text,props={})=>({text,style:'regular',underline:false,strike:false,color:[0,0,0],link:null,linkKey:null,sup:false,footnote:null,struct:null,...props});

async function redlineInputs({before,after,editionDigest,version,options}) {
 const doc=await prepareExport({document:after,editionDigest,version,validate:validateLegalDocument});
 const profile=normalizeLayoutOptions(options);requireTimestamp(profile.generatedAt);
 const model=redlineModel(before,doc);
 const beforeDigest=await legalEditionDigest(validateLegalDocument(before));
 const extra={redline:{beforeEditionDigest:beforeDigest,beforeRevision:model.beforeRevision,afterRevision:model.afterRevision}};
 return {doc,profile,model,extra};
}

/** Redline PDF: deleted text struck in red, inserted underlined in blue, both bracketed by text markers. */
export async function renderRedlinePdf({before,after,fonts,editionDigest,version,options={}}) {
 const {doc,profile,model,extra}=await redlineInputs({before,after,editionDigest,version,options});
 const parsed=parseFontSet(fonts);
 const structure=new Structure(),root=structure.add('Document',null),part=structure.add('Part',root,{title:'Redline'});
 const fontSize=profile.fontSize,leading=Math.round(fontSize*1.3*100)/100;
 const base={type:'text',label:null,size:fontSize,leading,spaceBefore:0,spaceAfter:fontSize*0.5,keepWithNext:false,heading:false,pageBreakBefore:false,destIds:[]};
 const blocks=[{...base,struct:structure.add('P',part),spans:[flowSpan(LEGEND,{style:'italic'})],indent:0}];
 const outline=[];
 for(const entry of model.entries) {
  const heading=entry.kind==='section'||entry.kind==='exhibit';
  const struct=structure.add(heading?'H'+Math.min(entry.depth+1,6):'P',part);
  blocks.push({...base,struct,spans:flowSpans(entry,flowSpan),indent:Math.min(entry.depth,5)*18,heading,keepWithNext:heading,destIds:[entry.id],spaceBefore:heading?fontSize*0.6:0});
  if(heading)outline.push({nodeId:entry.id,title:[entry.label.after??entry.label.before,entry.segments.map(s=>s.text).join('')].filter(Boolean).join(' ').slice(0,200),level:Math.min(entry.depth,5)});
 }
 const meta={...documentMeta(doc,editionDigest,version),title:doc.metadata.title+' (redline)'};
 const layout=layoutFlow({flow:{blocks,footnotes:new Map(),outline},structure,documentStruct:root,fonts:parsed,options:profile,meta});
 const result=await writePdf({layout,fonts:parsed,meta:{title:meta.title,lang:doc.metadata.locale,editionDigest,generatedAt:profile.generatedAt,version,documentId:doc.id,profileKey:profileKey(profile)+':redline'}});
 const warnings=[...layout.warnings,...(result.notdef?[NOTDEF_WARNING]:[])];
 const manifest=await exportManifest({doc,format:'pdf',editionDigest,version,profile,fonts:await fontEntries(parsed,result.usedStyles),bytes:result.bytes,pageCount:layout.pageCount,warnings,extra});
 return {bytes:result.bytes,manifest,model};
}

/** Redline DOCX using Word tracked changes (w:ins / w:del). */
export async function renderRedlineDocx({before,after,editionDigest,version,options={}}) {
 const {doc,profile,model,extra}=await redlineInputs({before,after,editionDigest,version,options});
 const ctx=new DocxContext();let revision=0;
 const tracked=(op,runXml)=>op==='equal'?runXml:'<w:'+(op==='insert'?'ins':'del')+' w:id="'+(++revision)+'" w:author="Quill redline" w:date="'+profile.generatedAt+'">'+runXml+'</w:'+(op==='insert'?'ins':'del')+'>';
 let body=ctx.paragraph(ctx.run('Redline from revision '+model.beforeRevision+' to revision '+model.afterRevision+'. Deletions and insertions are recorded as tracked changes.',{italic:true}));
 for(const entry of model.entries) {
  const heading=entry.kind==='section'||entry.kind==='exhibit';
  let content='';
  const {before:lb,after:la}=entry.label;
  if(lb===la){if(lb)content+=ctx.run(lb+' ');}
  else{if(lb)content+=tracked('delete',ctx.run(lb,{del:true}));if(la)content+=tracked('insert',ctx.run(la));content+=ctx.run(' ');}
  for(const s of entry.segments)content+=tracked(s.op,ctx.run(s.text,{del:s.op==='delete'}));
  if(entry.note)content+=ctx.run(' ('+entry.note+')',{italic:true});
  body+=ctx.paragraph(content,{style:heading?'Heading'+Math.min(entry.depth+1,6):undefined,indent:Math.min(entry.depth,5)*18,keepNext:heading});
 }
 const bytes=await docxPackage({ctx,bodyXml:body,meta:{...docxMeta(doc,editionDigest,version),title:doc.metadata.title+' (redline)'},profile});
 const manifest=await exportManifest({doc,format:'docx',editionDigest,version,profile,bytes,warnings:ctx.warnings,extra});
 return {bytes,manifest,model};
}

/** Redline HTML with <del>/<ins> plus visible markers. */
export async function renderRedlineHtml({before,after,editionDigest,version,options={}}) {
 const {doc,profile,model,extra}=await redlineInputs({before,after,editionDigest,version,options});
 const warnings=new Set(),e=value=>xmlEscape(value,warnings);
 const mark=(op,text)=>op==='equal'?e(text):'<'+(op==='insert'?'ins':'del')+'>'+e(MARKERS[op][0]+text+MARKERS[op][1])+'</'+(op==='insert'?'ins':'del')+'>';
 let body='<main><p><em>'+e(LEGEND)+'</em></p>';
 for(const entry of model.entries) {
  const heading=entry.kind==='section'||entry.kind==='exhibit';
  const {before:lb,after:la}=entry.label;
  const label=lb===la?(lb?e(lb+' '):''):(lb?mark('delete',lb):'')+(la?mark('insert',la):'')+' ';
  const content=label+entry.segments.map(s=>mark(s.op,s.text)).join('')+(entry.note?' <em>('+e(entry.note)+')</em>':'');
  const tag=heading?'h'+Math.min(entry.depth+1,6):'p';
  body+='<'+tag+' class="level-'+Math.min(entry.depth,5)+'" data-status="'+entry.status+'">'+content+'</'+tag+'>';
 }
 body+='</main>';
 const html=htmlDocument({lang:doc.metadata.locale,title:doc.metadata.title+' (redline)',editionDigest,profile,body,warnings});
 const bytes=utf8(html);
 const manifest=await exportManifest({doc,format:'html',editionDigest,version,profile,bytes,warnings,extra});
 return {bytes,manifest,model};
}
