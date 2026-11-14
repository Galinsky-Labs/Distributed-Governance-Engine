// OpenDocument Text reader. Macros, scripts, objects and images are counted, never executed or fetched.
import {fail} from './errors.mjs';
import {readZip} from './zip.mjs';
import {parseXml,isElement,elementChildren,firstChild,attribute} from './xml.mjs';
import {ImportContext,resolveOptions,finishImport,textRun} from './build.mjs';
import {LEGAL_LIMITS} from '../legal-structure.mjs';

export const ODT_MEDIA_TYPE='application/vnd.oasis.opendocument.text';
const OFFICE='urn:oasis:names:tc:opendocument:xmlns:office:1.0';
const TEXT='urn:oasis:names:tc:opendocument:xmlns:text:1.0';
const TABLE='urn:oasis:names:tc:opendocument:xmlns:table:1.0';
const STYLE='urn:oasis:names:tc:opendocument:xmlns:style:1.0';
const FO='urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0';
const XLINK='http://www.w3.org/1999/xlink';
const DRAW='urn:oasis:names:tc:opendocument:xmlns:drawing:1.0';
const SCRIPT='urn:oasis:names:tc:opendocument:xmlns:script:1.0';
const NUM_FORMATS={'1':'decimal',a:'lower-alpha',A:'upper-alpha',i:'lower-roman',I:'upper-roman'};
const MAX_STYLE_CHAIN=32,MAX_REPEAT=1000,MAX_SPACES=1000;
const IGNORED_INLINE=new Set(['bookmark','bookmark-start','bookmark-end','reference-mark','reference-mark-start','reference-mark-end','soft-page-break','change-start','change-end','change','note-citation','alphabetical-index-mark','alphabetical-index-mark-start','alphabetical-index-mark-end','toc-mark','toc-mark-start','toc-mark-end','user-index-mark','user-index-mark-start','user-index-mark-end']);
const TRANSPARENT_INLINE=new Set(['meta','meta-field','ruby','ruby-base']);

const repeatCount=(element,uri,local)=>{
 const value=Number.parseInt(attribute(element,uri,local)??'1',10);
 if(!Number.isSafeInteger(value)||value<1)return 1;
 if(value>MAX_REPEAT)fail('DOCUMENT_TOO_LARGE','A table repeats rows or cells more often than the import allows');
 return value;
};

function textProperties(style) {
 const props=firstChild(style,STYLE,'text-properties');
 if(!props)return {};
 const marks={};
 const weight=attribute(props,FO,'font-weight');
 if(weight!==null)marks.bold=weight==='bold'||Number(weight)>=600;
 const fontStyle=attribute(props,FO,'font-style');
 if(fontStyle!==null)marks.italic=fontStyle==='italic'||fontStyle==='oblique';
 const underline=attribute(props,STYLE,'text-underline-style');
 if(underline!==null)marks.underline=underline!=='none';
 const strike=attribute(props,STYLE,'text-line-through-style');
 if(strike!==null)marks.strike=strike!=='none';
 return marks;
}

class OdfStyles {
 constructor(containers) {
  this.styles=new Map();this.listStyles=new Map();this.resolved=new Map();
  for(const container of containers) {
   if(!container)continue;
   for(const style of elementChildren(container,STYLE,'style')) {
    const name=attribute(style,STYLE,'name');
    if(name!==null)this.styles.set(name,style);
   }
   for(const list of elementChildren(container,TEXT,'list-style')) {
    const name=attribute(list,STYLE,'name');
    if(name===null)continue;
    const levels=new Map();
    for(const level of list.children) {
     if(typeof level==='string')continue;
     const index=attribute(level,TEXT,'level');
     if(isElement(level,TEXT,'list-level-style-number'))levels.set(index,NUM_FORMATS[attribute(level,STYLE,'num-format')??'']??'bullet');
     else levels.set(index,'bullet');
    }
    this.listStyles.set(name,levels);
   }
  }
 }
 marks(name) {
  if(name===null||!this.styles.has(name))return {};
  if(this.resolved.has(name))return this.resolved.get(name);
  const chain=[];
  for(let current=name,seen=new Set();current!==null&&this.styles.has(current)&&!seen.has(current)&&chain.length<MAX_STYLE_CHAIN;) {
   seen.add(current);const style=this.styles.get(current);chain.push(style);current=attribute(style,STYLE,'parent-style-name');
  }
  const marks=Object.assign({},...chain.reverse().map(textProperties));
  this.resolved.set(name,marks);
  return marks;
 }
 listStyle(name,level) {
  return this.listStyles.get(name)?.get(String(level))??'bullet';
 }
}

class OdtConverter {
 constructor(ctx,styles){this.ctx=ctx;this.styles=styles;this.repeatedCells=0;}
 blocks(container) {
  const out=[];
  for(const child of container.children) {
   if(typeof child==='string')continue;
   if(isElement(child,TEXT,'p'))out.push({type:'paragraph',inlines:this.inlines(child,this.styles.marks(attribute(child,TEXT,'style-name')))});
   else if(isElement(child,TEXT,'h')) {
    const level=Number.parseInt(attribute(child,TEXT,'outline-level')??'1',10);
    out.push({type:'heading',level:Number.isSafeInteger(level)&&level>0?level:1,inlines:this.inlines(child,{})});
   }
   else if(isElement(child,TEXT,'list'))out.push(this.list(child,1,null));
   else if(isElement(child,TABLE,'table'))out.push(this.table(child));
   else if(isElement(child,TEXT,'section'))out.push(...this.blocks(child));
   else if(isElement(child,TEXT,'tracked-changes'))this.trackedChanges(child);
   else if(isElement(child,DRAW))this.drawing(child);
   else if(isElement(child,TEXT,'soft-page-break')||isElement(child,TEXT,'sequence-decls')||isElement(child,TEXT,'variable-decls')||isElement(child,TEXT,'user-field-decls')||isElement(child,OFFICE,'forms'))continue;
   else if(isElement(child,TEXT)&&/(?:index|table-of-content|bibliography)$/.test(child.local)) {
    this.ctx.discard('unsupportedElements');
    this.ctx.warn('INDEX_DISCARDED','Generated tables of contents and indexes were discarded');
   }
   else this.ctx.discard('unsupportedElements');
  }
  return out;
 }
 trackedChanges(element) {
  for(const region of elementChildren(element,TEXT,'changed-region')) {
   if(firstChild(region,TEXT,'deletion')) {
    this.ctx.discard('trackedDeletions');
    this.ctx.warn('TRACKED_DELETIONS_DROPPED','Tracked deletions were dropped');
   } else if(firstChild(region,TEXT,'insertion'))this.ctx.warn('TRACKED_INSERTIONS_ACCEPTED','Tracked insertions were accepted as ordinary text');
  }
 }
 drawing(element) {
  const pending=[element];let found=false;
  while(pending.length) {
   const node=pending.pop();
   if(typeof node==='string')continue;
   if(isElement(node,DRAW,'image')){this.ctx.discard('images');found=true;}
   else if(isElement(node,DRAW,'object')||isElement(node,DRAW,'object-ole')||isElement(node,DRAW,'plugin')||isElement(node,DRAW,'applet')){this.ctx.discard('embeddedObjects');found=true;}
   else if(isElement(node,DRAW,'text-box')){this.ctx.discard('unsupportedElements');this.ctx.warn('TEXT_BOXES_DISCARDED','Text boxes and frames were discarded');found=true;}
   else pending.push(...node.children);
  }
  if(!found)this.ctx.discard('images');
 }
 list(element,level,inheritedStyle) {
  const styleName=attribute(element,TEXT,'style-name')??inheritedStyle;
  const items=[];
  for(const child of element.children) {
   if(isElement(child,TEXT,'list-item')||isElement(child,TEXT,'list-header')) {
    const blocks=[];
    for(const part of child.children) {
     if(isElement(part,TEXT,'list'))blocks.push(this.list(part,level+1,styleName));
     else if(typeof part!=='string')blocks.push(...this.blocks({children:[part]}));
    }
    items.push({blocks});
   }
  }
  return {type:'list',style:this.styles.listStyle(styleName,level),items};
 }
 table(element) {
  const rows=[];
  const visit=parent=>{for(const child of parent.children) {
   if(typeof child==='string')continue;
   if(isElement(child,TABLE,'table-header-rows')||isElement(child,TABLE,'table-rows')||isElement(child,TABLE,'table-row-group'))visit(child);
   else if(isElement(child,TABLE,'table-row')) {
    const cells=[];
    for(const cell of child.children) {
     if(!isElement(cell,TABLE,'table-cell')&&!isElement(cell,TABLE,'covered-table-cell'))continue;
     const repeat=repeatCount(cell,TABLE,'number-columns-repeated');
     const blocks=isElement(cell,TABLE,'table-cell')?this.blocks(cell):[];
     for(let i=0;i<repeat;i++)cells.push({blocks:i===0?blocks:structuredClone(blocks)});
     this.countRepeated(repeat);
    }
    const repeat=repeatCount(child,TABLE,'number-rows-repeated');
    for(let i=0;i<repeat;i++)rows.push({cells:i===0?cells:structuredClone(cells)});
    this.countRepeated(repeat*Math.max(1,cells.length));
   }
  }};
  visit(element);
  return {type:'table',rows};
 }
 countRepeated(count) {
  this.repeatedCells+=count;
  if(this.repeatedCells>LEGAL_LIMITS.nodes)fail('DOCUMENT_TOO_LARGE','Tables contain more cells than the legal schema allows');
 }
 inlines(container,baseMarks,out=[]) {
  const markList=marks=>['bold','italic','underline','strike'].filter(mark=>marks[mark]);
  for(const child of container.children) {
   if(typeof child==='string'){out.push(textRun(child.replace(/[ \t\n\r]+/g,' '),markList(baseMarks)));continue;}
   if(isElement(child,TEXT,'s'))out.push(textRun(' '.repeat(Math.min(Math.max(Number.parseInt(attribute(child,TEXT,'c')??'1',10)||1,1),MAX_SPACES)),markList(baseMarks)));
   else if(isElement(child,TEXT,'tab'))out.push(textRun('\t',markList(baseMarks)));
   else if(isElement(child,TEXT,'line-break'))out.push(textRun('\n',markList(baseMarks)));
   else if(isElement(child,TEXT,'span'))this.inlines(child,{...baseMarks,...this.styles.marks(attribute(child,TEXT,'style-name'))},out);
   else if(isElement(child,TEXT,'a'))out.push({type:'link',href:attribute(child,XLINK,'href')??'',inlines:this.inlines(child,baseMarks)});
   else if(isElement(child,TEXT,'note')) {
    if(attribute(child,TEXT,'note-class')==='endnote')this.ctx.warn('ENDNOTES_AS_FOOTNOTES','Endnotes were imported as footnotes');
    const body=firstChild(child,TEXT,'note-body');
    out.push({type:'footnote',blocks:body?this.blocks(body):[]});
   }
   else if(isElement(child,OFFICE,'annotation'))this.ctx.discard('comments');
   else if(isElement(child,OFFICE,'annotation-end'))continue;
   else if(isElement(child,DRAW))this.drawing(child);
   else if(isElement(child,TEXT)&&IGNORED_INLINE.has(child.local))continue;
   else if(isElement(child,TEXT)&&TRANSPARENT_INLINE.has(child.local))this.inlines(child,baseMarks,out);
   else if(isElement(child,TEXT)&&child.local!=='ruby-text') {
    // Fields (dates, page numbers, cross-references...) keep their displayed value only.
    this.ctx.discard('unsupportedElements');
    this.ctx.warn('FIELDS_FLATTENED','Field codes were removed; their last displayed result was kept as text');
    this.inlines(child,baseMarks,out);
   }
   else this.ctx.discard('unsupportedElements');
  }
  return out;
 }
}

function countScripts(root,ctx) {
 const pending=[root];
 while(pending.length) {
  const node=pending.pop();
  if(typeof node==='string')continue;
  if(isElement(node,OFFICE,'script')||isElement(node,SCRIPT,'event-listener'))ctx.discard('scripts');
  pending.push(...node.children);
 }
}

export async function importOdt(bytes,options={}) {
 const resolved=resolveOptions(options);
 const zip=await readZip(bytes,resolved.limits);
 const names=new Set(zip.names);
 if(!names.has('mimetype'))fail('UNSUPPORTED_FORMAT','Not an OpenDocument text: mimetype is missing');
 const mimetype=await zip.read('mimetype');
 if(mimetype.length>200||new TextDecoder().decode(mimetype)!==ODT_MEDIA_TYPE)fail('UNSUPPORTED_FORMAT','Not an OpenDocument text document');
 if(!names.has('content.xml'))fail('UNSUPPORTED_FORMAT','OpenDocument content is missing');
 const ctx=new ImportContext('odt');
 for(const name of zip.names) {
  if(name.endsWith('/'))continue;
  if(/^Basic\//.test(name)&&!/(?:^|\/)(?:script-lc|script-lb|dialog-lc|dialog-lb)\.xml$/.test(name))ctx.discard('macros');
  else if(/^Scripts\//.test(name))ctx.discard('scripts');
 }
 if(ctx.discarded.macros||ctx.discarded.scripts)ctx.warn('MACROS_DISCARDED','Macro and script libraries were discarded without being opened');
 const content=parseXml(await zip.read('content.xml'),resolved.limits);
 const stylesRoot=names.has('styles.xml')?parseXml(await zip.read('styles.xml'),resolved.limits):null;
 if(!isElement(content,OFFICE,'document-content'))fail('UNSUPPORTED_FORMAT','OpenDocument content has an unexpected root');
 countScripts(content,ctx);
 const text=firstChild(firstChild(content,OFFICE,'body')??{children:[]},OFFICE,'text');
 if(!text)fail('UNSUPPORTED_FORMAT','OpenDocument body text is missing');
 const styles=new OdfStyles([
  stylesRoot&&firstChild(stylesRoot,OFFICE,'styles'),stylesRoot&&firstChild(stylesRoot,OFFICE,'automatic-styles'),
  firstChild(content,OFFICE,'automatic-styles')
 ]);
 return finishImport(new OdtConverter(ctx,styles).blocks(text),ctx,resolved);
}
