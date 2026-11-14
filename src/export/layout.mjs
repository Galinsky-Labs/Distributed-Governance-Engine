/**
 * Deterministic pagination of semantic legal documents into a display list:
 * pages of positioned text runs, lines, rectangles, vector paths and link
 * annotations, plus a logical structure tree for Tagged PDF.
 * Coordinates are PDF user space (points, origin bottom-left).
 * No platform APIs: runs unchanged in Node and browsers.
 */
import {validateLegalDocument,legalOutline,legalReferenceLabels,legalReferenceText} from '../legal-structure.mjs';
import {ExportError,externalInlineText} from './common.mjs';

export const PAGE_SIZES=Object.freeze({
 letter:Object.freeze({width:612,height:792}),
 legal:Object.freeze({width:612,height:1008}),
 a4:Object.freeze({width:595.28,height:841.89})
});
export const FONT_STYLES=Object.freeze(['regular','bold','italic','boldItalic']);
export const styleOf=(bold,italic)=>bold?italic?'boldItalic':'bold':italic?'italic':'regular';

const LINK_COLOR=[0,0,0.55];
const TEXT_COLOR=[0,0,0];
const WATERMARK_COLOR=[0.85,0.85,0.85];
const INDENT_STEP=18;
const CELL_PADDING=4;
const BREAK_SPACE=/[ \t\n\r]/;

/** Normalises and validates caller options into the render profile used by every format. */
export function normalizeLayoutOptions(options={}) {
 const bad=message=>{throw new ExportError('INVALID_OPTIONS',message);};
 if(options===null||typeof options!=='object')bad('options must be an object');
 const pageSize=options.pageSize??'letter';
 if(!Object.hasOwn(PAGE_SIZES,pageSize))bad('pageSize must be letter, legal or a4');
 const m=options.margins??{};
 const margins={top:m.top??72,right:m.right??72,bottom:m.bottom??72,left:m.left??72};
 for(const value of Object.values(margins))if(!Number.isFinite(value)||value<36||value>144)bad('margins must be between 36 and 144 points');
 const lineNumbers=options.lineNumbers??'none';
 if(!['none','page','continuous'].includes(lineNumbers))bad('lineNumbers must be none, page or continuous');
 const watermark=options.watermark??null;
 if(watermark!==null&&(typeof watermark!=='string'||watermark.length===0||watermark.length>60))bad('watermark must be a string of 1-60 characters');
 const fontSize=options.fontSize??11;
 if(!Number.isFinite(fontSize)||fontSize<8||fontSize>16)bad('fontSize must be between 8 and 16');
 const signatures=validateSignatures(options.signatures??[]);
 for(const key of ['cover','toc','tableHeaderRow'])if(options[key]!==undefined&&typeof options[key]!=='boolean')bad(key+' must be a boolean');
 return {
  pageSize,...PAGE_SIZES[pageSize],margins,lineNumbers,watermark,fontSize,signatures,
  cover:options.cover??true,toc:options.toc??true,tableHeaderRow:options.tableHeaderRow??false,
  generatedAt:options.generatedAt??null
 };
}

function validateSignatures(list) {
 const bad=message=>{throw new ExportError('INVALID_SIGNATURES',message);};
 if(!Array.isArray(list)||list.length>200)bad('signatures must be an array of at most 200 entries');
 const str=(value,name,max=500)=>{if(typeof value!=='string'||value.length===0||value.length>max)bad(name+' must be a non-empty string');return value;};
 return list.map(entry=>{
  if(!entry||typeof entry!=='object')bad('Invalid signature entry');
  const out={name:str(entry.name,'name'),capacity:entry.capacity===undefined?null:str(entry.capacity,'capacity'),signedAt:str(entry.signedAt,'signedAt',64),intent:str(entry.intent,'intent',1000),receiptDigest:entry.receiptDigest,mark:null};
  if(typeof out.receiptDigest!=='string'||!/^[a-f0-9]{64}$/.test(out.receiptDigest))bad('receiptDigest must be a lowercase SHA-256 hex digest');
  const mark=entry.mark;
  if(mark!==undefined&&mark!==null) {
   if(mark.kind==='typed')out.mark={kind:'typed',text:str(mark.text,'typed mark',200)};
   else if(mark.kind==='drawn') {
    const {width,height,strokes}=mark;
    if(!(Number.isFinite(width)&&width>0&&width<=10000&&Number.isFinite(height)&&height>0&&height<=10000))bad('Drawn mark needs a positive width and height');
    if(!Array.isArray(strokes)||strokes.length===0||strokes.length>500)bad('Drawn mark needs 1-500 strokes');
    let points=0;
    const clean=strokes.map(stroke=>{
     if(!Array.isArray(stroke)||stroke.length===0)bad('Each stroke needs at least one point');
     points+=stroke.length;if(points>20000)bad('Drawn mark has too many points');
     return stroke.map(p=>{if(!p||!Number.isFinite(p.x)||!Number.isFinite(p.y))bad('Stroke points need finite x and y');return {x:Math.min(Math.max(p.x,0),width),y:Math.min(Math.max(p.y,0),height)};});
    });
    out.mark={kind:'drawn',width,height,strokes:clean};
   } else bad('mark.kind must be typed or drawn');
  }
  return out;
 });
}

/** Logical structure tree. Kids are child elements or content references {page,item}. */
export class Structure {
 constructor() {this.elements=[];}
 add(type,parent,extra={},{atStart=false}={}) {
  const element={id:this.elements.length,type,parent,kids:[],...extra};
  this.elements.push(element);
  if(parent!==null) {const kid={element:element.id};atStart?this.elements[parent].kids.splice(atStart===true?0:atStart,0,kid):this.elements[parent].kids.push(kid);}
  return element.id;
 }
 content(id,ref) {this.elements[id].kids.push({content:ref});}
}

/* ---------- Flow construction: legal document → blocks of styled spans ---------- */

const span=(text,props={})=>({text,style:'regular',underline:false,strike:false,color:TEXT_COLOR,link:null,linkKey:null,sup:false,footnote:null,struct:null,...props});

function listMarker(style,index) {
 const alpha=n=>{let s='';while(n>0){n--;s=String.fromCharCode(97+n%26)+s;n=Math.floor(n/26);}return s;};
 const roman=n=>{let s='';for(const [v,t] of [[1000,'m'],[900,'cm'],[500,'d'],[400,'cd'],[100,'c'],[90,'xc'],[50,'l'],[40,'xl'],[10,'x'],[9,'ix'],[5,'v'],[4,'iv'],[1,'i']])while(n>=v){s+=t;n-=v;}return s;};
 switch(style){
  case 'decimal':return index+'.';
  case 'lower-alpha':return alpha(index)+'.';
  case 'upper-alpha':return alpha(index).toUpperCase()+'.';
  case 'lower-roman':return roman(index)+'.';
  case 'upper-roman':return roman(index).toUpperCase()+'.';
  default:return '•';
 }
}

/**
 * Builds the layout flow for a validated legal document. Text content matches
 * legalPlainText exactly (labels, resolved references, link targets); list
 * markers and footnote numbers are extra presentation labels tagged as Lbl.
 */
export function buildDocumentFlow(doc,structure,bodyStruct,{fontSize=11,tableHeaderRow=false}={}) {
 const outlineRows=new Map(legalOutline(doc).map(row=>[row.id,row]));
 const labels=legalReferenceLabels(doc);
 const ids=new Set();
 (function collect(nodes){for(const node of nodes){ids.add(node.id);if(node.children)collect(node.children);}})(doc.content);
 ids.add(doc.id);
 const referenced=new Set();
 (function scan(nodes){for(const node of nodes){for(const run of node.inlines??[])if(run.kind==='footnote-reference')referenced.add(run.targetId);if(node.children)scan(node.children);}})(doc.content);
 let linkKey=0;
 const blocks=[],footnotes=new Map(),outline=[];
 const leading=size=>Math.round(size*1.3*100)/100;

 function inlineSpans(inlines) {
  const spans=[];
  for(const run of inlines) {
   if(run.kind==='text') {
    const marks=new Set(run.marks??[]);
    spans.push(span(run.text,{style:styleOf(marks.has('bold'),marks.has('italic')),underline:marks.has('underline'),strike:marks.has('strike')}));
   } else if(run.kind==='reference'||run.kind==='footnote-reference') {
    const text=legalReferenceText(run,labels);
    const resolved=ids.has(run.targetId);
    const isFootnote=run.kind==='footnote-reference'&&referenced.has(run.targetId)&&labels.get(run.targetId)?.kind==='footnote';
    spans.push(span(text,{color:resolved?LINK_COLOR:TEXT_COLOR,link:resolved?{dest:run.targetId}:null,linkKey:resolved?++linkKey:null,sup:run.kind==='footnote-reference',footnote:isFootnote?run.targetId:null}));
   } else {
    const {label,suffix}=externalInlineText(run),key=++linkKey,link={uri:run.targetUrl};
    spans.push(span(label,{color:LINK_COLOR,underline:true,link,linkKey:key}),span(suffix,{color:LINK_COLOR,link,linkKey:key}));
   }
  }
  return spans.length?spans:[span('')];
 }
 const textBlock=(props)=>({type:'text',label:null,indent:0,size:fontSize,leading:leading(fontSize),spaceBefore:0,spaceAfter:fontSize*0.5,keepWithNext:false,heading:false,pageBreakBefore:false,destIds:[],...props});

 function walk(nodes,parent,ctx,out) {
  for(const node of nodes) {
   if(node.kind==='section'||node.kind==='exhibit') {
    const row=outlineRows.get(node.id);
    const depth=node.kind==='section'?row.depth:0;
    const sect=structure.add('Sect',parent,{title:node.kind==='exhibit'?'Exhibit':undefined});
    const heading=structure.add('H'+Math.min(depth+1,6),sect);
    const labelText=node.kind==='section'?row.label:'EXHIBIT';
    const size=depth===0?fontSize+1:fontSize;
    out.push(textBlock({
     nodeId:node.id,struct:heading,heading:true,keepWithNext:true,pageBreakBefore:node.kind==='exhibit',
     size,leading:leading(size),spaceBefore:size*0.6,spaceAfter:size*0.3,
     indent:node.kind==='section'?depth*INDENT_STEP:0,
     label:{spans:[span(labelText+' ',{style:'bold'})],struct:null},
     spans:[span(node.title,{style:'bold'})],destIds:[node.id]
    }));
    outline.push({nodeId:node.id,title:labelText+' '+node.title,level:ctx.outlineLevel});
    walk(node.children,sect,{...ctx,indent:node.kind==='section'?(depth+1)*INDENT_STEP:0,outlineLevel:ctx.outlineLevel+1},out);
   } else if(node.kind==='paragraph'||node.kind==='definition') {
    const p=structure.add('P',parent);
    const spans=node.kind==='definition'?[span(node.term,{style:'bold'}),span('—'),...inlineSpans(node.inlines)]:inlineSpans(node.inlines);
    out.push(textBlock({nodeId:node.id,struct:p,spans,indent:ctx.indent,label:ctx.pendingLabel??null,destIds:[node.id,...(ctx.pendingDest??[])]}));
    ctx.pendingLabel=null;ctx.pendingDest=null;
   } else if(node.kind==='list') {
    const list=structure.add('L',parent);
    node.children.forEach((item,index)=>{
     const li=structure.add('LI',list),lbl=structure.add('Lbl',li),body=structure.add('LBody',li);
     const marker=listMarker(node.style,index+1);
     const itemCtx={...ctx,indent:ctx.indent+INDENT_STEP,pendingLabel:{spans:[span(marker+' ')],struct:lbl,hang:INDENT_STEP,outdent:true},pendingDest:[node.id,item.id]};
     if(index>0)itemCtx.pendingDest=[item.id];
     walk(item.children,body,itemCtx,out);
     // An item that starts with a table or list still shows its marker on its own line.
     if(itemCtx.pendingLabel)out.push(textBlock({nodeId:item.id,struct:lbl,spans:[span('')],indent:itemCtx.indent,label:itemCtx.pendingLabel,destIds:itemCtx.pendingDest}));
    });
   } else if(node.kind==='table') {
    const table=structure.add('Table',parent);
    const rows=node.children.map((row,rowIndex)=>{
     const tr=structure.add('TR',table);
     return {nodeId:row.id,struct:tr,cells:row.children.map(cell=>{
      const header=tableHeaderRow&&rowIndex===0;
      const td=structure.add(header?'TH':'TD',tr);
      const cellBlocks=[];
      walk(cell.children,td,{indent:0,outlineLevel:ctx.outlineLevel},cellBlocks);
      if(header)for(const b of cellBlocks)for(const s of b.spans)s.style=styleOf(true,s.style==='italic'||s.style==='boldItalic');
      return {nodeId:cell.id,struct:td,blocks:cellBlocks};
     })};
    });
    out.push({type:'table',nodeId:node.id,struct:table,rows,indent:ctx.indent,destIds:[node.id]});
   } else if(node.kind==='footnote') {
    const note=structure.add('Note',parent),lbl=structure.add('Lbl',note);
    const ordinal=labels.get(node.id).ordinal;
    const size=Math.max(fontSize-2,7);
    const entry=textBlock({nodeId:node.id,struct:note,size,leading:leading(size),spaceAfter:size*0.3,spans:inlineSpans(node.inlines),label:{spans:[span(ordinal+' ')],struct:lbl,hang:size*1.4},destIds:[node.id]});
    footnotes.set(node.id,entry);
    // A footnote nobody references is printed where it stands rather than lost.
    if(!referenced.has(node.id))out.push(entry);
   }
  }
 }
 walk(doc.content,bodyStruct,{indent:0,outlineLevel:0},blocks);
 return {blocks,footnotes,outline};
}

/* ---------- Line breaking ---------- */

function makeMeasurer(fonts,warnings) {
 const used=new Set();
 return {
  used,
  font(style){const font=fonts[style];if(!font)throw new ExportError('FONT_MISSING','No font supplied for style '+style);used.add(style);return font;},
  width(text,style,size) {
   const font=this.font(style);
   for(const ch of text) {
    const cp=ch.codePointAt(0);
    if(!BREAK_SPACE.test(ch)&&!font.hasGlyph(cp))warnings.add('Character U+'+cp.toString(16).toUpperCase().padStart(4,'0')+' is not in font '+(font.names.fullName??style)+'; rendered as .notdef');
   }
   return font.textWidth(text,size);
  }
 };
}

const spanSize=(s,size)=>s.sup?Math.round(size*0.65*100)/100:size;

/** Splits spans into words: fragments up to and including the following break space or after a hyphen. */
function words(spans) {
 const result=[];let current={fragments:[],hard:false};
 const push=()=>{if(current.fragments.length)result.push(current);current={fragments:[],hard:false};};
 for(const s of spans) {
  const tokens=s.text.match(/[ \t\n\r]+|[^ \t\n\r-]+-*|-+/g)??[];
  for(const token of tokens) {
   if(BREAK_SPACE.test(token[0])) {
    current.fragments.push({span:s,text:token,space:true});
    if(token.includes('\n'))current.hard=true;
    push();
   } else {
    current.fragments.push({span:s,text:token,space:false});
    if(token.endsWith('-'))push();
   }
  }
 }
 push();
 return result;
}

/** Greedy line breaking; returns lines of fragments with widths. Overlong tokens are force-broken. */
function breakLines(spans,width,size,measure) {
 const lines=[];let line=[],lineWidth=0,pendingSpace=0;
 const fragWidth=f=>f.width??=measure.width(f.text,f.span.style,spanSize(f.span,size));
 const flush=()=>{lines.push({fragments:line,width:lineWidth});line=[];lineWidth=0;pendingSpace=0;};
 for(const word of words(spans)) {
  const ink=word.fragments.filter(f=>!f.space),space=word.fragments.filter(f=>f.space);
  const inkWidth=ink.reduce((sum,f)=>sum+fragWidth(f),0),spaceWidth=space.reduce((sum,f)=>sum+fragWidth(f),0);
  if(line.length&&lineWidth+pendingSpace+inkWidth>width)flush();
  if(!line.length&&inkWidth>width) {
   // Force-break an overlong token by code point.
   for(const f of ink) for(const ch of f.text) {
    const piece={span:f.span,text:ch,space:false};const w=fragWidth(piece);
    if(line.length&&lineWidth+w>width)flush();
    const last=line.at(-1);
    if(last&&last.span===f.span&&!last.space){last.text+=ch;last.width+=w;}else line.push(piece);
    lineWidth+=w;
   }
  } else {
   lineWidth+=pendingSpace+inkWidth;line.push(...ink);
  }
  line.push(...space);pendingSpace=spaceWidth;
  if(word.hard)flush();
 }
 if(line.length||!lines.length)flush();
 return lines;
}

/* ---------- Pagination ---------- */

/**
 * Lays out a flow. meta: {title, documentId, version, editionDigest, mode, lifecycle, lang}.
 * Returns {pages, structure, outline, destinations, warnings, usedStyles, headingPages}.
 */
export function layoutFlow({flow,structure,documentStruct,fonts,options,meta}) {
 const opts=options,warnings=new Set(),measure=makeMeasurer(fonts,warnings);
 const {width:pageWidth,height:pageHeight,margins}=opts;
 const contentWidth=pageWidth-margins.left-margins.right;
 const pages=[],destinations=new Map(),pageNumberSlots=[];
 let page=null,cursor=0,fresh=true,carry=[],continuousLine=0,numberLines=false;
 const lineNumbers=[];
 const fnSeparator=8;

 const newPage=()=>{
  page={index:pages.length,items:[],links:[],footLines:[],footHeight:0};
  pages.push(page);cursor=pageHeight-margins.top;fresh=true;
  if(carry.length){const pending=carry;carry=[];addFootLines(pending,true);}
 };
 const bodyBottom=()=>margins.bottom+page.footHeight;
 const pushItem=(item,struct)=>{
  page.items.push(item);
  if(struct!==null&&struct!==undefined)structure.content(struct,{page:page.index,item:page.items.length-1});
 };
 const dest=(id,top)=>{if(!destinations.has(id))destinations.set(id,{page:page.index,y:Math.min(top+2,pageHeight)});};
 const linkStructs=new Map();

 /** Emits one line's runs at (x, baseline). Returns runs for line numbering. */
 function emitLine(fragments,x,baseline,size,defaultStruct) {
  let pen=x,run=null;
  const runs=[];
  for(const f of fragments) {
   const s=f.span;
   if(run&&run.span===s){run.text+=f.text;run.width+=f.width;}
   else{run={span:s,text:f.text,width:f.width,x:pen};runs.push(run);}
   pen+=f.width;
  }
  for(const r of runs) {
   const s=r.span,sz=spanSize(s,size),y=s.sup?baseline+size*0.35:baseline;
   let struct=s.struct??defaultStruct;
   if(s.linkKey!==null&&struct!==null) {
    // One Link element per inline link, created lazily so it sits in reading order.
    const key=struct+':'+s.linkKey;
    if(!linkStructs.has(key))linkStructs.set(key,structure.add('Link',struct));
    struct=linkStructs.get(key);
   }
   if(r.text.length===0)continue;
   pushItem({type:'text',x:r.x,y,text:r.text.replace(/[\t\n\r]/g,' '),style:s.style,size:sz,color:s.color},struct);
   const ink=r.text.replace(/[ \t\n\r]+$/,'');
   const inkWidth=ink.length===r.text.length?r.width:measure.width(ink,s.style,sz);
   if(s.underline&&inkWidth>0)pushItem({type:'line',x1:r.x,y1:y-sz*0.12,x2:r.x+inkWidth,y2:y-sz*0.12,width:sz*0.06,color:s.color});
   if(s.strike&&inkWidth>0)pushItem({type:'line',x1:r.x,y1:y+sz*0.28,x2:r.x+inkWidth,y2:y+sz*0.28,width:sz*0.06,color:s.color});
   if(s.link&&inkWidth>0)page.links.push({rect:[r.x,y-sz*0.25,r.x+inkWidth,y+sz*0.85],...s.link,struct,contents:r.text.trim()});
  }
 }
 const baselineFor=(top,block)=>top-(block.leading-block.size)/2-block.size*0.82;

 /** Lines of a text block, laid out at a given width (label hangs in the indent). */
 function blockLines(block,width) {
  const labelWidth=block.label?Math.max(block.label.hang??0,measure.width(block.label.spans.map(s=>s.text).join(''),block.label.spans[0].style,block.size)):0;
  // List markers sit in the margin left of the text column; other labels hang the text after them.
  const hang=block.label&&!block.label.outdent?labelWidth:0;
  const lines=breakLines(block.spans,Math.max(width-block.indent-hang,24),block.size,measure);
  return lines.map((line,i)=>({...line,hang,labelX:block.label?.outdent?-labelWidth:0,first:i===0,footnotes:[...new Set(line.fragments.map(f=>f.span.footnote).filter(Boolean))]}));
 }
 function drawBlockLine(block,line,x,top) {
  const baseline=baselineFor(top,block);
  if(line.first&&block.label) {
   const fragments=block.label.spans.map(s=>({span:s,text:s.text,width:measure.width(s.text,s.style,block.size)}));
   emitLine(fragments,x+block.indent+line.labelX,baseline,block.size,block.label.struct??block.struct);
  }
  if(line.first)for(const id of block.destIds)dest(id,top);
  emitLine(line.fragments,x+block.indent+line.hang,baseline,block.size,block.struct);
  return baseline;
 }

 /* Footnotes */
 const footLinesOf=new Map();
 function footnoteLines(id) {
  if(!footLinesOf.has(id)) {
   const block=flow.footnotes.get(id);
   footLinesOf.set(id,blockLines(block,contentWidth).map(line=>({block,line,height:block.leading})));
  }
  return footLinesOf.get(id);
 }
 const attached=new Set();
 function addFootLines(lines,continuation) {
  if(page.footLines.length===0&&lines.length)page.footHeight+=fnSeparator;
  for(const l of lines){page.footLines.push({...l,continuation});page.footHeight+=l.height;}
 }
 /** Height the footnotes of a line would add to the current page (all of them, or a minimum of one line each). */
 function footnoteDemand(ids,minimal) {
  let height=0,first=page.footLines.length===0;
  for(const id of ids) {
   if(attached.has(id))continue;
   const lines=footnoteLines(id);
   height+=(first?fnSeparator:0)+(minimal?lines[0].height:lines.reduce((s,l)=>s+l.height,0));first=false;
  }
  return height;
 }
 /** Attach a line's footnotes, splitting the last one onto following pages if space runs out. */
 function attachFootnotes(ids,lineBottom) {
  for(const id of ids) {
   if(attached.has(id))continue;
   attached.add(id);
   const lines=footnoteLines(id);
   let room=lineBottom-margins.bottom-page.footHeight-(page.footLines.length?0:fnSeparator);
   let fit=0;
   while(fit<lines.length&&lines[fit].height<=room+0.001){room-=lines[fit].height;fit++;}
   fit=Math.max(fit,1);
   addFootLines(lines.slice(0,fit),false);
   carry.push(...lines.slice(fit));
  }
 }

 /** How many lines from index `from` fit on the current page. */
 function linesThatFit(lines,from,leadingHeight,extraFootnotes=true) {
  let top=cursor,foot=page.footHeight,count=0;
  for(let i=from;i<lines.length;i++) {
   const full=extraFootnotes?footnoteDemand(lines[i].footnotes,false):0;
   const minimal=extraFootnotes?footnoteDemand(lines[i].footnotes,true):0;
   if(top-leadingHeight>=margins.bottom+foot+full-0.001){top-=leadingHeight;foot+=full;count++;continue;}
   if(top-leadingHeight>=margins.bottom+foot+minimal-0.001)count++;
   break;
  }
  return count;
 }

 function placeLine(block,line,x) {
  const top=cursor;
  drawBlockLine(block,line,x,top);
  cursor-=block.leading;fresh=false;
  if(numberLines)lineNumbers.push({page:page.index,baseline:baselineFor(top,block)});
  attachFootnotes(line.footnotes,cursor);
 }

 function keepHeight(index) {
  // Height that must accompany the block at `index` (keep-with-next chain + 2 lines of the next body block).
  let height=0;
  for(let i=index+1;i<flow.blocks.length;i++) {
   const next=flow.blocks[i];
   if(next.type==='table'){height+=36;break;}
   const lines=blockLines(next,contentWidth);
   if(next.heading&&next.keepWithNext){height+=next.spaceBefore+lines.length*next.leading+next.spaceAfter;continue;}
   height+=next.spaceBefore+Math.min(2,lines.length)*next.leading;break;
  }
  return height;
 }

 function placeTextBlock(block,index) {
  if(block.pageBreakBefore&&!fresh)newPage();
  if(!fresh)cursor-=block.spaceBefore;
  const lines=blockLines(block,contentWidth);
  let i=0;
  while(i<lines.length) {
   const remaining=lines.length-i;
   let k=linesThatFit(lines,i,block.leading);
   if(k>=remaining) {
    if(block.keepWithNext&&!fresh) {
     const needed=remaining*block.leading+block.spaceAfter+keepHeight(index);
     if(cursor-needed<bottomFor(lines.slice(i))&&needed<=pageHeight-margins.top-margins.bottom){newPage();continue;}
    }
    for(;i<lines.length;i++)placeLine(block,lines[i],margins.left);
    break;
   }
   if(block.heading)k=0;
   // Widows and orphans: at least two lines on each side of a page break.
   if(remaining-k<2)k=remaining-2;
   if(i===0&&k<2||i>0&&k<2)k=0;
   if(k<=0) {
    if(fresh){k=Math.max(1,linesThatFit(lines,i,block.leading));}
    else{newPage();continue;}
   }
   for(let j=0;j<k;j++,i++)placeLine(block,lines[i],margins.left);
   newPage();
  }
  cursor-=block.spaceAfter;
 }
 const bottomFor=lines=>margins.bottom+page.footHeight+footnoteDemand(lines.flatMap(l=>l.footnotes),false);

 /* Tables */
 function columnWidths(block,available) {
  const columns=block.rows[0].cells.length,natural=new Array(columns).fill(0);
  for(const row of block.rows)row.cells.forEach((cell,c)=>{
   for(const b of cell.blocks){const w=b.spans.reduce((sum,s)=>sum+measure.width(s.text,s.style,b.size),0)+b.indent+(b.label?18:0);natural[c]=Math.max(natural[c],w+2*CELL_PADDING);}
  });
  const minimum=Math.min(48,available/columns);
  const desired=natural.map(w=>Math.max(w,minimum));
  const total=desired.reduce((a,b)=>a+b,0);
  if(total<=available)return desired.map(w=>w*available/total);
  // Columns narrower than an equal share keep their natural width; wide columns share the rest.
  const widths=new Array(columns).fill(null);
  let remaining=available,open=columns;
  for(let changed=true;changed&&open>0;) {
   changed=false;
   const fair=remaining/open;
   desired.forEach((w,c)=>{if(widths[c]===null&&w<=fair){widths[c]=w;remaining-=w;open--;changed=true;}});
  }
  const wide=desired.reduce((sum,w,c)=>widths[c]===null?sum+w:sum,0);
  return widths.map((w,c)=>w??desired[c]*remaining/wide);
 }
 function placeTable(block) {
  if(!fresh)cursor-=4;
  const x0=margins.left+block.indent,available=contentWidth-block.indent;
  const widths=columnWidths(block,available);
  for(const row of block.rows) {
   const cells=row.cells.map((cell,c)=>{
    const lines=[];
    cell.blocks.forEach((b,bi)=>{for(const line of blockLines(b,widths[c]-2*CELL_PADDING))lines.push({block:b,line,height:b.leading,gap:0});if(bi<cell.blocks.length-1&&lines.length)lines.at(-1).gap=b.size*0.3;});
    return {cell,lines,next:0};
   });
   let firstSegment=true;
   for(;;) {
    const remainingHeight=Math.max(...cells.map(c=>c.lines.slice(c.next).reduce((s,l)=>s+l.height+l.gap,0)))+2*CELL_PADDING;
    const avail=cursor-bottomFor([]);
    const fullPage=pageHeight-margins.top-margins.bottom;
    if(remainingHeight>avail&&!fresh&&remainingHeight<=fullPage-page.footHeight){newPage();continue;}
    // Split the row: each cell takes as many lines as fit in the remaining height.
    const take=cells.map(c=>{let h=2*CELL_PADDING,n=0;for(let i=c.next;i<c.lines.length;i++){if(h+c.lines[i].height>avail+0.001)break;h+=c.lines[i].height+c.lines[i].gap;n++;}return n;});
    const pending=cells.some((c,i)=>c.next+take[i]<c.lines.length);
    if(pending&&take.every(n=>n===0)&&!fresh){newPage();continue;}
    if(pending&&take.every(n=>n===0))take[cells.findIndex(c=>c.next<c.lines.length)]=1;
    const top=cursor;let bottom=top;
    if(firstSegment){dest(row.nodeId,top);for(const id of block.destIds)dest(id,top);firstSegment=false;}
    let x=x0;
    const footnoteIds=[];
    cells.forEach((c,ci)=>{
     if(c.next===0)dest(c.cell.nodeId,top);
     let y=top-CELL_PADDING;
     for(let i=c.next;i<c.next+take[ci];i++){const l=c.lines[i];drawBlockLine(l.block,l.line,x+CELL_PADDING,y);footnoteIds.push(...l.line.footnotes);y-=l.height+l.gap;}
     c.next+=take[ci];bottom=Math.min(bottom,y-CELL_PADDING);x+=widths[ci];
    });
    x=x0;
    for(const w of widths){pushItem({type:'rect',x,y:bottom,w,h:top-bottom,stroke:[0.4,0.4,0.4],lineWidth:0.5});x+=w;}
    cursor=bottom;fresh=false;
    attachFootnotes(footnoteIds,cursor);
    if(cells.every(c=>c.next>=c.lines.length))break;
    newPage();
   }
  }
  cursor-=8;
 }

 /* Front matter, body, signature appendix */
 newPage();
 dest(meta.documentId,pageHeight-margins.top);
 if(opts.cover) {
  const cover=structure.add('Sect',documentStruct,{title:'Cover'},{atStart:true});
  const title={...textBlockDefaults(opts.fontSize+9),struct:structure.add('H1',cover),spans:[span(meta.title,{style:'bold'})]};
  cursor-=pageHeight*0.18;
  for(const line of blockLines(title,contentWidth))placeLine(title,line,margins.left);
  cursor-=opts.fontSize;
  const rows=[['Document ID',meta.documentId],['Version',String(meta.version)],['Revision',String(meta.revision)],['Edition digest (SHA-256)',meta.editionDigest],['Mode',meta.mode],['Lifecycle',meta.lifecycle],['Render profile',meta.renderProfileId],['Generated',opts.generatedAt??'not stated']];
  for(const [name,value] of rows) {
   const block={...textBlockDefaults(opts.fontSize),struct:structure.add('P',cover),spans:[span(name+': ',{style:'bold'}),span(value)]};
   for(const line of blockLines(block,contentWidth))placeLine(block,line,margins.left);
   cursor-=block.spaceAfter;
  }
  newPage();
 }
 const tocEntries=opts.toc?flow.outline.filter(e=>e.level<3):[];
 if(tocEntries.length) {
  const toc=structure.add('TOC',documentStruct,{title:'Contents'},{atStart:opts.cover?1:true});
  const heading={...textBlockDefaults(opts.fontSize+3),struct:structure.add('Caption',toc),spans:[span('Contents',{style:'bold'})],spaceAfter:opts.fontSize};
  placeTextBlock(heading,-1);
  const numberWidth=36;
  for(const entry of tocEntries) {
   const toci=structure.add('TOCI',toc);
   const link=structure.add('Link',toci);
   const block={...textBlockDefaults(opts.fontSize),struct:link,indent:entry.level*INDENT_STEP,spans:[span(entry.title)],spaceAfter:2};
   const lines=breakLines(block.spans,contentWidth-block.indent-numberWidth,block.size,measure).map((l,i)=>({...l,hang:0,first:i===0,footnotes:[]}));
   if(linesThatFit(lines,0,block.leading,false)<lines.length&&!fresh)newPage();
   const startTop=cursor,startPage=page;
   let baseline=0;
   for(const line of lines){baseline=drawBlockLine(block,line,margins.left,cursor);cursor-=block.leading;fresh=false;}
   const slot={type:'text',x:pageWidth-margins.right,y:baseline,text:'',style:'regular',size:block.size,color:TEXT_COLOR,alignRight:true};
   pushItem(slot,link);
   pageNumberSlots.push({item:slot,nodeId:entry.nodeId});
   startPage.links.push({rect:[margins.left,cursor,pageWidth-margins.right,startTop],dest:entry.nodeId,struct:link,contents:entry.title});
   cursor-=block.spaceAfter;
  }
  newPage();
 }
 numberLines=true;
 flow.blocks.forEach((block,index)=>block.type==='table'?placeTable(block):placeTextBlock(block,index));
 numberLines=false;
 while(carry.length){newPage();}

 const outline=[...flow.outline];
 if(opts.signatures.length)placeSignatures(opts.signatures);

 function placeSignatures(signatures) {
  newPage();
  const sect=structure.add('Sect',documentStruct,{title:'Signature appendix'});
  const heading={...textBlockDefaults(opts.fontSize+1),struct:structure.add('H1',sect),spans:[span('Signature Appendix',{style:'bold'})],destIds:['quill:signature-appendix'],spaceAfter:opts.fontSize};
  placeTextBlock(heading,-1);
  outline.push({nodeId:'quill:signature-appendix',title:'Signature Appendix',level:0});
  const gap=18,columnWidth=(contentWidth-gap)/2,box={w:Math.min(columnWidth-8,216),h:54};
  for(let i=0;i<signatures.length;i+=2) {
   const pair=signatures.slice(i,i+2).map(sig=>{
    const div=structure.add('Div',sect);
    const rows=[[span(sig.name,{style:'bold'})],...(sig.capacity?[[span('Capacity: '),span(sig.capacity)]]:[]),[span('Signed: '),span(sig.signedAt)],[span('Intent: '),span(sig.intent)],[span('Receipt: '),span(sig.receiptDigest)]];
    const blocks=rows.map(spans=>({...textBlockDefaults(opts.fontSize-1),struct:null,spans,spaceAfter:1}));
    const lines=blocks.map(b=>blockLines(b,columnWidth));
    const height=box.h+8+lines.reduce((s,ls,bi)=>s+ls.length*blocks[bi].leading,0)+12;
    return {sig,div,blocks,lines,height};
   });
   const rowHeight=Math.max(...pair.map(p=>p.height));
   if(cursor-rowHeight<margins.bottom)newPage();
   const top=cursor;
   pair.forEach((p,col)=>{
    const x=margins.left+col*(columnWidth+gap);
    pushItem({type:'rect',x,y:top-box.h,w:box.w,h:box.h,stroke:[0.6,0.6,0.6],lineWidth:0.5});
    drawMark(p.sig,x,top,box,p.div);
    let y=top-box.h-8;
    pushItem({type:'line',x1:x,y1:y+4,x2:x+box.w,y2:y+4,width:0.75,color:TEXT_COLOR});
    p.blocks.forEach((b,bi)=>{b.struct=structure.add('P',p.div);for(const line of p.lines[bi]){drawBlockLine(b,line,x,y);y-=b.leading;}});
   });
   cursor=top-rowHeight;fresh=false;
  }
 }
 function drawMark(sig,x,top,box,div) {
  const mark=sig.mark;
  if(!mark)return;
  if(mark.kind==='typed') {
   const size=Math.min(20,box.h*0.45),style='italic';
   const width=measure.width(mark.text,style,size);
   const scaled=width>box.w-8?size*(box.w-8)/width:size;
   pushItem({type:'text',x:x+4,y:top-box.h/2-scaled*0.3,text:mark.text,style,size:scaled,color:TEXT_COLOR},structure.add('P',div,{title:'Typed signature mark'}));
   return;
  }
  // Fit the drawn mark into the box (scaling small canvases up keeps it legible); canvas y grows downward.
  const pad=4,scale=Math.min((box.w-2*pad)/mark.width,(box.h-2*pad)/mark.height);
  const ox=x+pad+((box.w-2*pad)-mark.width*scale)/2,oy=top-pad-((box.h-2*pad)-mark.height*scale)/2;
  const strokes=mark.strokes.map(stroke=>stroke.map(p=>[ox+p.x*scale,oy-p.y*scale]));
  pushItem({type:'path',strokes,width:1.2,color:TEXT_COLOR},structure.add('Figure',div,{alt:'Drawn signature mark of '+sig.name,bbox:[x,top-box.h,x+box.w,top]}));
 }

 function textBlockDefaults(size) {
  return {type:'text',label:null,indent:0,size,leading:Math.round(size*1.3*100)/100,spaceBefore:0,spaceAfter:size*0.5,keepWithNext:false,heading:false,pageBreakBefore:false,destIds:[]};
 }

 /* Finishing: footnote areas, page furniture, numbering */
 const total=pages.length;
 const headerText=meta.title;
 for(const p of pages) {
  page=p;
  if(p.footLines.length) {
   let top=margins.bottom+p.footHeight;
   pushItem({type:'line',x1:margins.left,y1:top-fnSeparator/2,x2:margins.left+Math.min(144,contentWidth),y2:top-fnSeparator/2,width:0.5,color:TEXT_COLOR});
   top-=fnSeparator;
   for(const l of p.footLines){drawBlockLine(l.block,l.line,margins.left,top);top-=l.height;}
  }
  const furniture=Math.max(opts.fontSize-2,7);
  const header=fitText(headerText,'regular',furniture,contentWidth);
  pushItem({type:'text',x:margins.left,y:pageHeight-margins.top/2,text:header,style:'regular',size:furniture,color:[0.3,0.3,0.3],artifact:'Pagination'});
  const footer='Page '+(p.index+1)+' of '+total;
  pushItem({type:'text',x:(pageWidth-measure.width(footer,'regular',furniture))/2,y:margins.bottom/2,text:footer,style:'regular',size:furniture,color:[0.3,0.3,0.3],artifact:'Pagination'});
  if(opts.watermark) {
   const size=Math.min(72,(Math.hypot(pageWidth,pageHeight)*0.7)/Math.max(1,measure.width(opts.watermark,'bold',1)));
   const w=measure.width(opts.watermark,'bold',size),angle=Math.atan2(pageHeight,pageWidth);
   const cos=Math.cos(angle),sin=Math.sin(angle);
   // Painted beneath the content by the PDF writer (watermark items are drawn first).
   p.items.push({type:'text',x:pageWidth/2-cos*w/2+sin*size*0.35,y:pageHeight/2-sin*w/2-cos*size*0.35,text:opts.watermark,style:'bold',size,color:WATERMARK_COLOR,rotate:angle,artifact:'Watermark'});
  }
 }
 // Line numbers are page furniture: numbered per page or continuously over the body lines.
 if(opts.lineNumbers!=='none') {
  let previousPage=-1;
  for(const ln of lineNumbers) {
   if(opts.lineNumbers==='page'&&ln.page!==previousPage)continuousLine=0;
   previousPage=ln.page;continuousLine++;
   const text=String(continuousLine),size=Math.max(opts.fontSize-3,7);
   pages[ln.page].items.push({type:'text',x:margins.left-10-measure.width(text,'regular',size),y:ln.baseline,text,style:'regular',size,color:[0.4,0.4,0.4],artifact:'Layout',lineNumber:continuousLine});
  }
 }
 const headingPages=new Map();
 for(const entry of outline){const d=destinations.get(entry.nodeId);if(d)headingPages.set(entry.nodeId,d.page+1);}
 for(const slot of pageNumberSlots) {
  slot.item.text=String(headingPages.get(slot.nodeId)??'');
  slot.item.x-=measure.width(slot.item.text,'regular',slot.item.size);
  delete slot.item.alignRight;
 }
 function fitText(text,style,size,width) {
  if(measure.width(text,style,size)<=width)return text;
  let chars=Array.from(text);
  while(chars.length&&measure.width(chars.join('')+'…',style,size)>width)chars.pop();
  return chars.join('')+'…';
 }
 for(const p of pages)for(const item of p.items)if(item.type==='text')measure.width(item.text,item.style,item.size);
 return {pages:pages.map(p=>({width:pageWidth,height:pageHeight,items:p.items,links:p.links})),structure,outline,destinations,warnings:[...warnings],usedStyles:FONT_STYLES.filter(s=>measure.used.has(s)),headingPages,pageCount:pages.length};
}

/** Validates and lays out a legal document. fonts: parsed TrueType fonts keyed by style. */
export function layoutDocument({document,fonts,editionDigest,version,options={}}) {
 const doc=validateLegalDocument(document);
 const opts=normalizeLayoutOptions(options);
 const structure=new Structure();
 const documentStruct=structure.add('Document',null);
 const body=structure.add('Part',documentStruct,{title:'Body'});
 const flow=buildDocumentFlow(doc,structure,body,{fontSize:opts.fontSize,tableHeaderRow:opts.tableHeaderRow});
 return layoutFlow({flow,structure,documentStruct,fonts,options:opts,meta:documentMeta(doc,editionDigest,version)});
}

export function documentMeta(doc,editionDigest,version) {
 return {title:doc.metadata.title,documentId:doc.id,version,revision:doc.revision,editionDigest,mode:doc.mode,lifecycle:doc.lifecycle,lang:doc.metadata.locale,renderProfileId:'quill-render-v1'};
}
