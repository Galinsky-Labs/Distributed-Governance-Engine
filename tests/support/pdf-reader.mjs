/**
 * Independent, test-only PDF reader: classic xref tables, indirect objects,
 * Flate streams (node:zlib), content stream tokenising, ToUnicode text
 * extraction and marked-content tracking. Deliberately shares no code with
 * src/export so the tests check the writer against a separate implementation.
 */
import {inflateSync} from 'node:zlib';

export class Ref {constructor(num,gen){this.num=num;this.gen=gen;}}
export class Name {constructor(value){this.value=value;}}
const WS=new Set([0,9,10,12,13,32]);
const DELIM=new Set('()<>[]{}/%'.split('').map(c=>c.charCodeAt(0)));

class Lexer {
 constructor(bytes,pos=0){this.b=bytes;this.pos=pos;}
 skip() {
  for(;;) {
   while(this.pos<this.b.length&&WS.has(this.b[this.pos]))this.pos++;
   if(this.b[this.pos]===0x25){while(this.pos<this.b.length&&this.b[this.pos]!==10&&this.b[this.pos]!==13)this.pos++;continue;}
   return;
  }
 }
 regular() {const start=this.pos;while(this.pos<this.b.length&&!WS.has(this.b[this.pos])&&!DELIM.has(this.b[this.pos]))this.pos++;return Buffer.from(this.b.subarray(start,this.pos)).toString('latin1');}
 literal() {
  this.pos++;let depth=1;const out=[];
  while(this.pos<this.b.length) {
   const c=this.b[this.pos++];
   if(c===0x5c) {
    const n=this.b[this.pos++];const map={110:10,114:13,116:9,98:8,102:12,40:40,41:41,92:92};
    if(n in map)out.push(map[n]);
    else if(n>=0x30&&n<=0x37){let v=n-0x30;for(let i=0;i<2&&this.b[this.pos]>=0x30&&this.b[this.pos]<=0x37;i++)v=v*8+this.b[this.pos++]-0x30;out.push(v&255);}
    else if(n===13){if(this.b[this.pos]===10)this.pos++;}
    else if(n!==10)out.push(n);
   } else if(c===0x28){depth++;out.push(c);}
   else if(c===0x29){if(--depth===0)break;out.push(c);}
   else out.push(c);
  }
  return Uint8Array.from(out);
 }
 hex() {
  this.pos++;let s='';
  while(this.b[this.pos]!==0x3e){const c=this.b[this.pos++];if(!WS.has(c))s+=String.fromCharCode(c);}
  this.pos++;if(s.length%2)s+='0';
  return Uint8Array.from(s.match(/../g)??[],h=>parseInt(h,16));
 }
 /** Next token: {type:'value'|'op'|'end', value}. */
 token() {
  this.skip();
  if(this.pos>=this.b.length)return {type:'eof'};
  const c=this.b[this.pos];
  if(c===0x2f){this.pos++;return {type:'value',value:new Name(this.regular().replace(/#([0-9a-fA-F]{2})/g,(_,h)=>String.fromCharCode(parseInt(h,16))))};}
  if(c===0x28)return {type:'value',value:{string:this.literal()}};
  if(c===0x3c&&this.b[this.pos+1]===0x3c){this.pos+=2;return {type:'dict'};}
  if(c===0x3e&&this.b[this.pos+1]===0x3e){this.pos+=2;return {type:'enddict'};}
  if(c===0x3c)return {type:'value',value:{string:this.hex(),hex:true}};
  if(c===0x5b){this.pos++;return {type:'array'};}
  if(c===0x5d){this.pos++;return {type:'endarray'};}
  const word=this.regular();
  if(word==='')throw new Error('Unexpected byte '+c+' at '+this.pos);
  if(/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word))return {type:'value',value:Number(word)};
  if(word==='true'||word==='false')return {type:'value',value:word==='true'};
  if(word==='null')return {type:'value',value:null};
  return {type:'op',value:word};
 }
 /** Parses one object, resolving `n g R` references. */
 object(first=this.token()) {
  if(first.type==='value') {
   if(typeof first.value==='number'&&Number.isInteger(first.value)) {
    const save=this.pos,a=this.token();
    if(a.type==='value'&&Number.isInteger(a.value)){const r=this.token();if(r.type==='op'&&r.value==='R')return new Ref(first.value,a.value);}
    this.pos=save;
   }
   return first.value;
  }
  if(first.type==='array'){const out=[];for(;;){const t=this.token();if(t.type==='endarray')return out;out.push(this.object(t));}}
  if(first.type==='dict') {
   const out=new Map();
   for(;;){const t=this.token();if(t.type==='enddict')return out;if(!(t.value instanceof Name))throw new Error('Dictionary key must be a name');out.set(t.value.value,this.object());}
  }
  throw new Error('Unexpected token '+JSON.stringify(first));
 }
}

const latin1=bytes=>Buffer.from(bytes).toString('latin1');

export class PdfReader {
 constructor(bytes) {
  this.bytes=bytes instanceof Uint8Array?bytes:new Uint8Array(bytes);
  this.text=latin1(this.bytes);
  if(!this.text.startsWith('%PDF-'))throw new Error('Missing PDF header');
  const sx=this.text.lastIndexOf('startxref');
  const xrefOffset=Number(/startxref\s+(\d+)/.exec(this.text.slice(sx))[1]);
  if(this.text.slice(xrefOffset,xrefOffset+4)!=='xref')throw new Error('startxref does not point at an xref table');
  const lines=this.text.slice(xrefOffset).split(/\r\n|\r|\n/);
  const [start,count]=lines[1].trim().split(/\s+/).map(Number);
  this.offsets=new Map();
  for(let i=0;i<count;i++) {
   const raw=this.text.substr(xrefOffset+lines[0].length+1+lines[1].length+1+i*20,20);
   if(raw.length!==20||!/^\d{10} \d{5} [nf](\r\n| \n| \r)$/.test(raw))throw new Error('Malformed xref entry '+i);
   if(raw[17]==='n')this.offsets.set(start+i,Number(raw.slice(0,10)));
  }
  const trailerAt=this.text.indexOf('trailer',xrefOffset);
  this.trailer=new Lexer(this.bytes,trailerAt+7).object();
  this.cache=new Map();
 }
 /** Checks every xref offset points at the matching `n 0 obj` header. */
 verifyXref() {
  for(const [num,offset] of this.offsets) {
   const header=this.text.slice(offset,offset+String(num).length+6);
   if(header!==num+' 0 obj')throw new Error('xref offset for object '+num+' is wrong');
  }
  return this.offsets.size;
 }
 object(num) {
  if(this.cache.has(num))return this.cache.get(num);
  const offset=this.offsets.get(num);if(offset===undefined)throw new Error('Unknown object '+num);
  const lx=new Lexer(this.bytes,offset);
  lx.token();lx.token();const objKeyword=lx.token();if(objKeyword.value!=='obj')throw new Error('Bad object header');
  let value=lx.object();
  const save=lx.pos,next=lx.token();
  if(next.type==='op'&&next.value==='stream') {
   let p=lx.pos;if(this.bytes[p]===13)p++;if(this.bytes[p]===10)p++;
   const length=this.resolve(value.get('Length'));
   const raw=this.bytes.subarray(p,p+length);
   if(!latin1(this.bytes.subarray(p+length,p+length+20)).match(/^\r?\n?endstream/))throw new Error('Stream length mismatch in object '+num);
   value={dict:value,raw};
  } else lx.pos=save;
  this.cache.set(num,value);return value;
 }
 resolve(value){return value instanceof Ref?this.object(value.num):value;}
 get(dict,key){return dict instanceof Map?this.resolve(dict.get(key)):undefined;}
 streamData(stream) {
  const filter=this.resolve(stream.dict.get('Filter'));
  const names=filter===undefined?[]:Array.isArray(filter)?filter:[filter];
  let data=stream.raw;
  for(const f of names){if(f.value!=='FlateDecode')throw new Error('Unsupported filter '+f.value);data=new Uint8Array(inflateSync(data));}
  return data;
 }
 /** All objects, with stream data inflated, for byte-level scans. */
 *allObjects() {for(const num of this.offsets.keys())yield [num,this.object(num)];}
 get catalog(){return this.resolve(this.trailer.get('Root'));}
 pages() {
  const out=[];
  const walk=node=>{const n=this.resolve(node);if(n.get('Type').value==='Pages')for(const kid of this.resolve(n.get('Kids')))walk(kid);else out.push({ref:node,dict:n});};
  walk(this.catalog.get('Pages'));return out;
 }
 /** Decodes a font's ToUnicode CMap into code → string. */
 toUnicode(font) {
  const stream=this.get(font,'ToUnicode');if(!stream)throw new Error('Font without ToUnicode');
  const text=latin1(this.streamData(stream)),map=new Map();
  for(const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g))
   for(const m of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g))map.set(parseInt(m[1],16),utf16(m[2]));
  for(const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g))
   for(const m of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)){const a=parseInt(m[1],16),b=parseInt(m[2],16),base=parseInt(m[3],16);for(let c=a;c<=b;c++)map.set(c,String.fromCharCode(base+c-a));}
  return map;
 }
 /**
  * Interprets a page's content stream. Returns marked-content segments in paint order:
  * {mcid|null, artifact, tag, text, actualText, hasText} plus counts of text shown outside any marked content.
  */
 pageContent(page) {
  const fonts=this.get(this.get(page.dict,'Resources'),'Font')??new Map();
  const maps=new Map();
  const data=this.streamData(this.get(page.dict,'Contents'));
  const lx=new Lexer(data);const stack=[],segments=[],operands=[];let font=null,untagged=0;
  const decode=bytes=>{
   if(!maps.has(font))maps.set(font,this.toUnicode(this.resolve(fonts.get(font))));
   const map=maps.get(font);let s='';
   for(let i=0;i+1<bytes.length;i+=2){const code=bytes[i]<<8|bytes[i+1];s+=map.get(code)??'�';}
   return s;
  };
  for(;;) {
   const t=lx.token();
   if(t.type==='eof')break;
   if(t.type!=='op'){operands.push(lx.object(t));continue;}
   const op=t.value;
   if(op==='BDC'||op==='BMC') {
    const props=op==='BDC'?this.resolve(operands[1]):null;
    const segment={tag:operands[0].value,mcid:props?.get?.('MCID')??null,artifact:operands[0].value==='Artifact',text:'',actualText:props?.get?.('ActualText')?decodeTextString(props.get('ActualText').string):null,hasText:false};
    stack.push(segment);segments.push(segment);
   } else if(op==='EMC')stack.pop();
   else if(op==='Tf')font=operands[0].value;
   else if(op==='Tj'||op==='TJ') {
    const strings=op==='Tj'?[operands[0]]:operands[0].filter(x=>x&&x.string);
    const text=strings.map(s=>decode(s.string)).join('');
    const top=stack.at(-1);
    if(!top)untagged++;else{top.text+=text;top.hasText=true;}
   }
   operands.length=0;
  }
  return {segments,untagged,raw:latin1(data)};
 }
}

const utf16=hex=>{let s='';for(let i=0;i<hex.length;i+=4)s+=String.fromCharCode(parseInt(hex.slice(i,i+4),16));return s;};
/** PDF text string bytes → JS string (UTF-16BE with BOM or PDFDocEncoding ≈ Latin-1). */
export function decodeTextString(bytes) {
 if(bytes[0]===0xfe&&bytes[1]===0xff){let s='';for(let i=2;i+1<bytes.length;i+=2)s+=String.fromCharCode(bytes[i]<<8|bytes[i+1]);return s;}
 return latin1(bytes);
}

/**
 * Walks the structure tree. Returns elements {type, title, kids:[element|{page, mcid}|{objr}], page refs}
 * and a function resolving the text of an element from page content.
 */
export function readStructure(reader) {
 const pages=reader.pages(),pageIndex=new Map(pages.map((p,i)=>[p.ref.num,i]));
 const content=pages.map(p=>reader.pageContent(p));
 const mcidText=pages.map((_,i)=>new Map(content[i].segments.filter(s=>s.mcid!==null).map(s=>[s.mcid,s])));
 const root=reader.get(reader.catalog,'StructTreeRoot');
 const referenced=pages.map(()=>new Set());
 const walk=(ref,parentPage)=>{
  const dict=reader.resolve(ref);
  const page=dict.get('Pg')?pageIndex.get(dict.get('Pg').num):parentPage;
  const element={type:dict.get('S').value,title:dict.get('T')?decodeTextString(dict.get('T').string):null,alt:dict.get('Alt')?decodeTextString(dict.get('Alt').string):null,kids:[],num:ref.num};
  let kids=reader.resolve(dict.get('K'));if(!Array.isArray(kids))kids=[kids];
  for(const kid of kids) {
   if(typeof kid==='number'){element.kids.push({page,mcid:kid});referenced[page].add(kid);}
   else{
    const k=reader.resolve(kid);
    const type=k.get('Type')?.value;
    if(type==='MCR'){const p=pageIndex.get(k.get('Pg').num);element.kids.push({page:p,mcid:k.get('MCID')});referenced[p].add(k.get('MCID'));}
    else if(type==='OBJR')element.kids.push({objr:k.get('Obj')});
    else element.kids.push(walk(kid,page));
   }
  }
  return element;
 };
 let top=reader.resolve(root.get('K'));if(!Array.isArray(top))top=[top];
 const elements=top.map(k=>walk(k,0));
 const INLINE=new Set(['Link','Span','Lbl','Reference','Note']);
 const textOf=(element,{skip=()=>false}={})=>{
  let out='';
  for(const kid of element.kids) {
   if(kid.mcid!==undefined){const s=mcidText[kid.page].get(kid.mcid);out+=s?(s.actualText??s.text):'';}
   else if(kid.type){if(skip(kid))continue;const inner=textOf(kid,{skip});out+=INLINE.has(kid.type)&&kid.type!=='Note'?inner:' '+inner+' ';}
  }
  return out;
 };
 const firstPage=element=>{for(const kid of element.kids){if(kid.mcid!==undefined)return kid.page;if(kid.type){const p=firstPage(kid);if(p!==null)return p;}}return null;};
 return {elements,content,mcidText,referenced,textOf,firstPage,pages};
}

export const collapse=text=>text.replace(/\s+/g,' ').trim();
export function findAll(element,predicate,out=[]) {
 if(predicate(element))out.push(element);
 for(const kid of element.kids)if(kid.type)findAll(kid,predicate,out);
 return out;
}
