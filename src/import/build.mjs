// Shared conversion from the importers' intermediate block model to the semantic legal schema.
//
// Intermediate model produced by every format reader:
//  block  = {type:'heading',level,inlines} | {type:'paragraph',inlines}
//         | {type:'list',style,items:[{blocks}]} | {type:'table',rows:[{cells:[{blocks}]}]}
//         | {type:'list-entry',level,style,key,blocks}   (flat numbered paragraphs; see groupListEntries)
//  inline = {type:'text',text,marks} | {type:'link',href,inlines} | {type:'footnote',blocks}
import {validateLegalDocument,LEGAL_LIMITS,LEGAL_SCHEMA_VERSION,normalizeExternalUrl} from '../legal-structure.mjs';
import {NUMBERING_PROFILES} from '../numbering.mjs';
import {fail} from './errors.mjs';

const NUMBERING_PROFILE='us-federal-v1';
const MAX_SECTION_DEPTH=NUMBERING_PROFILES[NUMBERING_PROFILE].length;
const MARK_ORDER=['bold','italic','underline','strike'];
const MAX_TITLE=1000,MAX_LABEL=1000;
export const LIST_STYLES=Object.freeze(['decimal','lower-alpha','upper-alpha','lower-roman','upper-roman','bullet']);
export const DISCARD_KEYS=Object.freeze(['macros','scripts','images','embeddedObjects','externalReferences','comments','trackedDeletions','unsupportedElements']);
const IDENTIFIER=/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
const LOCALE=/^[a-z]{2,3}(?:-[A-Z]{2})?$/;
const LONE_SURROGATE=/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

export const textRun=(text,marks=[])=>({type:'text',text,marks});

/** Collects warnings, discarded-content counts and source numbering labels for the report. */
export class ImportContext {
 constructor(format) {
  this.format=format;
  this.warnings=new Map();
  this.discarded=Object.fromEntries(DISCARD_KEYS.map(key=>[key,0]));
  this.sourceLabels=[];
  this.sourceLabelCount=0;
  this.provisionalReason=null;
 }
 warn(code,message,count=1) {
  const existing=this.warnings.get(code);
  if(existing)existing.count+=count;else this.warnings.set(code,{code,message,count});
 }
 discard(key,count=1) {
  if(!Object.hasOwn(this.discarded,key))throw new TypeError('Unknown discard category');
  this.discarded[key]+=count;
 }
 sourceLabel(label) {
  this.sourceLabelCount++;
  if(this.sourceLabels.length<50)this.sourceLabels.push(label);
 }
}

/** Import options shared by every format. Invalid options are caller bugs, so they throw TypeError. */
export function resolveOptions(options={}) {
 const {tenantId,documentId=globalThis.crypto.randomUUID(),title,fileName,locale='en-US',idFactory,limits={}}=options;
 if(typeof tenantId!=='string'||!IDENTIFIER.test(tenantId))throw new TypeError('tenantId must be a legal identifier');
 if(typeof documentId!=='string'||!IDENTIFIER.test(documentId))throw new TypeError('documentId must be a legal identifier');
 if(typeof locale!=='string'||!LOCALE.test(locale))throw new TypeError('locale must look like en-US');
 if(title!==undefined&&(typeof title!=='string'||title.length>MAX_TITLE||LONE_SURROGATE.test(title)))throw new TypeError('title must be a string of at most 1000 characters');
 if(idFactory!==undefined&&typeof idFactory!=='function')throw new TypeError('idFactory must be a function');
 if(limits===null||typeof limits!=='object')throw new TypeError('limits must be an object');
 const stem=typeof fileName==='string'?fileName.replace(/^.*[\\/]/,'').replace(/\.[^.]*$/,'').trim():'';
 const fallbackTitle=stem&&stem.length<=MAX_TITLE&&!LONE_SURROGATE.test(stem)?stem:'Imported document';
 return {tenantId,documentId,title:title??fallbackTitle,locale,idFactory:idFactory??(()=>globalThis.crypto.randomUUID()),limits};
}

const HEADING_LABEL=new RegExp('^(?:'+[
 '(?:Section|SECTION|Sec\\.|SEC\\.|\\u00A7\\u00A7?)\\s*\\d+[A-Za-z]?(?:[.-]\\d+[A-Za-z]?)*\\.?',
 '(?:Article|ARTICLE|Art\\.|ART\\.)\\s+(?:[IVXLCDM]+|\\d+)\\.?',
 '\\((?:\\d{1,3}|[a-z]{1,4}|[A-Z]{1,4})\\)',
 '\\d{1,3}(?:\\.\\d{1,3})*\\.',
 '\\d{1,3}(?:\\.\\d{1,3})+',
 '[IVXLC]{1,7}\\.'
].join('|')+')(?=[\\s:\\u2013\\u2014-])');
const LABEL_SEPARATOR=/^[\s:\u2013\u2014-]+/;

/** Remove a literal numbering prefix only when it is unambiguous and leaves a real title. */
export function stripHeadingLabel(title) {
 const match=HEADING_LABEL.exec(title);
 if(!match)return null;
 const rest=title.slice(match[0].length).replace(LABEL_SEPARATOR,'');
 if(!/\p{L}/u.test(rest))return null;
 return {label:match[0],title:rest};
}

/**
 * Turn flat list entries (numbered paragraphs with a nesting level) into nested lists.
 * A level jump of more than one nests a single level deeper; a new top-level key starts a new list.
 */
export function groupListEntries(blocks) {
 const out=[];let stack=[];
 for(const block of blocks) {
  if(block.type!=='list-entry'){stack=[];out.push(block);continue;}
  const level=block.level;
  while(stack.length&&stack.at(-1).level>level)stack.pop();
  if(stack.length===1&&stack[0].level>=level&&stack[0].key!==block.key)stack=[];
  if(!stack.length) {
   const list={type:'list',style:block.style,items:[]};
   out.push(list);stack.push({level,key:block.key,list});
  } else if(stack.at(-1).level<level) {
   const parent=stack.at(-1).list;
   if(!parent.items.length)parent.items.push({blocks:[]});
   const list={type:'list',style:block.style,items:[]};
   parent.items.at(-1).blocks.push(list);stack.push({level,key:block.key,list});
  }
  stack.at(-1).list.items.push({blocks:[...block.blocks]});
 }
 return out;
}

function canonicalMarks(marks) {
 return MARK_ORDER.filter(mark=>marks?.includes(mark));
}
function plainText(inlines) {
 let out='';
 for(const inline of inlines) {
  if(inline.type==='text')out+=inline.text;
  else if(inline.type==='link')out+=plainText(inline.inlines);
 }
 return out;
}
function safeHttpsUrl(href) {
 if(typeof href!=='string')return null;
 try {
  const url=normalizeExternalUrl(href.trim());
  return normalizeExternalUrl(url)===url?url:null;
 } catch {return null;}
}

class DocumentBuilder {
 constructor(ctx,options) {
  this.ctx=ctx;this.options=options;
  this.ids=new Set([options.documentId]);
  this.nodes=0;
  this.footnotes=[];
 }
 id() {
  const id=this.options.idFactory();
  if(typeof id!=='string'||!IDENTIFIER.test(id)||this.ids.has(id))throw new TypeError('idFactory must return unique legal identifiers');
  this.ids.add(id);
  return id;
 }
 node(kind,fields) {
  if(++this.nodes>LEGAL_LIMITS.nodes)fail('DOCUMENT_TOO_LARGE','The document has more structural nodes than the legal schema allows');
  return {kind,id:this.id(),...fields};
 }
 emptyParagraph() {return this.node('paragraph',{inlines:[{kind:'text',text:''}]});}

 inlines(source,{allowFootnotes=true}={}) {
  const out=[];
  const pushText=(text,marks)=>{
   if(!text)return;
   const last=out.at(-1);
   if(last?.kind==='text'&&(last.marks??[]).join()===marks.join())last.text+=text;
   else out.push(marks.length?{kind:'text',text,marks}:{kind:'text',text});
  };
  const visit=(inlines,marksOverride)=>{
   for(const inline of inlines) {
    if(inline.type==='text')pushText(inline.text,marksOverride??canonicalMarks(inline.marks));
    else if(inline.type==='link') {
     const label=plainText(inline.inlines),url=safeHttpsUrl(inline.href);
     if(!label)continue;
     if(url&&label.length<=MAX_LABEL)out.push({kind:'link',targetUrl:url,label});
     else {
      if(url)this.ctx.warn('LINK_LABEL_TOO_LONG','A link label longer than 1000 characters was kept as plain text');
      else this.ctx.warn('LINK_NOT_HTTPS','Links that are not absolute HTTPS URLs were kept as plain text without their target');
      visit(inline.inlines,marksOverride);
     }
    } else if(inline.type==='footnote') {
     if(allowFootnotes)out.push({kind:'footnote-reference',targetId:this.footnote(inline.blocks)});
     else {
      this.ctx.warn('NESTED_FOOTNOTE_INLINED','A footnote inside a footnote was kept as inline text');
      visit(this.flattenToInlines(inline.blocks),marksOverride);
     }
    }
   }
  };
  visit(source);
  for(const run of out)if(run.kind==='text'&&run.text.length>LEGAL_LIMITS.text)fail('DOCUMENT_TOO_LARGE','A paragraph exceeds the legal schema text limit');
  return out;
 }
 flattenToInlines(blocks) {
  const out=[];
  const visit=list=>{for(const block of list) {
   if(block.type==='paragraph'||block.type==='heading'){if(out.length)out.push(textRun('\n'));out.push(...block.inlines);}
   else if(block.type==='list-entry')visit(block.blocks);
   else if(block.type==='list')for(const item of block.items)visit(item.blocks);
   else if(block.type==='table')for(const row of block.rows)for(const cell of row.cells)visit(cell.blocks);
  }};
  visit(blocks);
  return out;
 }
 footnote(blocks) {
  if(blocks.some(block=>block.type!=='paragraph'))this.ctx.warn('FOOTNOTE_FLATTENED','Lists or tables inside footnotes were kept as footnote text');
  const inlines=this.inlines(this.flattenToInlines(blocks),{allowFootnotes:false});
  const node=this.node('footnote',{inlines:inlines.length?inlines:[{kind:'text',text:''}]});
  this.footnotes.push(node);
  return node.id;
 }
 paragraph(inlines) {
  const converted=this.inlines(inlines);
  if(!converted.some(run=>run.kind!=='text'||/\S/.test(run.text)))return null;
  return this.node('paragraph',{inlines:converted});
 }

 /** Convert blocks for a container whose children sit at `depth`; flattens what cannot nest. */
 blocks(blocks,depth,container) {
  const out=[];
  for(const block of groupListEntries(blocks)) {
   if(block.type==='paragraph'||block.type==='heading') {
    if(block.type==='heading')this.ctx.warn('HEADING_IN_CONTAINER','Headings inside lists, tables or long titles were kept as paragraphs');
    const node=this.paragraph(block.inlines);
    if(node)out.push(node);
   } else if(block.type==='list')out.push(...this.list(block,depth,container));
   else if(block.type==='table')out.push(...this.table(block,depth,container));
  }
  return out;
 }
 list(list,depth,container) {
  if(depth+2>LEGAL_LIMITS.depth) {
   this.ctx.warn('LIST_NESTING_FLATTENED','List nesting deeper than the legal schema allows was flattened into paragraphs');
   return list.items.flatMap(item=>this.blocks(item.blocks,depth,container));
  }
  const style=LIST_STYLES.includes(list.style)?list.style:'bullet';
  const items=[];
  for(const item of list.items) {
   const children=this.blocks(item.blocks,depth+2,'item');
   if(children.length)items.push(this.node('list-item',{children}));
  }
  return items.length?[this.node('list',{style,children:items})]:[];
 }
 table(table,depth,container) {
  if(container==='cell'||depth+3>LEGAL_LIMITS.depth) {
   this.ctx.warn('TABLE_FLATTENED','Nested tables were flattened into paragraphs in reading order');
   return table.rows.flatMap(row=>row.cells.flatMap(cell=>this.blocks(cell.blocks,depth,container)));
  }
  const rows=table.rows.filter(row=>row.cells.length);
  const width=Math.max(0,...rows.map(row=>row.cells.length));
  if(!width)return [];
  const out=[];
  for(const row of rows) {
   const cells=row.cells.map(cell=>{
    const children=this.blocks(cell.blocks,depth+3,'cell');
    return this.node('table-cell',{children:children.length?children:[this.emptyParagraph()]});
   });
   if(cells.length<width)this.ctx.warn('TABLE_PADDED','Rows with fewer cells (or merged cells) were padded with empty cells');
   while(cells.length<width)cells.push(this.node('table-cell',{children:[this.emptyParagraph()]}));
   out.push(this.node('table-row',{children:cells}));
  }
  return [this.node('table',{children:out})];
 }
 headingTitle(block) {
  let title=plainText(block.inlines);
  if(block.inlines.some(inline=>inline.type==='link'))this.ctx.warn('HEADING_LINK_AS_TEXT','Links in headings were kept as heading text without their target');
  for(const inline of block.inlines)if(inline.type==='footnote') {
   this.ctx.warn('HEADING_FOOTNOTE_UNREFERENCED','Footnotes referenced from headings were kept as footnotes without an in-heading reference');
   this.footnote(inline.blocks);
  }
  return this.strippedTitles.get(block)??title;
 }
 content(blocks) {
  const root=[];
  const stack=[{level:0,children:root,depth:0}];
  // Record removed source labels in document order before list entries are regrouped.
  this.strippedTitles=new Map();
  for(const block of blocks) {
   if(block.type==='list-entry'&&block.sourceLabel)this.ctx.sourceLabel(block.sourceLabel);
   if(block.type!=='heading')continue;
   const title=plainText(block.inlines),stripped=title.length<=MAX_TITLE?stripHeadingLabel(title):null;
   if(stripped){this.ctx.sourceLabel(stripped.label);this.strippedTitles.set(block,stripped.title);}
  }
  for(const block of groupListEntries(blocks)) {
   if(block.type==='heading') {
    const text=plainText(block.inlines);
    if(!/\S/.test(text)&&!block.inlines.some(inline=>inline.type==='footnote'))continue;
    if(text.length>MAX_TITLE) {
     this.ctx.warn('HEADING_TOO_LONG','Headings longer than 1000 characters were kept as paragraphs');
     stack.at(-1).children.push(...this.blocks([{type:'paragraph',inlines:block.inlines}],stack.at(-1).depth+1,'flow'));
     continue;
    }
    const level=Number.isSafeInteger(block.level)&&block.level>0?block.level:1;
    while(stack.length>1&&stack.at(-1).level>=level)stack.pop();
    if(stack.length>MAX_SECTION_DEPTH) {
     this.ctx.warn('HEADING_LEVEL_CLAMPED','Headings nested deeper than the numbering profile allows were placed at its deepest level');
     stack.pop();
    }
    const parent=stack.at(-1);
    const section=this.node('section',{title:this.headingTitle(block),children:[]});
    parent.children.push(section);
    stack.push({level,children:section.children,depth:parent.depth+1,section});
   } else {
    const top=stack.at(-1);
    top.children.push(...this.blocks([block],top.depth+1,'flow'));
   }
  }
  const fill=nodes=>{for(const node of nodes)if(node.kind==='section'){if(!node.children.length)node.children.push(this.emptyParagraph());fill(node.children);}};
  fill(root);
  root.push(...this.footnotes);
  if(!root.length) {
   this.ctx.warn('EMPTY_DOCUMENT','No text content was found; the import contains one empty paragraph');
   root.push(this.emptyParagraph());
  }
  return root;
 }
}

function structureCounts(document) {
 const counts={sections:0,paragraphs:0,lists:0,tables:0,footnotes:0,links:0,characters:0};
 const chars=text=>{let n=0;for(const _ of text)n++;return n;};
 const pending=[...document.content];
 while(pending.length) {
  const node=pending.pop();
  if(node.kind==='section'){counts.sections++;counts.characters+=chars(node.title);}
  else if(node.kind==='paragraph')counts.paragraphs++;
  else if(node.kind==='list')counts.lists++;
  else if(node.kind==='table')counts.tables++;
  else if(node.kind==='footnote')counts.footnotes++;
  for(const run of node.inlines??[]) {
   if(run.kind==='text')counts.characters+=chars(run.text);
   else if(run.kind==='link'){counts.links++;counts.characters+=chars(run.label);}
  }
  if(node.children)pending.push(...node.children);
 }
 return counts;
}

/** Build, validate and report. Exceeding the legal schema limits is an error, never truncation. */
export function finishImport(blocks,ctx,options) {
 const builder=new DocumentBuilder(ctx,options);
 const content=builder.content(blocks);
 let document;
 try {
  document=validateLegalDocument({
   schemaVersion:LEGAL_SCHEMA_VERSION,id:options.documentId,tenantId:options.tenantId,mode:'collaboration',lifecycle:'draft',revision:0,
   metadata:{title:options.title,locale:options.locale,numberingProfile:NUMBERING_PROFILE},content
  });
 } catch(error) {
  if(/limit|oversized/i.test(String(error?.message)))fail('DOCUMENT_TOO_LARGE','The imported document exceeds the legal schema limits');
  throw error;
 }
 const removed=ctx.sourceLabelCount;
 const report={
  format:ctx.format,
  provisional:ctx.provisionalReason!==null,
  ...(ctx.provisionalReason!==null?{provisionalReason:ctx.provisionalReason}:{}),
  warnings:[...ctx.warnings.values()],
  discarded:{...ctx.discarded},
  structure:structureCounts(document),
  numbering:{
   sourceLabels:[...ctx.sourceLabels],
   note:(removed
    ?`${removed} literal source numbering label(s) were removed from headings or list items${removed>50?' (the first 50 are listed)':''}; `
    :'No literal source numbering labels were removed; ')
    +`labels are now generated from the ${NUMBERING_PROFILE} numbering profile and automatic numbering in the source is represented only as structure, so visible numbers may differ from the original.`
  }
 };
 return {document,report};
}
