import {canonicalize,identifier,invariant} from './integrity-values.mjs';
import {legalLabel,NUMBERING_PROFILES} from './numbering.mjs';

export const LEGAL_SCHEMA_VERSION=2;
export const LEGAL_LIMITS=Object.freeze({nodes:10000,depth:16,bytes:3000000,text:1000000});
const SUPPORTED_SCHEMA_VERSIONS=new Set([1,2]);
const INLINE_MARKS=new Set(['bold','italic','underline','strike']);
const CHILDREN={
 section:new Set(['section','paragraph','list','table','definition','exhibit']),
 list:new Set(['list-item']),
 'list-item':new Set(['paragraph','list','table']),
 table:new Set(['table-row']),
 'table-row':new Set(['table-cell']),
 'table-cell':new Set(['paragraph','list']),
 exhibit:new Set(['section','paragraph','list','table','definition'])
};
const ROOT_KINDS=new Set(['section','paragraph','list','table','definition','exhibit','footnote']);
function safeRecord(obj) {
 invariant(obj&&typeof obj==='object'&&!Array.isArray(obj)&&(Object.getPrototypeOf(obj)===Object.prototype||Object.getPrototypeOf(obj)===null),'Expected a plain record');
 invariant(Object.getOwnPropertySymbols(obj).length===0,'Symbol keys are forbidden');
 for(const key of Object.getOwnPropertyNames(obj)) {
  const descriptor=Object.getOwnPropertyDescriptor(obj,key);
  invariant(descriptor.enumerable&&Object.hasOwn(descriptor,'value'),'Unknown or unsafe field: '+key);
 }
}
function fields(obj,allowed,required=[]) {
 safeRecord(obj);
 for(const key of Object.keys(obj))invariant(allowed.includes(key),'Unknown field: '+key);
 for(const key of required)invariant(Object.hasOwn(obj,key),'Missing field: '+key);
}
function text(value,max=LEGAL_LIMITS.text) {
 invariant(typeof value==='string'&&value.length<=max,'Invalid or oversized legal text');
 canonicalize(value);return value;
}
function denseArray(value,max) {
 invariant(Array.isArray(value)&&value.length<=max&&Object.keys(value).length===value.length&&Object.keys(value).every((key,i)=>key===String(i)),'Invalid bounded dense array');
 invariant(Object.getOwnPropertySymbols(value).length===0&&Object.keys(value).every(key=>Object.hasOwn(Object.getOwnPropertyDescriptor(value,key),'value')),'Unsafe array entries');
}
function freeze(value) {if(value&&typeof value==='object'){Object.freeze(value);for(const child of Object.values(value))freeze(child);}return value;}
export function normalizeExternalUrl(value) {
 text(value,2048);let url;
 try{url=new URL(value);}catch{invariant(false,'Invalid external URL');}
 invariant(url.protocol==='https:'&&url.hostname&&url.username===''&&url.password==='','External URLs must use HTTPS without user information');
 return url.href;
}
function validIsoDate(value) {
 invariant(/^\d{4}-\d{2}-\d{2}$/.test(value),'Citation dates must use YYYY-MM-DD');
 const date=new Date(value+'T00:00:00Z');invariant(Number.isFinite(date.valueOf())&&date.toISOString().slice(0,10)===value,'Invalid citation date');
}
function validateCitationMetadata(value) {
 fields(value,['publisher','publishedOn','pinpoint','accessedOn']);
 invariant(Object.keys(value).length>0,'Empty citation metadata');
 if(value.publisher!==undefined){text(value.publisher,1000);invariant(value.publisher.length>0&&value.publisher.trim()===value.publisher,'Citation publisher is empty or non-canonical');}
 if(value.pinpoint!==undefined){text(value.pinpoint,200);invariant(value.pinpoint.length>0&&value.pinpoint.trim()===value.pinpoint,'Citation pinpoint is empty or non-canonical');}
 if(value.publishedOn!==undefined){text(value.publishedOn,10);validIsoDate(value.publishedOn);}
 if(value.accessedOn!==undefined){text(value.accessedOn,10);validIsoDate(value.accessedOn);}
}
export function normalizeCitationMetadata(value) {
 if(value===undefined||value===null)return null;
 fields(value,['publisher','publishedOn','pinpoint','accessedOn']);const next={};
 for(const key of ['publisher','publishedOn','pinpoint','accessedOn'])if(Object.hasOwn(value,key)){invariant(typeof value[key]==='string','Citation metadata values must be strings');if(value[key].trim())next[key]=value[key].trim();}
 validateCitationMetadata(next);return freeze(next);
}
function validateNumberingRules(rules) {
 denseArray(rules,1000);
 const owners=new Set();
 for(const rule of rules) {
  fields(rule,['parentId','startAt','reserved'],['parentId']);
  identifier(rule.parentId);
  invariant(!owners.has(rule.parentId),'Duplicate numbering parent');owners.add(rule.parentId);
  if(rule.startAt!==undefined)invariant(Number.isSafeInteger(rule.startAt)&&rule.startAt>=1&&rule.startAt<=1000000,'Invalid numbering start');
  if(rule.reserved!==undefined) {
   denseArray(rule.reserved,2000);
   let previous=0;
   for(const ordinal of rule.reserved) {
    invariant(Number.isSafeInteger(ordinal)&&ordinal>previous&&ordinal<=1000000,'Reserved numbers must be strictly increasing positive integers');
    previous=ordinal;
   }
  }
 }
}
function validateInlines(inlines,refs,schemaVersion) {
 denseArray(inlines,10000);
 for(const run of inlines) {
  safeRecord(run);
  const allowed=schemaVersion>=2?['text','reference','footnote-reference','link','citation']:['text','reference','footnote-reference'];
  invariant(run&&allowed.includes(run.kind),'Unknown inline kind');
  if(run.kind==='text') {
   fields(run,['kind','text','marks'],['kind','text']);text(run.text);
   if(run.marks!==undefined){denseArray(run.marks,4);invariant(run.marks.every(m=>INLINE_MARKS.has(m))&&new Set(run.marks).size===run.marks.length,'Invalid text marks');}
  } else if(['reference','footnote-reference'].includes(run.kind)) {
   fields(run,['kind','targetId','label'],['kind','targetId']);identifier(run.targetId);if(run.label!==undefined)text(run.label,1000);refs.push(run);
  } else {
   fields(run,['kind','targetUrl','label','title','citationMetadata'],['kind','targetUrl','label']);
   invariant(normalizeExternalUrl(run.targetUrl)===run.targetUrl,'External URLs must use canonical HTTPS form');text(run.label,1000);invariant(run.label.length>0,'External inline label is required');if(run.title!==undefined)text(run.title,1000);
   if(run.citationMetadata!==undefined){invariant(run.kind==='citation','Only citations may carry citation metadata');validateCitationMetadata(run.citationMetadata);}
  }
 }
}

/** Validate structure independently from presentation and return frozen, detached data. */
export function validateLegalDocument(input,{forFinalization=false}={}) {
 fields(input,['schemaVersion','id','tenantId','mode','lifecycle','revision','metadata','content','provenance','schemaMigration'],['schemaVersion','id','tenantId','mode','lifecycle','revision','metadata','content']);
 invariant(SUPPORTED_SCHEMA_VERSIONS.has(input.schemaVersion),'Unsupported legal schema version');identifier(input.id);identifier(input.tenantId);
 invariant(['collaboration','public-input'].includes(input.mode),'Invalid legal document mode');
 invariant(['draft','published','adopted','signed'].includes(input.lifecycle),'Invalid document lifecycle');
 invariant(Number.isSafeInteger(input.revision)&&input.revision>=0,'Invalid legal revision');
 fields(input.metadata,['title','locale','numberingProfile','numberingRules'],['title','locale','numberingProfile']);text(input.metadata.title,1000);
 invariant(typeof input.metadata.locale==='string'&&/^[a-z]{2,3}(?:-[A-Z]{2})?$/.test(input.metadata.locale),'Invalid document locale');
 const hierarchy=NUMBERING_PROFILES[input.metadata.numberingProfile];invariant(hierarchy,'Unsupported numbering profile');
 if(input.metadata.numberingRules!==undefined)validateNumberingRules(input.metadata.numberingRules);
 if(input.provenance!==undefined){fields(input.provenance,['fromSchema','sourceDigest'],['fromSchema','sourceDigest']);invariant(input.provenance.fromSchema==='foundation-blocks-v0'&&/^[a-f0-9]{64}$/.test(input.provenance.sourceDigest),'Invalid migration provenance');}
 if(input.schemaMigration!==undefined){fields(input.schemaMigration,['fromVersion','toVersion','sourceDigest'],['fromVersion','toVersion','sourceDigest']);invariant(input.schemaVersion===2&&input.schemaMigration.fromVersion===1&&input.schemaMigration.toVersion===2&&/^[a-f0-9]{64}$/.test(input.schemaMigration.sourceDigest),'Invalid schema migration evidence');}
 const ids=new Map([[input.id,{kind:'document'}]]),refs=[];
 let count=0;
 function visit(node,depth,sectionDepth=0) {
  invariant(depth<=LEGAL_LIMITS.depth&&++count<=LEGAL_LIMITS.nodes,'Legal document structural limit exceeded');
  safeRecord(node);
  if(node.kind==='section'){sectionDepth++;invariant(sectionDepth<=hierarchy.length,'Legal numbering depth limit exceeded');}
  invariant(node&&typeof node.kind==='string','Missing legal node kind');
  identifier(node.id);invariant(!ids.has(node.id),'Duplicate legal node ID');ids.set(node.id,node);
  if(['paragraph','footnote','definition'].includes(node.kind)) {
   const allowed=['kind','id','inlines'];if(node.kind==='definition')allowed.push('term');
   fields(node,allowed,['kind','id','inlines',...(node.kind==='definition'?['term']:[])]);
   if(node.kind==='definition')text(node.term,1000);validateInlines(node.inlines,refs,input.schemaVersion);
  } else {
   invariant(Object.hasOwn(CHILDREN,node.kind),'Unsupported legal node kind');
   const allowed=['kind','id','children'];if(node.kind==='section'||node.kind==='exhibit')allowed.push('title');if(node.kind==='list')allowed.push('style');
   fields(node,allowed,['kind','id','children',...(['section','exhibit'].includes(node.kind)?['title']:[]),...(node.kind==='list'?['style']:[])]);
   if(node.title!==undefined)text(node.title,1000);
   if(node.kind==='list')invariant(['decimal','lower-alpha','upper-alpha','lower-roman','upper-roman','bullet'].includes(node.style),'Unknown list style');
   denseArray(node.children,LEGAL_LIMITS.nodes);invariant(node.children.length>0,'Empty structural container');
   for(const child of node.children){safeRecord(child);invariant(CHILDREN[node.kind].has(child.kind),'Invalid child of '+node.kind);visit(child,depth+1,sectionDepth);}
   if(node.kind==='table'){const widths=node.children.map(row=>row.children.length);invariant(widths.every(n=>n===widths[0]),'Ragged legal table');}
  }
 }
 denseArray(input.content,LEGAL_LIMITS.nodes);invariant(input.content.length>0,'Empty legal document');
 for(const node of input.content){safeRecord(node);invariant(ROOT_KINDS.has(node.kind),'Invalid top-level legal node');visit(node,1);}
 for(const rule of input.metadata.numberingRules??[]){const parent=ids.get(rule.parentId);invariant(parent&&['document','section','exhibit'].includes(parent.kind),'Numbering parent must be a document, section or exhibit');}
 for(const ref of refs){const target=ids.get(ref.targetId);if(forFinalization||input.lifecycle!=='draft')invariant(target,'Unresolved cross-reference');if(target&&ref.kind==='footnote-reference')invariant(target.kind==='footnote','Footnote reference points to a non-footnote');}
 invariant(new TextEncoder().encode(canonicalize(input)).byteLength<=LEGAL_LIMITS.bytes,'Legal document byte limit exceeded');
 return freeze(structuredClone(input));
}


/** Deterministic diagnostics and backlinks. Analysis never edits or adopts a document. */
export function legalReferenceAnalysis(document) {
 const doc=validateLegalDocument(document),nodes=new Map([[doc.id,{kind:'document'}]]);
 const refs=[],definitions=[],issues=[];
 function visit(node) {
  nodes.set(node.id,node);
  if(node.kind==='definition')definitions.push(node);
  for(const run of node.inlines??[])if(['reference','footnote-reference'].includes(run.kind))
   refs.push({sourceId:node.id,targetId:run.targetId,kind:run.kind});
  for(const child of node.children??[])visit(child);
 }
 doc.content.forEach(visit);
 for(const ref of refs) {
  const target=nodes.get(ref.targetId);
  if(!target)issues.push({code:'UNRESOLVED_REFERENCE',sourceId:ref.sourceId,targetId:ref.targetId});
  else if(ref.kind==='footnote-reference'&&target.kind!=='footnote')
   issues.push({code:'INVALID_FOOTNOTE_TARGET',sourceId:ref.sourceId,targetId:ref.targetId});
 }
 const terms=new Map();
 for(const def of definitions) {
  const term=def.term.trim();
  if(!term) {issues.push({code:'EMPTY_DEFINED_TERM',sourceId:def.id});continue;}
  const key=term.normalize('NFC').toLocaleLowerCase(doc.metadata.locale);
  const previous=terms.get(key);
  if(previous)issues.push({code:'AMBIGUOUS_DEFINED_TERM',sourceId:def.id,otherId:previous,term});
  else terms.set(key,def.id);
 }
 const graph=new Map(definitions.map(def=>[def.id,[]]));
 for(const ref of refs)if(graph.has(ref.sourceId)&&graph.has(ref.targetId))
  graph.get(ref.sourceId).push(ref.targetId);
 // Iterative depth-first search avoids overflowing the stack on long legal references.
 const colors=new Map(),active=[],positions=new Map(),cyclic=new Set();
 for(const def of definitions) {
  if(colors.has(def.id))continue;
  const stack=[{id:def.id,next:0}];
  while(stack.length) {
   const top=stack.at(-1);
   if(!colors.has(top.id)){colors.set(top.id,1);positions.set(top.id,active.length);active.push(top.id);}
   const neighbors=graph.get(top.id);
   if(top.next<neighbors.length) {
    const target=neighbors[top.next++];
    if(!colors.has(target))stack.push({id:target,next:0});
    else if(colors.get(target)===1)for(let i=positions.get(target);i<active.length;i++)cyclic.add(active[i]);
   } else {
    colors.set(top.id,2);positions.delete(top.id);active.pop();stack.pop();
   }
  }
 }
 for(const def of definitions)if(cyclic.has(def.id))
  issues.push({code:'CYCLIC_DEFINITION',sourceId:def.id});
 const backlinks=new Map();
 for(const ref of refs)backlinks.set(ref.targetId,[...(backlinks.get(ref.targetId)??[]),ref]);
 return {issues,backlinks,definitionCount:definitions.length,referenceCount:refs.length};
}
export function documentIssues(document) {
 return legalReferenceAnalysis(document).issues;
}
export function previewLegalNodeMove(document,nodeId,parentId,index) {
 const doc=validateLegalDocument(document);
 const before=legalOutline(doc),afterDoc=moveLegalNode(doc,nodeId,parentId,index),after=legalOutline(afterDoc);
 const prev=new Map(before.map(row=>[row.id,row.label]));
 const renamed=after.filter(row=>prev.get(row.id)!==row.label).map(row=>({
  id:row.id,from:prev.get(row.id)??null,to:row.label
 }));
 const changed=new Map(renamed.map(x=>[x.id,x]));
 const backlinks=legalReferenceAnalysis(afterDoc).backlinks;
 const affectedReferences=[];
 for(const [id,labels] of changed)for(const ref of backlinks.get(id)??[])
  affectedReferences.push({sourceId:ref.sourceId,targetId:id,from:labels.from,to:labels.to});
 return {renamed,affectedReferences,referenceChanges:referenceLabelChanges(doc,afterDoc),issues:documentIssues(afterDoc),preview:after};
}
export function createLegalDocument({id,tenantId,title,locale='en-US',mode='collaboration'}) {
 return validateLegalDocument({schemaVersion:LEGAL_SCHEMA_VERSION,id,tenantId,mode,lifecycle:'draft',revision:0,metadata:{title,locale,numberingProfile:'us-federal-v1'},content:[{kind:'paragraph',id:id+':p1',inlines:[{kind:'text',text:''}]}]});
}

function requireDraft(document) {invariant(document.lifecycle==='draft'&&document.mode==='collaboration','Only a collaboration draft may be edited directly');}
export function moveLegalNode(document,nodeId,newParentId,index) {
 const doc=validateLegalDocument(document);requireDraft(doc);identifier(nodeId);identifier(newParentId);
 invariant(Number.isSafeInteger(index)&&index>=0,'Invalid move position');
 const next=structuredClone(doc),parents=new Map(),nodes=new Map([[next.id,next]]);
 function scan(children,parent){for(const node of children){nodes.set(node.id,node);parents.set(node.id,parent);scan(node.children??[],node);}}
 scan(next.content,next);const node=nodes.get(nodeId),target=nodes.get(newParentId);
 invariant(node&&node!==next&&target,'Unknown move source or destination');
 for(let p=target;p;p=parents.get(p.id))invariant(p!==node,'Cannot move a node into its descendant');
 const parent=parents.get(nodeId),oldChildren=parent===next?parent.content:parent.children;
 const children=target===next?target.content:target.children;
 invariant(Array.isArray(children),'Move destination cannot contain blocks');
 oldChildren.splice(oldChildren.indexOf(node),1);invariant(index<=children.length,'Move position exceeds destination');children.splice(index,0,node);next.revision++;
 return validateLegalDocument(next);
}
export function finalizeLegalDocument(document,lifecycle='adopted') {
 const doc=validateLegalDocument(document,{forFinalization:true});requireDraft(doc);
 invariant(documentIssues(doc).length===0,'Resolve ambiguous or cyclic definitions before finalization');invariant(['published','adopted'].includes(lifecycle),'Execution signing requires the signing protocol');
 return validateLegalDocument({...structuredClone(doc),revision:doc.revision+1,lifecycle},{forFinalization:true});
}
export function publicInputEdition(document) {
 const doc=validateLegalDocument(document,{forFinalization:true});invariant(documentIssues(doc).length===0,'Resolve legal reference issues before publishing');invariant(doc.lifecycle!=='signed','Signed editions require an explicit publication/export protocol');
 return validateLegalDocument({...structuredClone(doc),mode:'public-input',lifecycle:'published',revision:doc.revision+1},{forFinalization:true});
}
export function legalOutline(document) {
 const doc=validateLegalDocument(document),result=[];
 const profile=NUMBERING_PROFILES[doc.metadata.numberingProfile];
 const rules=new Map((doc.metadata.numberingRules??[]).map(rule=>[rule.parentId,rule]));
 function walk(children,depth,parentId) {
  const rule=rules.get(parentId);
  let ordinal=rule?.startAt??1;
  const reserved=new Set(rule?.reserved??[]);
  for(const node of children) {
   if(node.kind==='section') {
    while(reserved.has(ordinal))ordinal++;
    invariant(depth<profile.length,'Numbering hierarchy exhausted');
    result.push({id:node.id,title:node.title,label:legalLabel(ordinal,depth,profile),depth});
    ordinal++;
    walk(node.children,depth+1,node.id);
   } else if(node.children)walk(node.children,depth,node.id);
  }
 }
 walk(doc.content,0,doc.id);return result;
}

/** Preview only: never alters document source, ballots, or adopted editions. */
export function previewLegalNumbering(document,numberingRules,{numberingProfile}={}) {
 const doc=validateLegalDocument(document);
 const before=legalOutline(doc);
 const candidate=validateLegalDocument({...structuredClone(doc),metadata:{...structuredClone(doc.metadata),numberingRules,...(numberingProfile===undefined?{}:{numberingProfile})}});
 const after=legalOutline(candidate);
 const original=new Map(before.map(item=>[item.id,item]));
 const changed=after.filter(item=>original.get(item.id)?.label!==item.label).map(item=>({
  id:item.id,from:original.get(item.id)?.label??null,to:item.label
 }));
 const renamed=new Map(changed.map(item=>[item.id,item]));
 const affectedReferences=[];
 function scan(node) {
  for(const run of node.inlines??[])if(['reference','footnote-reference'].includes(run.kind)&&renamed.has(run.targetId)) {
   const label=renamed.get(run.targetId);
   affectedReferences.push({sourceId:node.id,targetId:run.targetId,from:label.from,to:label.to});
  }
  for(const child of node.children??[])scan(child);
 }
 doc.content.forEach(scan);
 return {before,after,changed,affectedReferences,referenceChanges:referenceLabelChanges(doc,candidate)};
}

/** Replace draft numbering preferences without modifying any semantic IDs or text. */
export function applyLegalNumberingRules(document,numberingRules,{numberingProfile}={}) {
 const doc=validateLegalDocument(document);requireDraft(doc);
 const next={...structuredClone(doc),revision:doc.revision+1,metadata:{...structuredClone(doc.metadata),numberingRules,...(numberingProfile===undefined?{}:{numberingProfile})}};
 const result=validateLegalDocument(next);
 legalOutline(result); // Reject styles, ordinals and reservations that cannot render.
 return result;
}

function sectionLocation(document,sectionId) {
 identifier(sectionId);
 const nodes=new Map([[document.id,document]]),parents=new Map();
 function scan(children,parent) {
  for(const node of children){nodes.set(node.id,node);parents.set(node.id,parent);scan(node.children??[],node);}
 }
 scan(document.content,document);
 const section=nodes.get(sectionId);
 invariant(section&&section.kind==='section','Unknown section');
 const parent=parents.get(sectionId);
 const siblings=parent===document?document.content:parent.children;
 return {section,parent,siblings,index:siblings.indexOf(section),parents};
}
export function indentLegalSection(document,sectionId) {
 const doc=validateLegalDocument(document);requireDraft(doc);
 const location=sectionLocation(doc,sectionId);
 const previous=location.siblings.slice(0,location.index).reverse().find(node=>node.kind==='section');
 invariant(previous,'Indent requires a preceding sibling section');
 return moveLegalNode(doc,sectionId,previous.id,previous.children.length);
}
export function outdentLegalSection(document,sectionId) {
 const doc=validateLegalDocument(document);requireDraft(doc);
 const location=sectionLocation(doc,sectionId);
 invariant(location.parent.kind==='section','Only a nested section can be outdented');
 const grandparent=location.parents.get(location.parent.id);
 const siblings=grandparent===doc?doc.content:grandparent.children;
 return moveLegalNode(doc,sectionId,grandparent.id,siblings.indexOf(location.parent)+1);
}
/** Derived labels only; never writes presentation text into stable-ID references. */
export function legalReferenceLabels(document) {
 const doc=validateLegalDocument(document),numbers=new Map(legalOutline(doc).map(row=>[row.id,row.label]));
 const labels=new Map([[doc.id,Object.freeze({kind:'document',text:doc.metadata.title})]]);let footnote=0;
 function pathText(parts,exhibits){
  const path=parts.map((label,index)=>index<parts.length-1?label.replace(/\.$/,''):label).join('');
  let context=exhibits.join(' — ');if(!context)return path;
  const budget=1000-path.length-3;
  if(context.length>budget){let end=budget-1;const unit=context.charCodeAt(end-1);if(unit>=0xD800&&unit<=0xDBFF)end--;context=context.slice(0,end)+'…';}
  return context+' — '+path;
 }
 function walk(nodes,ancestors=[],exhibits=[]){for(const node of nodes){
  let text=null,ordinal=null,next=ancestors,contexts=exhibits;
  if(node.kind==='section'){next=[...ancestors,numbers.get(node.id)];text=pathText(next,exhibits);}
  else if(node.kind==='definition')text=node.term.trim()?node.term:null;
  else if(node.kind==='exhibit'){text=node.title;contexts=[...exhibits,node.title];}
  else if(node.kind==='footnote'){ordinal=String(++footnote);text='Footnote '+ordinal;}
  labels.set(node.id,Object.freeze({kind:node.kind,text,ordinal}));
  if(node.children)walk(node.children,next,contexts);
 }}
 walk(doc.content);return labels;
}
/** Complete derived reference changes, including changed parent paths. */
function referenceLabelChanges(before,after){
 const previous=legalReferenceLabels(before),next=legalReferenceLabels(after),result=[];
 for(const [id,refs]of legalReferenceAnalysis(after).backlinks)for(const ref of refs){
  const from=legalReferenceText({kind:ref.kind,targetId:id},previous),to=legalReferenceText({kind:ref.kind,targetId:id},next);
  if(from!==to)result.push({sourceId:ref.sourceId,targetId:id,from,to});
 }
 return result;
}
export function legalReferenceText(run,labels) {
 if(run.label!==undefined&&run.label!==null)return run.label;
 const target=labels.get(run.targetId);
 return (run.kind==='footnote-reference'?target?.kind==='footnote'?target.ordinal:null:target?.text)??'['+run.targetId+']';
}

export function legalPlainText(document) {
 const doc=validateLegalDocument(document),labels=new Map(legalOutline(doc).map(x=>[x.id,x.label])),referenceLabels=legalReferenceLabels(doc);
 const inline=r=>{if(r.kind==='text')return r.text;if(!['link','citation'].includes(r.kind))return legalReferenceText(r,referenceLabels);const metadata=r.citationMetadata?['publisher','publishedOn','pinpoint','accessedOn'].filter(key=>r.citationMetadata[key]!==undefined).map(key=>r.citationMetadata[key]).join('; '):'';return r.label+' <'+r.targetUrl+'>'+(metadata?' ['+metadata+']':'');};
 function render(node){if(node.inlines)return (node.term?node.term+'—':'')+node.inlines.map(inline).join('');return (node.title?(labels.get(node.id)??'EXHIBIT')+' '+node.title+'\n':'')+node.children.map(render).join(node.kind==='table-row'?'\t':'\n');}
 return doc.content.map(render).join('\n\n');
}
