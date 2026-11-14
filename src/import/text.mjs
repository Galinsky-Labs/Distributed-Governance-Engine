import {fail} from './errors.mjs';
import {ImportContext,resolveOptions,finishImport,textRun} from './build.mjs';
import {LEGAL_LIMITS} from '../legal-structure.mjs';

const LONE_SURROGATE=/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const MARKDOWN_HEADING=/^(#{1,6})[ \t]+(\S.*?)[ \t]*$/;
const ARTICLE_HEADING=/^(?:Article|ARTICLE|Art\.|ART\.)[ \t]+(?:[IVXLCDM]+|\d+)\b/;
const SECTION_HEADING=/^(?:Section|SECTION|Sec\.|SEC\.|§)[ \t]*\d+[A-Za-z]?(?:[.-]\d+[A-Za-z]?)*\.?(?:[ \t]|$)/;
const LIST_MARKER=/^[ \t]*(?:([-*•])|\(([0-9]{1,3}|[a-z]{1,4}|[A-Z]{1,4})\)|([0-9]{1,3})[.)])(?:[ \t]+|$)/;
const MAX_HEADING_LINE=200;

function isCapsHeading(line,lineCount) {
 const trimmed=line.trim();
 return lineCount===1&&trimmed.length<=80&&(trimmed.match(/\p{Lu}/gu)?.length??0)>=3&&!/\p{Ll}/u.test(trimmed)&&!/[,;]$/.test(trimmed)&&!LIST_MARKER.test(line);
}

function classifyHeading(lines) {
 const first=lines[0];
 if(first.length>MAX_HEADING_LINE)return null;
 const markdown=MARKDOWN_HEADING.exec(first);
 if(markdown)return {kind:'markdown',level:markdown[1].length,title:markdown[2]};
 const trimmed=first.trim();
 if(ARTICLE_HEADING.test(trimmed))return {kind:'article',title:trimmed};
 if(SECTION_HEADING.test(trimmed))return {kind:'section',title:trimmed};
 if(isCapsHeading(first,lines.length))return {kind:'caps',title:trimmed};
 return null;
}

const ROMAN=/^(?:m{0,3})(?:cm|cd|d?c{0,3})(?:xc|xl|l?x{0,3})(?:ix|iv|v?i{0,3})$/;
const nextLetter=label=>label&&/^[a-z]$/i.test(label)?String.fromCharCode(label.charCodeAt(0)+1):null;

/** Tracks the open marker types so (a)/(1)/(A)/(i) nest by legal drafting convention. */
class MarkerLevels {
 constructor(){this.stack=[];}
 typeOf(match) {
  if(match[1])return {type:'bullet',style:'bullet'};
  if(match[3])return {type:'decimal-dot',style:'decimal'};
  const label=match[2];
  if(/^[0-9]+$/.test(label))return {type:'paren-decimal',style:'decimal'};
  const lower=label===label.toLowerCase(),key=label.toLowerCase(),case_=lower?'lower':'upper';
  const alpha={type:`paren-${case_}-alpha`,style:`${case_}-alpha`},roman={type:`paren-${case_}-roman`,style:`${case_}-roman`};
  if(!ROMAN.test(key))return alpha;
  if(key.length>1)return roman;
  const openAlpha=this.stack.find(entry=>entry.type===alpha.type);
  if(openAlpha&&nextLetter(openAlpha.last)===label)return alpha;
  if(this.stack.some(entry=>entry.type===roman.type))return roman;
  return key==='i'?roman:alpha;
 }
 level(match) {
  const {type,style}=this.typeOf(match);
  const label=match[2]??match[3]??null;
  let index=this.stack.findIndex(entry=>entry.type===type);
  if(index===-1){this.stack.push({type,last:label});index=this.stack.length-1;}
  else{this.stack.length=index+1;this.stack[index].last=label;}
  return {level:index,style};
 }
}

/**
 * Heuristic plain-text structure shared by the text and PDF importers. Paragraph text is kept
 * exactly; only a recognised heading line or list marker becomes structure.
 */
export function plainTextBlocks(text,{joinLines='\n'}={}) {
 const groups=[];let current=[];
 for(const line of text.split('\n')) {
  if(/^[ \t\f\v ]*$/.test(line)){if(current.length)groups.push(current);current=[];}
  else current.push(line);
 }
 if(current.length)groups.push(current);
 const classified=groups.map(lines=>({lines,heading:classifyHeading(lines)}));
 const ranks=new Map();
 for(const {heading} of classified)if(heading&&heading.kind!=='markdown'&&!ranks.has(heading.kind))ranks.set(heading.kind,ranks.size+1);

 const blocks=[];let markers=null;
 for(const {lines,heading} of classified) {
  let body=lines;
  if(heading) {
   markers=null;
   blocks.push({type:'heading',level:heading.level??ranks.get(heading.kind),inlines:[textRun(heading.title)]});
   body=lines.slice(1);
   if(!body.length)continue;
  }
  if(!LIST_MARKER.test(body[0]))markers=null;
  let paragraph=null,entry=null;
  for(const line of body) {
   const match=LIST_MARKER.exec(line);
   if(match) {
    markers??=new MarkerLevels();
    const {level,style}=markers.level(match);
    entry={type:'list-entry',level,style,key:'text',...(match[1]?{}:{sourceLabel:match[0].trim()}),blocks:[{type:'paragraph',inlines:[textRun(line.slice(match[0].length))]}]};
    blocks.push(entry);
   } else if(entry) {
    entry.blocks[0].inlines[0].text+=joinLines+line;
   } else if(paragraph) {
    paragraph.inlines[0].text+=joinLines+line;
   } else {
    paragraph={type:'paragraph',inlines:[textRun(line)]};
    blocks.push(paragraph);
   }
  }
 }
 return blocks;
}

export function validateText(text) {
 if(typeof text!=='string')throw new TypeError('Plain text import expects a string');
 if(text.includes('\0'))fail('INVALID_TEXT','Text contains NUL characters');
 if(LONE_SURROGATE.test(text))fail('INVALID_TEXT','Text contains unpaired surrogate code units');
 if(text.length>LEGAL_LIMITS.bytes)fail('DOCUMENT_TOO_LARGE','Text is larger than the legal schema allows');
}

export function importPlainText(text,options={}) {
 const resolved=resolveOptions(options);
 validateText(text);
 const normalized=text.replace(/^﻿/,'').replace(/\r\n?/g,'\n');
 const ctx=new ImportContext('text');
 return finishImport(plainTextBlocks(normalized),ctx,resolved);
}
