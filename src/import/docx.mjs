// DOCX (WordprocessingML) reader. Active and embedded content is counted, never executed or fetched.
import {fail} from './errors.mjs';
import {readZip} from './zip.mjs';
import {parseXml,isElement,elementChildren,firstChild,attribute,textContent} from './xml.mjs';
import {ImportContext,resolveOptions,finishImport,textRun} from './build.mjs';

const W=['http://schemas.openxmlformats.org/wordprocessingml/2006/main','http://purl.oclc.org/ooxml/wordprocessingml/main'];
const R=['http://schemas.openxmlformats.org/officeDocument/2006/relationships','http://purl.oclc.org/ooxml/officeDocument/relationships'];
const MC='http://schemas.openxmlformats.org/markup-compatibility/2006';
const MATH='http://schemas.openxmlformats.org/officeDocument/2006/math';
const PACKAGE_RELATIONSHIPS='http://schemas.openxmlformats.org/package/2006/relationships';
const CONTENT_TYPES='http://schemas.openxmlformats.org/package/2006/content-types';
const MAIN_CONTENT_TYPES=new Set([
 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
 'application/vnd.ms-word.document.macroEnabled.main+xml',
 'application/vnd.openxmlformats-officedocument.wordprocessingml.template.main+xml',
 'application/vnd.ms-word.template.macroEnabledTemplate.main+xml'
]);
const NUMBER_FORMATS={decimal:'decimal',decimalZero:'decimal',lowerLetter:'lower-alpha',upperLetter:'upper-alpha',lowerRoman:'lower-roman',upperRoman:'upper-roman',bullet:'bullet'};
const MAX_STYLE_CHAIN=32;

const w=(element,local)=>firstChild(element,W,local);
const wAll=(element,local)=>elementChildren(element,W,local);
const wVal=element=>element?attribute(element,W,'val'):null;
/** OOXML on/off properties: present means on unless val is false/0/off. */
const onOff=element=>element!==null&&!['false','0','off','none'].includes(wVal(element)??'true');
const relationshipType=type=>type.slice(type.lastIndexOf('/')+1);

function resolvePartName(baseDir,target) {
 let path;
 try{path=decodeURIComponent(target);}catch{return null;}
 path=path.startsWith('/')?path.slice(1):baseDir+path;
 const parts=[];
 for(const segment of path.split('/')) {
  if(segment==='..'){if(!parts.length)return null;parts.pop();}
  else if(segment&&segment!=='.')parts.push(segment);
 }
 return parts.join('/');
}
const relsNameFor=part=>{const slash=part.lastIndexOf('/');return part.slice(0,slash+1)+'_rels/'+part.slice(slash+1)+'.rels';};
const dirOf=part=>part.slice(0,part.lastIndexOf('/')+1);

function parseRelationships(root) {
 if(!isElement(root,PACKAGE_RELATIONSHIPS,'Relationships'))fail('XML_INVALID','Relationship part has an unexpected root');
 return elementChildren(root,PACKAGE_RELATIONSHIPS,'Relationship').map(rel=>({
  id:attribute(rel,null,'Id')??'',type:relationshipType(attribute(rel,null,'Type')??''),
  target:attribute(rel,null,'Target')??'',external:attribute(rel,null,'TargetMode')==='External'
 }));
}

function runMarks(rPr) {
 const marks={};
 if(!rPr)return marks;
 for(const [local,mark] of [['b','bold'],['i','italic'],['strike','strike'],['dstrike','strike']]) {
  const element=w(rPr,local);
  if(element)marks[mark]=onOff(element)||marks[mark]===true;
 }
 const underline=w(rPr,'u');
 if(underline)marks.underline=wVal(underline)!=='none'&&onOff(underline);
 const hidden=w(rPr,'vanish');
 if(hidden)marks.hidden=onOff(hidden);
 return marks;
}

class Styles {
 constructor(root) {
  this.raw=new Map();this.resolved=new Map();
  if(!root)return;
  for(const style of wAll(root,'style')) {
   const id=attribute(style,W,'styleId');
   if(id!==null&&!this.raw.has(id))this.raw.set(id,style);
  }
 }
 get(id) {
  if(id===null||!this.raw.has(id))return null;
  if(this.resolved.has(id))return this.resolved.get(id);
  const chain=[];
  // basedOn chains are walked iteratively with a cycle and length guard.
  for(let current=id,seen=new Set();current!==null&&this.raw.has(current)&&!seen.has(current)&&chain.length<MAX_STYLE_CHAIN;) {
   seen.add(current);const style=this.raw.get(current);chain.push(style);current=wVal(w(style,'basedOn'));
  }
  const result={outlineLevel:null,numPr:null,marks:{}};
  for(const style of chain.reverse()) {
   const pPr=w(style,'pPr');
   const outline=wVal(pPr&&w(pPr,'outlineLvl'));
   if(outline!==null)result.outlineLevel=Number(outline);
   const name=wVal(w(style,'name'));
   const named=/^heading ([1-9])$/i.exec(name??'');
   if(named&&outline===null)result.outlineLevel=Number(named[1])-1;
   const numPr=pPr&&w(pPr,'numPr');
   if(numPr)result.numPr=numPr;
   Object.assign(result.marks,runMarks(w(style,'rPr')));
  }
  this.resolved.set(id,result);
  return result;
 }
}

class Numbering {
 constructor(root) {
  this.abstract=new Map();this.nums=new Map();
  if(!root)return;
  for(const abstractNum of wAll(root,'abstractNum')) {
   const levels=new Map();
   for(const lvl of wAll(abstractNum,'lvl'))levels.set(attribute(lvl,W,'ilvl'),wVal(w(lvl,'numFmt')));
   this.abstract.set(attribute(abstractNum,W,'abstractNumId'),levels);
  }
  for(const num of wAll(root,'num'))this.nums.set(attribute(num,W,'numId'),wVal(w(num,'abstractNumId')));
 }
 format(numId,ilvl) {
  const levels=this.abstract.get(this.nums.get(numId));
  const format=levels?.get(String(ilvl))??'decimal';
  if(format==='none')return null;
  return NUMBER_FORMATS[format]??'decimal';
 }
}

class DocxConverter {
 constructor(ctx,{styles,numbering,relationships,notes}) {
  this.ctx=ctx;this.styles=styles;this.numbering=numbering;this.relationships=relationships;this.notes=notes;
  this.fields=[];this.activeNotes=new Set();
 }
 inFieldInstruction() {return this.fields.some(field=>field.phase==='instruction');}
 blocks(container) {
  const out=[];
  for(const child of container.children) {
   if(typeof child==='string')continue;
   if(isElement(child,W,'p'))out.push(this.paragraph(child));
   else if(isElement(child,W,'tbl'))out.push(this.table(child));
   else if(isElement(child,W,'sdt')){const content=w(child,'sdtContent');if(content)out.push(...this.blocks(content));}
   else if(isElement(child,W,'customXml')){this.ctx.discard('unsupportedElements');out.push(...this.blocks(child));}
   else if(isElement(child,W,'ins')||isElement(child,W,'moveTo')){this.trackedInsertion();out.push(...this.blocks(child));}
   else if(isElement(child,W,'del')||isElement(child,W,'moveFrom'))this.trackedDeletion();
   else if(isElement(child,W,'altChunk')){this.ctx.discard('embeddedObjects');this.ctx.warn('ALT_CHUNK_DISCARDED','Embedded alternative-format chunks (altChunk) were discarded');}
   else if(isElement(child,W,'sectPr')||isElement(child,W,'bookmarkStart')||isElement(child,W,'bookmarkEnd')||isElement(child,W,'proofErr')||isElement(child,W,'permStart')||isElement(child,W,'permEnd')||isElement(child,W,'commentRangeStart')||isElement(child,W,'commentRangeEnd'))continue;
   else this.unsupported(child);
  }
  return out;
 }
 unsupported(element) {
  if(isElement(element,MC,'AlternateContent'))this.alternateContent(element);
  else if(isElement(element,MATH)){this.ctx.discard('unsupportedElements');this.ctx.warn('MATH_DISCARDED','Equations were discarded');}
  else this.ctx.discard('unsupportedElements');
 }
 alternateContent(element) {
  this.ctx.discard(this.containsDrawing(element)?'images':'unsupportedElements');
 }
 containsDrawing(element) {
  const pending=[element];
  while(pending.length) {
   const node=pending.pop();
   if(typeof node==='string')continue;
   if(isElement(node,W,'drawing')||isElement(node,W,'pict'))return true;
   pending.push(...node.children);
  }
  return false;
 }
 trackedInsertion() {this.ctx.warn('TRACKED_INSERTIONS_ACCEPTED','Tracked insertions were accepted as ordinary text');}
 trackedDeletion() {
  this.ctx.discard('trackedDeletions');
  this.ctx.warn('TRACKED_DELETIONS_DROPPED','Tracked deletions were dropped');
 }
 paragraph(p) {
  const pPr=w(p,'pPr');
  const style=this.styles.get(wVal(pPr&&w(pPr,'pStyle')));
  const directOutline=wVal(pPr&&w(pPr,'outlineLvl'));
  const outline=directOutline!==null?Number(directOutline):style?.outlineLevel??null;
  const numPr=(pPr&&w(pPr,'numPr'))??style?.numPr??null;
  const inlines=this.inlines(p,style?.marks??{});
  if(Number.isInteger(outline)&&outline>=0&&outline<=8)return {type:'heading',level:outline+1,inlines};
  if(numPr) {
   const numId=wVal(w(numPr,'numId'));
   const ilvl=Math.min(Math.max(Number.parseInt(wVal(w(numPr,'ilvl'))??'0',10)||0,0),8);
   const format=numId!==null&&numId!=='0'?this.numbering.format(numId,ilvl):null;
   if(format)return {type:'list-entry',level:ilvl,style:format,key:numId,blocks:[{type:'paragraph',inlines}]};
  }
  return {type:'paragraph',inlines};
 }
 inlines(container,baseMarks,out=[]) {
  for(const child of container.children) {
   if(typeof child==='string')continue;
   if(isElement(child,W,'r'))this.run(child,baseMarks,out);
   else if(isElement(child,W,'hyperlink'))this.hyperlink(child,baseMarks,out);
   else if(isElement(child,W,'ins')||isElement(child,W,'moveTo')){this.trackedInsertion();this.inlines(child,baseMarks,out);}
   else if(isElement(child,W,'del')||isElement(child,W,'moveFrom'))this.trackedDeletion();
   else if(isElement(child,W,'smartTag'))this.inlines(child,baseMarks,out);
   else if(isElement(child,W,'customXml')){this.ctx.discard('unsupportedElements');this.inlines(child,baseMarks,out);}
   else if(isElement(child,W,'sdt')){const content=w(child,'sdtContent');if(content)this.inlines(content,baseMarks,out);}
   else if(isElement(child,W,'fldSimple')){this.field();this.inlines(child,baseMarks,out);}
   else if(isElement(child,W,'pPr')||isElement(child,W,'bookmarkStart')||isElement(child,W,'bookmarkEnd')||isElement(child,W,'proofErr')||isElement(child,W,'commentRangeStart')||isElement(child,W,'commentRangeEnd')||isElement(child,W,'permStart')||isElement(child,W,'permEnd'))continue;
   else this.unsupported(child);
  }
  return out;
 }
 field() {
  this.ctx.discard('unsupportedElements');
  this.ctx.warn('FIELDS_FLATTENED','Field codes were removed; their last displayed result was kept as text');
 }
 hyperlink(element,baseMarks,out) {
  const id=attribute(element,R,'id');
  const anchor=attribute(element,W,'anchor');
  const rel=id!==null?this.relationships.get(id):null;
  const inlines=this.inlines(element,baseMarks);
  if(rel&&rel.type==='hyperlink'&&rel.external)out.push({type:'link',href:rel.target+(anchor?'#'+anchor:''),inlines});
  else {
   if(anchor!==null&&!rel)this.ctx.warn('INTERNAL_LINK_AS_TEXT','Links to bookmarks inside the document were kept as plain text');
   out.push(...inlines);
  }
 }
 run(r,baseMarks,out) {
  const rPr=w(r,'rPr');
  const marks={...baseMarks,...this.styles.get(wVal(rPr&&w(rPr,'rStyle')))?.marks,...runMarks(rPr)};
  const markList=['bold','italic','underline','strike'].filter(mark=>marks[mark]);
  const emit=text=>{
   if(this.inFieldInstruction())return;
   if(marks.hidden){this.ctx.discard('unsupportedElements');this.ctx.warn('HIDDEN_TEXT_DISCARDED','Hidden (vanished) text was discarded');return;}
   out.push(textRun(text,markList));
  };
  for(const child of r.children) {
   if(typeof child==='string')continue;
   const local=isElement(child,W)?child.local:null;
   if(local==='t')emit(textContent(child));
   else if(local==='tab'||local==='ptab')emit('\t');
   else if(local==='br'||local==='cr'){if(!['page','column'].includes(attribute(child,W,'type')??''))emit('\n');}
   else if(local==='noBreakHyphen')emit('\u2011');
   else if(local==='softHyphen')emit('\u00AD');
   else if(local==='fldChar') {
    const type=attribute(child,W,'fldCharType');
    if(type==='begin'){this.field();this.fields.push({phase:'instruction'});}
    else if(type==='separate'&&this.fields.length)this.fields.at(-1).phase='result';
    else if(type==='end')this.fields.pop();
   }
   else if(local==='footnoteReference'||local==='endnoteReference')this.noteReference(local==='footnoteReference'?'footnote':'endnote',attribute(child,W,'id'),out);
   else if(local==='drawing'||local==='pict')this.ctx.discard('images');
   else if(local==='object'){this.ctx.discard('embeddedObjects');}
   else if(local==='commentReference')this.ctx.discard('comments');
   else if(local==='sym'){this.ctx.discard('unsupportedElements');this.ctx.warn('SYMBOL_DISCARDED','Symbol-font characters were discarded');}
   else if(local==='rPr'||local==='instrText'||local==='delText'||local==='lastRenderedPageBreak'||local==='annotationRef'||local==='footnoteRef'||local==='endnoteRef'||local==='separator'||local==='continuationSeparator')continue;
   else this.unsupported(child);
  }
 }
 noteReference(kind,id,out) {
  const note=this.notes[kind].get(id);
  const key=kind+':'+id;
  if(!note||this.activeNotes.has(key)){this.ctx.warn('FOOTNOTE_MISSING','A footnote reference had no readable footnote text');return;}
  if(kind==='endnote')this.ctx.warn('ENDNOTES_AS_FOOTNOTES','Endnotes were imported as footnotes');
  this.activeNotes.add(key);
  // Fields never span note boundaries; isolate the note's field state.
  const outerFields=this.fields;this.fields=[];
  const blocks=this.blocks(note);
  this.fields=outerFields;this.activeNotes.delete(key);
  out.push({type:'footnote',blocks});
 }
 table(tbl) {
  const rows=[];
  const rowElements=[];
  const collectRows=parent=>{for(const child of parent.children) {
   if(isElement(child,W,'tr'))rowElements.push(child);
   else if(isElement(child,W,'sdt')){const content=w(child,'sdtContent');if(content)collectRows(content);}
   else if(isElement(child,W,'customXml'))collectRows(child);
  }};
  collectRows(tbl);
  for(const tr of rowElements) {
   const trPr=w(tr,'trPr');
   if(trPr&&w(trPr,'del')){this.trackedDeletion();continue;}
   const cells=[];
   const collectCells=parent=>{for(const child of parent.children) {
    if(isElement(child,W,'tc')) {
     cells.push({blocks:this.blocks(child)});
     const tcPr=w(child,'tcPr');
     const span=Math.min(Number.parseInt(wVal(tcPr&&w(tcPr,'gridSpan'))??'1',10)||1,64);
     for(let i=1;i<span;i++)cells.push({blocks:[]});
    } else if(isElement(child,W,'sdt')){const content=w(child,'sdtContent');if(content)collectCells(content);}
    else if(isElement(child,W,'customXml'))collectCells(child);
   }};
   collectCells(tr);
   rows.push({cells});
  }
  return {type:'table',rows};
 }
}

function countPackageParts(names,ctx) {
 let headersFooters=0;
 for(const name of names) {
  const lower=name.toLowerCase();
  if(lower.endsWith('.bin')&&!/(^|\/)embeddings\//.test(lower))ctx.discard('macros');
  else if(/(^|\/)embeddings\//.test(lower)&&!lower.endsWith('/'))ctx.discard('embeddedObjects');
  else if(/^customxml\/item\d*\.xml$/.test(lower))ctx.discard('unsupportedElements');
  else if(/(^|\/)(header|footer)\d*\.xml$/.test(lower))headersFooters++;
 }
 if(ctx.discarded.macros)ctx.warn('MACROS_DISCARDED','Macro projects and other binary parts were discarded without being opened');
 if(headersFooters)ctx.warn('HEADERS_FOOTERS_DISCARDED','Headers and footers were not imported',headersFooters);
}

export async function importDocx(bytes,options={}) {
 const resolved=resolveOptions(options);
 const zip=await readZip(bytes,resolved.limits);
 const ctx=new ImportContext('docx');
 const names=new Set(zip.names);
 const readXml=async name=>names.has(name)?parseXml(await zip.read(name),resolved.limits):null;

 const contentTypes=await readXml('[Content_Types].xml');
 if(!contentTypes||!isElement(contentTypes,CONTENT_TYPES,'Types'))fail('UNSUPPORTED_FORMAT','Not a Word document: content types are missing');
 const packageRels=await readXml('_rels/.rels');
 const officeDocument=packageRels?parseRelationships(packageRels).find(rel=>rel.type==='officeDocument'&&!rel.external):null;
 const mainPart=officeDocument?resolvePartName('',officeDocument.target):'word/document.xml';
 const override=elementChildren(contentTypes,CONTENT_TYPES,'Override').find(o=>attribute(o,null,'PartName')==='/'+mainPart);
 if(!mainPart||!names.has(mainPart)||!override||!MAIN_CONTENT_TYPES.has(attribute(override,null,'ContentType')))fail('UNSUPPORTED_FORMAT','Not a Word document: main document part is missing');
 countPackageParts(zip.names,ctx);

 const relationships=new Map();
 const partFor=new Map();
 for(const relsName of zip.names.filter(name=>name.endsWith('.rels'))) {
  const isMain=relsName===relsNameFor(mainPart);
  for(const rel of parseRelationships(await readXml(relsName))) {
   if(isMain){if(!relationships.has(rel.id))relationships.set(rel.id,rel);if(!rel.external&&!partFor.has(rel.type))partFor.set(rel.type,resolvePartName(dirOf(mainPart),rel.target));}
   if(rel.external&&!(isMain&&rel.type==='hyperlink'))ctx.discard('externalReferences');
  }
 }
 const partXml=async(type,fallback)=>readXml(partFor.get(type)??dirOf(mainPart)+fallback);
 const document=await readXml(mainPart);
 const body=document&&isElement(document,W,'document')?w(document,'body'):null;
 if(!body)fail('UNSUPPORTED_FORMAT','Not a Word document: the document body is missing');
 const notes={footnote:new Map(),endnote:new Map()};
 for(const [kind,type,fallback] of [['footnote','footnotes','footnotes.xml'],['endnote','endnotes','endnotes.xml']]) {
  const root=await partXml(type,fallback);
  if(!root)continue;
  for(const note of wAll(root,kind)) {
   if(['separator','continuationSeparator','continuationNotice'].includes(attribute(note,W,'type')??''))continue;
   notes[kind].set(attribute(note,W,'id'),note);
  }
 }
 const converter=new DocxConverter(ctx,{
  styles:new Styles(await partXml('styles','styles.xml')),
  numbering:new Numbering(await partXml('numbering','numbering.xml')),
  relationships,notes
 });
 return finishImport(converter.blocks(body),ctx,resolved);
}
