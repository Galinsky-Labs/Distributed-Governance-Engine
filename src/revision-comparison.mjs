import {canonicalize,invariant,validDigest} from './integrity-values.mjs';
import {validateLegalDocument,legalReferenceLabels,legalReferenceText} from './legal-structure.mjs';

const freeze=value=>{if(value&&typeof value==='object'){for(const item of Object.values(value))freeze(item);Object.freeze(value);}return value;};
const low=unit=>unit>=0xdc00&&unit<=0xdfff;
/** One contiguous replacement per node. Linear work; never splits Unicode pairs. */
export function compareRevisionText(before,after){
 invariant(typeof before==='string'&&typeof after==='string'&&before.length<=3000000&&after.length<=3000000,'Invalid comparison text');
 canonicalize(before);canonicalize(after);
 let start=0,end=0;
 while(start<before.length&&start<after.length&&before[start]===after[start])start++;
 if(start<before.length&&low(before.charCodeAt(start)))start--;
 while(end<before.length-start&&end<after.length-start&&before[before.length-end-1]===after[after.length-end-1])end++;
 if(end&&low(before.charCodeAt(before.length-end)))end--;
 return Object.freeze({prefix:before.slice(0,start),removed:before.slice(start,before.length-end),inserted:after.slice(start,after.length-end),suffix:before.slice(before.length-end)});
}
function indexDocument(doc){
 const labels=legalReferenceLabels(doc),nodes=new Map(),siblings=new Map();
 const inline=run=>run.kind==='text'?run.text:['reference','footnote-reference'].includes(run.kind)?legalReferenceText(run,labels):run.label+' <'+run.targetUrl+'>';
 function walk(children,parentId){
  siblings.set(parentId,children.map(node=>node.id));
  for(const [order,node]of children.entries()){
   const own=Object.fromEntries(Object.entries(node).filter(([key])=>key!=='children'));
   const heading=node.title??node.term??'',body=(node.inlines??[]).map(inline).join('');
   nodes.set(node.id,{id:node.id,kind:node.kind,parentId,order,label:labels.get(node.id)?.text??null,source:own,text:heading+(heading&&body?' — ':'')+body});
   if(node.children)walk(node.children,node.id);
  }
 }
 walk(doc.content,doc.id);return {nodes,siblings};
}
/** Deterministic longest increasing subsequence: inserted/deleted siblings aren't moves. */
function stableOrder(ids,positions){
 const tails=[],tailIndices=[],previous=[];
 for(let i=0;i<ids.length;i++){
  const position=positions.get(ids[i]);let lo=0,hi=tails.length;
  while(lo<hi){const mid=(lo+hi)>>1;if(tails[mid]<position)lo=mid+1;else hi=mid;}
  previous[i]=lo?tailIndices[lo-1]:-1;tails[lo]=position;tailIndices[lo]=i;
 }
 const stable=new Set();let at=tailIndices.at(-1);
 while(at!==undefined&&at!==-1){stable.add(ids[at]);at=previous[at];}return stable;
}
/** Read-only stable-ID comparison of exact semantic editions, without guessed identity. */
export function compareLegalRevisions(beforeDocument,afterDocument){
 const before=validateLegalDocument(beforeDocument),after=validateLegalDocument(afterDocument);
 invariant(before.id===after.id&&before.tenantId===after.tenantId,'Compare editions of the same document and workspace');
 const old=indexDocument(before),next=indexDocument(after),stable=new Set();
 for(const [parentId,children]of next.siblings){
  const oldChildren=(old.siblings.get(parentId)??[]).filter(id=>next.nodes.get(id)?.parentId===parentId);
  const positions=new Map(oldChildren.map((id,index)=>[id,index]));
  for(const id of stableOrder(children.filter(id=>positions.has(id)),positions))stable.add(id);
 }
 const changes=[];
 for(const [id,prior]of old.nodes)if(!next.nodes.has(id))changes.push({id,kind:'removed',before:prior,after:null,fields:[],moved:false,text:compareRevisionText(prior.text,'')});
 for(const [id,current]of next.nodes){
  const prior=old.nodes.get(id);
  if(!prior){changes.push({id,kind:'added',before:null,after:current,fields:[],moved:false,text:compareRevisionText('',current.text)});continue;}
  const fields=[...new Set([...Object.keys(prior.source),...Object.keys(current.source)])].sort().filter(key=>canonicalize(prior.source[key]??null)!==canonicalize(current.source[key]??null));
  const moved=prior.parentId!==current.parentId||!stable.has(id);
  if(fields.length||moved||prior.label!==current.label||prior.text!==current.text)changes.push({id,kind:'changed',before:prior,after:current,fields,moved,text:compareRevisionText(prior.text,current.text)});
 }
 const metadataKeys=['schemaVersion','mode','lifecycle','metadata','provenance','schemaMigration'];
 const metadata=metadataKeys.filter(key=>canonicalize(before[key]??null)!==canonicalize(after[key]??null)).map(key=>({field:key,before:before[key]??null,after:after[key]??null}));
 return freeze({documentId:before.id,tenantId:before.tenantId,beforeRevision:before.revision,afterRevision:after.revision,metadata,changes,unchanged:metadata.length===0&&changes.length===0});
}
/** Matches the existing development digest contract. Checksum, not issuer authentication. */
export async function verifyRevisionSnapshot(snapshot,{documentId,tenantId,version,digest:expectedDigest}={}){
 invariant(snapshot&&Number.isSafeInteger(version)&&version>=1&&snapshot.version===version,'Wrong saved edition');
 const document=validateLegalDocument(snapshot.document);
 invariant(document.id===documentId&&document.tenantId===tenantId,'Wrong document or workspace');
 validDigest(snapshot.digest);if(expectedDigest!==undefined)invariant(snapshot.digest===validDigest(expectedDigest),'History digest changed');
 const bytes=new TextEncoder().encode('dce-c14n-v0-dev\0legal-document-v'+document.schemaVersion+'\0'+canonicalize(document));
 const computed=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),byte=>byte.toString(16).padStart(2,'0')).join('');
 invariant(computed===snapshot.digest,'Saved edition checksum mismatch');
 return Object.freeze({document,version,digest:computed});
}
