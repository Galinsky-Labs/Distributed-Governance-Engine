/**
 * Redaction produces a NEW derived legal document whose data no longer contains
 * the removed text (each removed passage becomes the fixed token "[REDACTED]"),
 * plus provenance binding it to the source edition. Exports of the derived
 * document therefore cannot leak the text: it is gone before rendering.
 */
import {validateLegalDocument,legalPlainText} from '../legal-structure.mjs';
import {ExportError,legalEditionDigest} from './common.mjs';

export const REDACTION_TOKEN='[REDACTED]';

function bad(code,message){throw new ExportError(code,message);}

/** Removes `[start, end)` (UTF-16 offsets over the node's text runs) and inserts one token. */
function redactRange(inlines,start,end) {
 const out=[];let at=0,inserted=false;
 for(const run of inlines) {
  if(run.kind!=='text'){out.push(run);continue;}
  const from=at,to=at+run.text.length;at=to;
  if(end<=from||start>=to){out.push(run);continue;}
  const keepBefore=run.text.slice(0,Math.max(0,start-from)),keepAfter=run.text.slice(Math.min(run.text.length,end-from));
  const text=keepBefore+(inserted?'':REDACTION_TOKEN)+keepAfter;inserted=true;
  if(text)out.push({...run,text});
 }
 return out;
}

function redactWhole(node) {
 if(node.inlines)node.inlines=[{kind:'text',text:REDACTION_TOKEN}];
 if(node.title!==undefined)node.title=REDACTION_TOKEN;
 if(node.term!==undefined)node.term=REDACTION_TOKEN;
 for(const child of node.children??[])redactWhole(child);
}

/**
 * redactDocument(document, {nodeIds, ranges:[{nodeId,start,end}], reason})
 * → {document, provenance:{derivedFromDigest, derivedDigest, redactions:[{nodeId,reason}], statement, warnings}}.
 * The input is never mutated.
 */
export async function redactDocument(document,{nodeIds=[],ranges=[],reason}={}) {
 let source;
 try{source=validateLegalDocument(document);}catch(error){throw new ExportError('INVALID_DOCUMENT','The document failed legal schema validation: '+error.message,{cause:error});}
 if(typeof reason!=='string'||!reason.trim()||reason.length>500)bad('INVALID_REDACTION','A redaction reason of 1-500 characters is required');
 if(!Array.isArray(nodeIds)||!Array.isArray(ranges)||nodeIds.length+ranges.length===0||nodeIds.length+ranges.length>10000)bad('INVALID_REDACTION','Provide 1-10000 node IDs or ranges to redact');
 const draft=structuredClone(source),nodes=new Map();
 (function index(list){for(const node of list){nodes.set(node.id,node);if(node.children)index(node.children);}})(draft.content);
 const removed=[];
 const textOf=node=>(node.inlines??[]).filter(r=>r.kind==='text').map(r=>r.text).join('');
 const collect=node=>{for(const run of node.inlines??[])removed.push(run.text??run.label??'');if(node.title)removed.push(node.title);if(node.term)removed.push(node.term);for(const child of node.children??[])collect(child);};
 const redactions=[];
 for(const id of new Set(nodeIds)) {
  const node=nodes.get(id);if(!node)bad('REDACTION_TARGET_UNKNOWN','Redaction target is not a node of this document');
  collect(node);redactWhole(node);redactions.push({nodeId:id,reason});
 }
 const byNode=new Map();
 for(const range of ranges) {
  if(!range||typeof range!=='object')bad('INVALID_REDACTION','Invalid redaction range');
  const node=nodes.get(range.nodeId);if(!node||!node.inlines)bad('REDACTION_TARGET_UNKNOWN','Range target is not a text block of this document');
  const length=textOf(node).length;
  if(!Number.isSafeInteger(range.start)||!Number.isSafeInteger(range.end)||range.start<0||range.end<=range.start||range.end>length)bad('INVALID_REDACTION','Range offsets are outside the block text');
  byNode.set(node.id,[...(byNode.get(node.id)??[]),range]);
 }
 for(const [id,list] of byNode) {
  const node=nodes.get(id),text=textOf(node);
  const isLow=i=>{const u=text.charCodeAt(i);return u>=0xdc00&&u<=0xdfff;};
  list.sort((a,b)=>b.start-a.start);
  for(let i=1;i<list.length;i++)if(list[i].end>list[i-1].start)bad('INVALID_REDACTION','Redaction ranges overlap');
  for(const range of list) {
   if(isLow(range.start)||range.end<text.length&&isLow(range.end))bad('INVALID_REDACTION','Range splits a Unicode surrogate pair');
   removed.push(text.slice(range.start,range.end));
   // Ranges were sorted from the end so earlier offsets stay valid.
   node.inlines=redactRange(node.inlines,range.start,range.end);
  }
  if(node.inlines.length===0)node.inlines=[{kind:'text',text:''}];
  if(!nodeIds.includes(id))redactions.push({nodeId:id,reason});
 }
 let derived;
 try{derived=validateLegalDocument(draft);}catch(error){throw new ExportError('INVALID_REDACTION','The redacted document is not valid: '+error.message,{cause:error});}
 const plain=legalPlainText(derived),warnings=[];
 if(removed.some(text=>text.length>=4&&text!==REDACTION_TOKEN&&plain.includes(text)))
  warnings.push('Some redacted text also appears in unredacted parts of the document or in derived reference labels; review before release');
 const derivedFromDigest=await legalEditionDigest(source);
 return {
  document:derived,
  provenance:Object.freeze({
   derivedFromDigest,derivedDigest:await legalEditionDigest(derived),
   redactions:Object.freeze(redactions.map(r=>Object.freeze(r))),
   statement:'Redacted edition derived from edition '+derivedFromDigest+': '+redactions.length+' block(s) had text removed and replaced with '+REDACTION_TOKEN+'. The removed text is absent from this edition’s data and from every export made from it.',
   warnings:Object.freeze(warnings)
  })
 };
}
