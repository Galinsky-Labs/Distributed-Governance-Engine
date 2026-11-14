// Tolerant HTML reader that never builds a DOM, never fetches and never keeps active content.
import {fail} from './errors.mjs';
import {ImportContext,resolveOptions,finishImport} from './build.mjs';

export const HTML_DEFAULT_LIMITS=Object.freeze({maxInputLength:20*1024*1024,maxDepth:256,maxNodes:500000});
const REPLACEMENT='\uFFFD';
const NAMED={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:'\u00A0',copy:'\u00A9',reg:'\u00AE',mdash:'\u2014',ndash:'\u2013',hellip:'\u2026',lsquo:'\u2018',rsquo:'\u2019',ldquo:'\u201C',rdquo:'\u201D',sect:'\u00A7',para:'\u00B6'};
// HTML allows these legacy references without the terminating semicolon.
const LEGACY_NO_SEMICOLON=new Set(['amp','lt','gt','quot','nbsp','copy','reg','sect','para']);
const WINDOWS_1252=new TextDecoder('windows-1252');
const ENTITY=/&(?:#([0-9]+);?|#[xX]([0-9A-Fa-f]+);?|([A-Za-z][A-Za-z0-9]{1,31})(;?))/g;

/** Decode character references; in attributes an unterminated legacy reference stays literal (e.g. ?a=1&copy=2). */
export function decodeHtmlReferences(text,{attribute=false}={}) {
 if(!text.includes('&'))return text;
 return text.replace(ENTITY,(match,decimal,hex,name,semicolon)=>{
  if(name!==undefined) {
   if(semicolon)return Object.hasOwn(NAMED,name)?NAMED[name]:match;
   if(attribute)return match;
   for(const legacy of LEGACY_NO_SEMICOLON)if(name.startsWith(legacy))return NAMED[legacy]+name.slice(legacy.length);
   return match;
  }
  const digits=decimal??hex;
  const cp=digits.length>8?Infinity:parseInt(digits,decimal!==undefined?10:16);
  if(cp===0||cp>0x10ffff||(cp>=0xd800&&cp<=0xdfff))return REPLACEMENT;
  if(cp>=0x80&&cp<=0x9f)return WINDOWS_1252.decode(Uint8Array.of(cp));
  return String.fromCodePoint(cp);
 });
}

const VOID=new Set(['area','base','br','col','embed','hr','img','input','keygen','link','meta','param','source','track','wbr','frame']);
const RAW_TEXT=new Set(['script','style','textarea','title','xmp','iframe','noembed','noframes','noscript','plaintext']);
// Elements whose whole subtree is dropped: active, embedded or foreign content.
const DISCARD_SUBTREE=new Set(['template','svg','math','object','applet','select','button','datalist','video','audio','picture','canvas','map','frameset','dialog']);
const DISCARD_CATEGORY={
 script:'scripts',
 iframe:'embeddedObjects',object:'embeddedObjects',embed:'embeddedObjects',applet:'embeddedObjects',frame:'embeddedObjects',frameset:'embeddedObjects',
 img:'images',svg:'images',picture:'images',video:'images',audio:'images',
 style:'unsupportedElements',textarea:'unsupportedElements',title:'unsupportedElements',noscript:'unsupportedElements',template:'unsupportedElements',
 math:'unsupportedElements',select:'unsupportedElements',button:'unsupportedElements',input:'unsupportedElements',datalist:'unsupportedElements',
 canvas:'unsupportedElements',map:'unsupportedElements',dialog:'unsupportedElements',form:'unsupportedElements',xmp:'unsupportedElements',
 noembed:'unsupportedElements',noframes:'unsupportedElements',plaintext:'unsupportedElements'
};
const CLOSES_P=new Set(['address','article','aside','blockquote','center','details','dialog','dir','div','dl','fieldset','figcaption','figure','footer','form','h1','h2','h3','h4','h5','h6','header','hgroup','hr','main','menu','nav','ol','p','pre','section','summary','table','ul','li','dd','dt']);
const HEADINGS=new Set(['h1','h2','h3','h4','h5','h6']);
const BLOCKS=new Set(['p','div','blockquote','pre','section','article','main','header','footer','nav','aside','address','figure','figcaption','center','details','summary','dl','dt','dd','form','fieldset','legend','caption','hgroup','menu','dir','body','html','li','tr','td','th']);
const MARKS={b:'bold',strong:'bold',i:'italic',em:'italic',u:'underline',s:'strike',strike:'strike',del:'strike'};
const NAME_CHAR=/[^\s/>]/;

function lowerName(s,start) {
 let end=start;
 while(end<s.length&&NAME_CHAR.test(s[end]))end++;
 return {name:s.slice(start,end).toLowerCase(),end};
}

/** Parse a start tag at `start` (pointing at '<'); returns null when the tag never closes. */
function readStartTag(s,start) {
 const {name,end}=lowerName(s,start+1);
 const attrs=new Map();let pos=end,selfClosing=false;
 for(;;) {
  while(pos<s.length&&/[\s/]/.test(s[pos])){selfClosing=s[pos]==='/';pos++;}
  if(pos>=s.length)return null;
  if(s[pos]==='>')return {name,attrs,selfClosing,end:pos+1};
  selfClosing=false;
  let nameEnd=pos+1;
  while(nameEnd<s.length&&!/[\s/>=]/.test(s[nameEnd]))nameEnd++;
  const attrName=s.slice(pos,nameEnd).toLowerCase();
  pos=nameEnd;
  while(pos<s.length&&/\s/.test(s[pos]))pos++;
  let value='';
  if(s[pos]==='=') {
   pos++;
   while(pos<s.length&&/\s/.test(s[pos]))pos++;
   const quote=s[pos];
   if(quote==='"'||quote==="'") {
    const close=s.indexOf(quote,pos+1);
    if(close===-1)return null;
    value=s.slice(pos+1,close);pos=close+1;
   } else {
    const begin=pos;
    while(pos<s.length&&!/[\s>]/.test(s[pos]))pos++;
    value=s.slice(begin,pos);
   }
  }
  if(!attrs.has(attrName))attrs.set(attrName,decodeHtmlReferences(value,{attribute:true}));
 }
}

function findRawTextEnd(s,lower,from,name) {
 const needle='</'+name;
 for(let at=lower.indexOf(needle,from);at!==-1;at=lower.indexOf(needle,at+1)) {
  const next=s[at+needle.length];
  if(next===undefined||/[\s/>]/.test(next)) {
   const close=s.indexOf('>',at);
   return close===-1?s.length:close+1;
  }
 }
 return s.length;
}

class TreeBuilder {
 constructor(ctx,caps) {
  this.ctx=ctx;this.caps=caps;
  this.root={tag:'#root',attrs:new Map(),children:[]};
  this.stack=[this.root];this.nodes=0;
 }
 count() {if(++this.nodes>this.caps.maxNodes)fail('DOCUMENT_TOO_LARGE','HTML has too many nodes');}
 get current(){return this.stack.at(-1);}
 text(value) {
  if(!value)return;
  const children=this.current.children;
  if(typeof children.at(-1)==='string')children[children.length-1]+=value;
  else{this.count();children.push(value);}
 }
 hasOpen(tag,boundaries) {
  for(let i=this.stack.length-1;i>0;i--) {
   if(this.stack[i].tag===tag)return i;
   if(boundaries.has(this.stack[i].tag))return -1;
  }
  return -1;
 }
 closeTo(index) {if(index>0)this.stack.length=index;}
 start(tag,attrs,selfClosing) {
  if(tag==='p'||CLOSES_P.has(tag))this.closeTo(this.hasOpen('p',new Set(['table','td','th','li','button'])));
  if(tag==='li')this.closeTo(this.hasOpen('li',new Set(['ul','ol','table'])));
  if(tag==='dt'||tag==='dd'){const i=Math.max(this.hasOpen('dt',new Set(['dl','table'])),this.hasOpen('dd',new Set(['dl','table'])));this.closeTo(i);}
  if(tag==='td'||tag==='th'){const i=Math.max(this.hasOpen('td',new Set(['tr','table'])),this.hasOpen('th',new Set(['tr','table'])));this.closeTo(i);}
  if(tag==='tr')this.closeTo(this.hasOpen('tr',new Set(['table'])));
  if(['thead','tbody','tfoot'].includes(tag))this.closeTo(Math.max(...['thead','tbody','tfoot'].map(t=>this.hasOpen(t,new Set(['table'])))));
  if(HEADINGS.has(tag)&&HEADINGS.has(this.current.tag))this.stack.pop();
  this.count();
  const element={tag,attrs,children:[]};
  this.current.children.push(element);
  if(VOID.has(tag)||selfClosing&&!BLOCKS.has(tag)&&!HEADINGS.has(tag)&&!MARKS[tag]&&tag!=='a')return;
  if(this.stack.length>this.caps.maxDepth) {
   this.ctx.warn('HTML_NESTING_FLATTENED','Markup nested deeper than 256 elements was flattened');
   return;
  }
  this.stack.push(element);
 }
 end(tag) {
  for(let i=this.stack.length-1;i>0;i--)if(this.stack[i].tag===tag){this.stack.length=i;return;}
 }
}

function tokenize(s,ctx,caps) {
 const tree=new TreeBuilder(ctx,caps);
 const lower=s.toLowerCase();
 let pos=0;
 while(pos<s.length) {
  const lt=s.indexOf('<',pos);
  if(lt===-1){tree.text(decodeHtmlReferences(s.slice(pos)));break;}
  if(lt>pos)tree.text(decodeHtmlReferences(s.slice(pos,lt)));
  pos=lt;
  const next=s[pos+1];
  if(s.startsWith('<!-->',pos)||s.startsWith('<!--->',pos)) {
   pos=s.indexOf('>',pos)+1;
  } else if(s.startsWith('<!--',pos)) {
   const close=s.indexOf('-->',pos+4);
   pos=close===-1?s.length:close+3;
  } else if(next==='!'||next==='?') {
   const close=s.indexOf('>',pos);
   pos=close===-1?s.length:close+1;
  } else if(next==='/'&&/[A-Za-z]/.test(s[pos+2]??'')) {
   const {name}=lowerName(s,pos+2);
   const close=s.indexOf('>',pos);
   pos=close===-1?s.length:close+1;
   tree.end(name);
  } else if(/[A-Za-z]/.test(next??'')) {
   const tag=readStartTag(s,pos);
   if(!tag){pos=s.length;break;}
   pos=tag.end;
   const category=DISCARD_CATEGORY[tag.name];
   if(category)ctx.discard(category);
   if(tag.name==='link'&&tag.attrs.has('href')||tag.name==='base'&&tag.attrs.has('href')||tag.name==='meta'&&/refresh/i.test(tag.attrs.get('http-equiv')??''))ctx.discard('externalReferences');
   for(const attr of tag.attrs.keys())if(attr.startsWith('on'))ctx.discard('scripts');
   if(RAW_TEXT.has(tag.name)) {
    pos=tag.name==='plaintext'?s.length:findRawTextEnd(s,lower,pos,tag.name);
    continue;
   }
   tree.start(tag.name,tag.attrs,tag.selfClosing);
  } else {
   tree.text('<');pos++;
  }
 }
 return tree.root;
}

const SCRIPT_URL=/^\s*(?:javascript|vbscript)\s*:/i;
const LIST_TYPES={a:'lower-alpha',A:'upper-alpha',i:'lower-roman',I:'upper-roman','1':'decimal'};

/** Collapse inter-element whitespace the way a browser renders it, across link boundaries. */
function collapseWhitespace(inlines) {
 let atStart=true;const runs=[];
 const visit=list=>{for(const inline of list) {
  if(inline.type==='link')visit(inline.inlines);
  else if(inline.type==='text'&&!inline.pre) {
   let text=inline.text.replace(/[ \t\n\r\f]+/g,' ');
   if(atStart&&text.startsWith(' '))text=text.slice(1);
   inline.text=text;
   if(text)atStart=text.endsWith(' ')||text.endsWith('\n');
   runs.push(inline);
  } else if(inline.type==='text'){if(inline.text)atStart=inline.text.endsWith('\n');runs.push(inline);}
 }};
 visit(inlines);
 for(let i=runs.length-1;i>=0;i--) {
  if(runs[i].pre)break;
  runs[i].text=runs[i].text.replace(/ +$/,'');
  if(runs[i].text)break;
 }
 const strip=list=>list.filter(inline=>{
  if(inline.type==='link'){inline.inlines=strip(inline.inlines);return inline.inlines.length>0;}
  delete inline.pre;
  return inline.text!=='';
 });
 return strip(inlines);
}

class Converter {
 constructor(ctx){this.ctx=ctx;}
 inlinesOf(node,marks,pre,out=[],inLink=false) {
  for(const child of node.children) {
   if(typeof child==='string'){out.push({type:'text',text:child,marks,pre});continue;}
   if(DISCARD_SUBTREE.has(child.tag))continue;
   if(child.tag==='br'){out.push({type:'text',text:'\n',marks,pre:true});continue;}
   if(child.tag==='a'&&child.attrs.has('href')&&!inLink) {
    const href=child.attrs.get('href');
    if(SCRIPT_URL.test(href)){this.ctx.discard('scripts');this.ctx.warn('SCRIPT_URL_REMOVED','Script URLs were removed from links');this.inlinesOf(child,marks,pre,out,inLink);continue;}
    out.push({type:'link',href,inlines:this.inlinesOf(child,marks,pre,[],true)});
    continue;
   }
   const mark=MARKS[child.tag];
   const nextMarks=mark&&!marks.includes(mark)?[...marks,mark]:marks;
   if(BLOCKS.has(child.tag)||HEADINGS.has(child.tag)||child.tag==='table'||child.tag==='ul'||child.tag==='ol')out.push({type:'text',text:' ',marks,pre:false});
   this.inlinesOf(child,nextMarks,pre||child.tag==='pre',out,inLink);
  }
  return out;
 }
 flow(node,pre=false) {
  const blocks=[];let inlines=[];
  const flush=()=>{
   const collapsed=collapseWhitespace(inlines);
   if(collapsed.length)blocks.push({type:'paragraph',inlines:collapsed});
   inlines=[];
  };
  const visit=(parent,marks,inPre)=>{
   for(const child of parent.children) {
    if(typeof child==='string'){inlines.push({type:'text',text:child,marks,pre:inPre});continue;}
    const tag=child.tag;
    if(DISCARD_SUBTREE.has(tag))continue;
    if(HEADINGS.has(tag)){flush();const runs=collapseWhitespace(this.inlinesOf(child,[],false));blocks.push({type:'heading',level:Number(tag[1]),inlines:runs});}
    else if(tag==='ul'||tag==='ol'){flush();blocks.push(this.list(child));}
    else if(tag==='table'){flush();blocks.push(...this.table(child));}
    else if(tag==='hr'){flush();}
    else if(BLOCKS.has(tag)){flush();visit(child,marks,inPre||tag==='pre');flush();}
    else if(tag==='br'||tag==='a'&&child.attrs.has('href'))inlines.push(...this.inlinesOf({children:[child]},marks,inPre));
    else {
     const mark=MARKS[tag];
     visit(child,mark&&!marks.includes(mark)?[...marks,mark]:marks,inPre);
    }
   }
  };
  visit(node,[],pre);
  flush();
  return blocks;
 }
 list(node) {
  const style=node.tag==='ul'?'bullet':LIST_TYPES[node.attrs.get('type')]??'decimal';
  const items=[];let loose=null;
  for(const child of node.children) {
   if(typeof child!=='string'&&child.tag==='li'){loose=null;items.push({blocks:this.flow(child)});}
   else {
    if(typeof child==='string'&&!/\S/.test(child))continue;
    if(!loose){loose={tag:'li',attrs:new Map(),children:[]};items.push(loose);}
    loose.children.push(child);
   }
  }
  return {type:'list',style,items:items.map(item=>item.blocks?item:{blocks:this.flow(item)})};
 }
 table(node) {
  const before=[],rows=[];
  // Content misplaced inside table markup is kept before the table, as browsers do.
  const misplaced=child=>{if(typeof child!=='string'||/\S/.test(child))before.push(...this.flow({children:[child]}));};
  const visitRows=parent=>{for(const child of parent.children) {
   if(typeof child!=='string'&&DISCARD_SUBTREE.has(child.tag))continue;
   if(typeof child==='string')misplaced(child);
   else if(child.tag==='caption')before.push(...this.flow(child));
   else if(['thead','tbody','tfoot'].includes(child.tag))visitRows(child);
   else if(child.tag==='tr') {
    const cells=[];
    for(const cell of child.children) {
     if(typeof cell==='string'||!['td','th'].includes(cell.tag)){misplaced(cell);continue;}
     cells.push({blocks:this.flow(cell)});
     const span=Math.min(Number.parseInt(cell.attrs.get('colspan')??'1',10)||1,100);
     for(let i=1;i<span;i++)cells.push({blocks:[]});
    }
    rows.push({cells});
   } else misplaced(child);
  }};
  visitRows(node);
  return [...before,{type:'table',rows}];
 }
}

export function importHtml(text,options={}) {
 const resolved=resolveOptions(options);
 if(typeof text!=='string')throw new TypeError('HTML import expects a string');
 const caps={...HTML_DEFAULT_LIMITS,...resolved.limits};
 if(text.length>caps.maxInputLength)fail('DOCUMENT_TOO_LARGE','HTML input is too large');
 const ctx=new ImportContext('html');
 // NUL and unpaired surrogates are replaced, as a browser's decoder would.
 const clean=text.replace(/\0|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,REPLACEMENT).replace(/\r\n?/g,'\n');
 const tree=tokenize(clean,ctx,caps);
 return finishImport(new Converter(ctx).flow(tree),ctx,resolved);
}
