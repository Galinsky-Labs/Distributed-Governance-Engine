/**
 * Single-file static HTML export for low-bandwidth reading and printing:
 * semantic markup, inline CSS (screen + print), no scripts, no event
 * handlers, no external resources; every text and attribute is escaped.
 */
import {validateLegalDocument,legalOutline,legalReferenceLabels,legalReferenceText} from '../legal-structure.mjs';
import {normalizeLayoutOptions} from './layout.mjs';
import {ExportError,PRODUCER,RENDER_PROFILE_ID,xmlEscape,localeDirection,externalInlineText,safeHttpsUrl,utf8,requireTimestamp} from './common.mjs';

const PAGE_CSS={letter:'letter',legal:'legal',a4:'A4'};
const LIST_TYPES={decimal:'1','lower-alpha':'a','upper-alpha':'A','lower-roman':'i','upper-roman':'I'};

export function htmlStyles(profile) {
 const m=profile.margins;
 return 'body{font-family:"Liberation Serif","Times New Roman",serif;font-size:'+profile.fontSize+'pt;line-height:1.35;color:#000;background:#fff;max-width:46em;margin:0 auto;padding:1em}'
 +'h1,h2,h3,h4,h5,h6{font-size:1em;font-weight:bold;margin:1.2em 0 .4em;break-after:avoid;page-break-after:avoid}h1{font-size:1.1em}'
 +'p{margin:.4em 0;orphans:2;widows:2}table{border-collapse:collapse;width:100%;margin:.6em 0}td,th{border:1px solid #666;padding:.25em .4em;vertical-align:top;text-align:start}tr{break-inside:avoid;page-break-inside:avoid}'
 +'.level-1{margin-inline-start:1.5em}.level-2{margin-inline-start:3em}.level-3{margin-inline-start:4.5em}.level-4{margin-inline-start:6em}.level-5{margin-inline-start:7.5em}'
 +'.exhibit{break-before:page;page-break-before:always}.note{font-size:.85em;border-top:1px solid #999;margin-top:1em;padding-top:.3em}.note-label{font-weight:bold}'
 +'.cover dl{display:grid;grid-template-columns:max-content 1fr;gap:.2em 1em}.cover dd{margin:0;overflow-wrap:anywhere}.cover,nav{break-after:page;page-break-after:always}'
 +'.signatures{break-before:page;page-break-before:always}.signature{display:inline-block;vertical-align:top;width:45%;margin:0 2% 1.5em 0;overflow-wrap:anywhere}.mark{border:1px solid #999;min-height:3em;padding:.3em;font-style:italic;font-size:1.4em}'
 +'.watermark{position:fixed;top:45%;left:0;right:0;text-align:center;font-size:5em;color:#d9d9d9;transform:rotate(-35deg);z-index:-1;pointer-events:none}'
 +'ins{text-decoration:underline;color:#00008c}del{text-decoration:line-through;color:#a00000}'
 +'@page{size:'+PAGE_CSS[profile.pageSize]+';margin:'+m.top+'pt '+m.right+'pt '+m.bottom+'pt '+m.left+'pt}'
 +'@media print{body{max-width:none;padding:0;font-size:'+profile.fontSize+'pt}a{color:inherit}}';
}

/** HTML document shell shared by the edition and redline renderers. */
export function htmlDocument({lang,title,editionDigest,profile,body,warnings}) {
 const e=value=>xmlEscape(value,warnings);
 return '<!DOCTYPE html>\n<html lang="'+e(lang)+'" dir="'+localeDirection(lang)+'">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<meta name="generator" content="'+e(PRODUCER)+'">\n<meta name="quill-edition-digest" content="'+e(editionDigest)+'">\n<meta name="quill-render-profile" content="'+RENDER_PROFILE_ID+'">\n<title>'+e(title)+'</title>\n<style>'+htmlStyles(profile)+'</style>\n</head>\n<body>\n'+body+'\n</body>\n</html>\n';
}

function renderBody(doc,profile,meta,warnings) {
 const e=value=>xmlEscape(value,warnings);
 const outline=new Map(legalOutline(doc).map(row=>[row.id,row]));
 const labels=legalReferenceLabels(doc),ids=new Set([doc.id]),referenced=new Set();
 (function scan(nodes){for(const node of nodes){ids.add(node.id);for(const run of node.inlines??[])if(run.kind==='footnote-reference')referenced.add(run.targetId);if(node.children)scan(node.children);}})(doc.content);
 const anchor=id=>'n-'+id;
 const inline=inlines=>inlines.map(run=>{
  if(run.kind==='text') {
   let html=e(run.text);const marks=run.marks??[];
   if(marks.includes('bold'))html='<strong>'+html+'</strong>';
   if(marks.includes('italic'))html='<em>'+html+'</em>';
   if(marks.includes('underline'))html='<u>'+html+'</u>';
   if(marks.includes('strike'))html='<s>'+html+'</s>';
   return html;
  }
  if(run.kind==='reference'||run.kind==='footnote-reference') {
   const text=e(legalReferenceText(run,labels));
   const link=ids.has(run.targetId)?'<a href="#'+e(anchor(run.targetId))+'">'+text+'</a>':text;
   return run.kind==='footnote-reference'?'<sup>'+link+'</sup>':link;
  }
  const {label,suffix}=externalInlineText(run),url=safeHttpsUrl(run.targetUrl);
  const title=run.title?' title="'+e(run.title)+'"':'';
  const labelHtml=url?'<a href="'+e(url)+'" rel="noopener noreferrer"'+title+'>'+e(label)+'</a>':e(label);
  return (run.kind==='citation'?'<cite>'+labelHtml+'</cite>':labelHtml)+e(suffix);
 }).join('');
 const toc=[];
 function blocks(nodes,level) {
  let out='';
  for(const node of nodes) {
   const id=' id="'+e(anchor(node.id))+'"';
   if(node.kind==='section'||node.kind==='exhibit') {
    const row=outline.get(node.id),depth=node.kind==='section'?row.depth:0,tag='h'+Math.min(depth+1,6);
    const label=node.kind==='section'?row.label:'EXHIBIT';
    toc.push({id:node.id,text:label+' '+node.title,level});
    out+='<section'+id+' class="'+(node.kind==='exhibit'?'exhibit':'level-'+Math.min(depth,5))+'"><'+tag+'>'+e(label)+' '+e(node.title)+'</'+tag+'>'+blocks(node.children,level+1)+'</section>';
   } else if(node.kind==='paragraph')out+='<p'+id+'>'+inline(node.inlines)+'</p>';
   else if(node.kind==='definition')out+='<p'+id+' class="definition"><dfn><strong>'+e(node.term)+'</strong></dfn>—'+inline(node.inlines)+'</p>';
   else if(node.kind==='list') {
    const ordered=node.style!=='bullet';
    out+=(ordered?'<ol'+id+' type="'+LIST_TYPES[node.style]+'">':'<ul'+id+'>')+node.children.map(item=>'<li id="'+e(anchor(item.id))+'">'+blocks(item.children,level)+'</li>').join('')+(ordered?'</ol>':'</ul>');
   } else if(node.kind==='table') {
    out+='<table'+id+'><tbody>'+node.children.map((row,index)=>'<tr id="'+e(anchor(row.id))+'">'+row.children.map(cell=>{const tag=profile.tableHeaderRow&&index===0?'th':'td';return '<'+tag+' id="'+e(anchor(cell.id))+'"'+(tag==='th'?' scope="col"':'')+'>'+blocks(cell.children,level)+'</'+tag+'>';}).join('')+'</tr>').join('')+'</tbody></table>';
   } else if(node.kind==='footnote') {
    out+='<aside'+id+' class="note" role="note"><span class="note-label">'+e(labels.get(node.id).ordinal)+'</span> '+inline(node.inlines)+'</aside>';
   }
  }
  return out;
 }
 const main='<main>'+blocks(doc.content,0)+'</main>';
 const cover=profile.cover?'<header class="cover"><h1>'+e(meta.title)+'</h1><dl>'+[['Document ID',doc.id],['Version',String(meta.version)],['Revision',String(doc.revision)],['Edition digest (SHA-256)',meta.editionDigest],['Mode',doc.mode],['Lifecycle',doc.lifecycle],['Render profile',RENDER_PROFILE_ID],['Generated',profile.generatedAt]].map(([k,v])=>'<dt>'+e(k)+'</dt><dd>'+e(v)+'</dd>').join('')+'</dl></header>':'';
 const nav=profile.toc&&toc.length?'<nav aria-label="Contents"><h2>Contents</h2><ul>'+toc.filter(t=>t.level<3).map(t=>'<li class="level-'+t.level+'"><a href="#'+e(anchor(t.id))+'">'+e(t.text)+'</a></li>').join('')+'</ul></nav>':'';
 const signatures=profile.signatures.length?'<section class="signatures" aria-label="Signature appendix"><h2>Signature Appendix</h2>'+profile.signatures.map(sig=>{
  const mark=sig.mark?.kind==='typed'?'<div class="mark">'+e(sig.mark.text)+'</div>':sig.mark?'<div class="mark">'+drawnMarkSvg(sig)+'</div>':'';
  return '<div class="signature">'+mark+'<p><strong>'+e(sig.name)+'</strong></p>'+[['Capacity',sig.capacity],['Signed',sig.signedAt],['Intent',sig.intent],['Receipt',sig.receiptDigest]].filter(([,v])=>v).map(([k,v])=>'<p>'+e(k)+': '+e(v)+'</p>').join('')+'</div>';
 }).join('')+'</section>':'';
 const watermark=profile.watermark?'<div class="watermark" aria-hidden="true">'+e(profile.watermark)+'</div>':'';
 return watermark+cover+nav+main+signatures;
}

/** Inline SVG polylines for a drawn mark: static vector data with numeric coordinates only. */
function drawnMarkSvg(sig) {
 const {width,height,strokes}=sig.mark,r=n=>Math.round(n*100)/100;
 return '<svg role="img" aria-label="Drawn signature mark of '+xmlEscape(sig.name)+'" viewBox="0 0 '+r(width)+' '+r(height)+'" width="216" height="54" preserveAspectRatio="xMidYMid meet">'+strokes.map(stroke=>'<polyline fill="none" stroke="#000" stroke-width="'+r(Math.max(width,height)/100)+'" stroke-linecap="round" stroke-linejoin="round" points="'+stroke.map(p=>r(p.x)+','+r(p.y)).join(' ')+'"/>').join('')+'</svg>';
}

/** Renders a validated legal edition to one static HTML file (synchronous; the caller binds the digest). */
export function renderHtml({document,editionDigest,version,options={}}) {
 let doc;
 try{doc=validateLegalDocument(document);}catch(error){throw new ExportError('INVALID_DOCUMENT','The document failed legal schema validation: '+error.message,{cause:error});}
 if(typeof editionDigest!=='string'||!/^[a-f0-9]{64}$/.test(editionDigest))throw new ExportError('INVALID_EDITION_DIGEST','editionDigest must be a lowercase SHA-256 hex digest');
 if(!Number.isSafeInteger(version)||version<1)throw new ExportError('INVALID_VERSION','version must be a positive integer');
 const profile=normalizeLayoutOptions(options);requireTimestamp(profile.generatedAt);
 const warnings=new Set();
 const body=renderBody(doc,profile,{title:doc.metadata.title,version,editionDigest},warnings);
 const html=htmlDocument({lang:doc.metadata.locale,title:doc.metadata.title,editionDigest,profile,body,warnings});
 if(profile.lineNumbers!=='none')warnings.add('Line numbers are not drawn in reflowable HTML exports');
 return {html,bytes:utf8(html),warnings:[...warnings]};
}
