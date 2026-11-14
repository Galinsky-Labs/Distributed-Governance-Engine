// Limited, dependency-free PDF text-layer extractor. It never runs JavaScript, follows actions or
// URIs, opens embedded files or performs OCR; the result is always provisional and needs review.
import {fail,ImportError} from './errors.mjs';
import {boundedInflate} from './inflate.mjs';
import {ImportContext,resolveOptions,finishImport} from './build.mjs';
import {plainTextBlocks} from './text.mjs';
import {LEGAL_LIMITS} from '../legal-structure.mjs';

export const PDF_DEFAULT_LIMITS=Object.freeze({maxObjects:200000,maxPages:2000,maxInflatedBytes:100*1024*1024,maxOperators:10000000});
const PROVISIONAL_REASON='Text was extracted from the PDF text layer. PDF does not record legal structure, so sections, lists and paragraph boundaries were inferred from layout and must be reviewed against the original. OCR is not implemented: text that exists only as images (for example scanned pages) was not imported.';
const MAX_NESTING=64,MAX_REF_HOPS=32,MAX_FORM_DEPTH=8,MAX_CMAP_ENTRIES=100000,MAX_ANNOTATIONS=1000;
const unsupported=message=>fail('PDF_UNSUPPORTED',message);

class Name{constructor(name){this.name=name;}}
class Ref{constructor(num,gen){this.num=num;this.gen=gen;}}
class Keyword{constructor(word){this.word=word;}}
class Stream{constructor(dict,raw){this.dict=dict;this.raw=raw;}}

const isWhite=b=>b===0||b===9||b===10||b===12||b===13||b===32;
const isDelimiter=b=>b===40||b===41||b===60||b===62||b===91||b===93||b===123||b===125||b===47||b===37;
const latin1=bytes=>{let s='';for(let i=0;i<bytes.length;i+=8192)s+=String.fromCharCode(...bytes.subarray(i,i+8192));return s;};
const ENDSTREAM=Uint8Array.from('endstream',c=>c.charCodeAt(0));
function findBytes(bytes,needle,from) {
 outer:for(let i=from;i+needle.length<=bytes.length;i++) {
  for(let j=0;j<needle.length;j++)if(bytes[i+j]!==needle[j])continue outer;
  return i;
 }
 return -1;
}
const hexValue=b=>b>=48&&b<=57?b-48:b>=65&&b<=70?b-55:b>=97&&b<=102?b-87:-1;

class Lexer {
 constructor(bytes,pos=0,end=bytes.length){this.bytes=bytes;this.pos=pos;this.end=end;}
 skipSpace() {
  const {bytes}=this;
  while(this.pos<this.end) {
   const b=bytes[this.pos];
   if(isWhite(b))this.pos++;
   else if(b===37){while(this.pos<this.end&&bytes[this.pos]!==10&&bytes[this.pos]!==13)this.pos++;}
   else break;
  }
 }
 /** Next token, or undefined at end. Structural tokens are Keywords ('[', ']', '<<', '>>', '{', '}'). */
 token() {
  this.skipSpace();
  if(this.pos>=this.end)return undefined;
  const {bytes}=this,b=bytes[this.pos];
  if(b===40)return this.literalString();
  if(b===60){
   if(bytes[this.pos+1]===60){this.pos+=2;return new Keyword('<<');}
   return this.hexString();
  }
  if(b===62){
   if(bytes[this.pos+1]===62){this.pos+=2;return new Keyword('>>');}
   this.pos++;return new Keyword('>');
  }
  if(b===91||b===93||b===123||b===125){this.pos++;return new Keyword(String.fromCharCode(b));}
  if(b===47)return this.name();
  if(b===41){this.pos++;return new Keyword(')');}
  const start=this.pos;
  while(this.pos<this.end&&!isWhite(bytes[this.pos])&&!isDelimiter(bytes[this.pos]))this.pos++;
  const word=latin1(bytes.subarray(start,this.pos));
  if(/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(word))return Number(word);
  if(word==='true')return true;
  if(word==='false')return false;
  if(word==='null')return null;
  return new Keyword(word);
 }
 name() {
  const {bytes}=this;this.pos++;
  let out='';
  while(this.pos<this.end&&!isWhite(bytes[this.pos])&&!isDelimiter(bytes[this.pos])) {
   const b=bytes[this.pos];
   if(b===35&&hexValue(bytes[this.pos+1])>=0&&hexValue(bytes[this.pos+2])>=0){out+=String.fromCharCode(hexValue(bytes[this.pos+1])*16+hexValue(bytes[this.pos+2]));this.pos+=3;}
   else{out+=String.fromCharCode(b);this.pos++;}
  }
  return new Name(out);
 }
 hexString() {
  const {bytes}=this;this.pos++;
  const out=[];let high=-1;
  while(this.pos<this.end&&bytes[this.pos]!==62) {
   const v=hexValue(bytes[this.pos++]);
   if(v<0)continue;
   if(high<0)high=v;else{out.push(high*16+v);high=-1;}
  }
  if(this.pos>=this.end)unsupported('Unterminated hex string');
  this.pos++;
  if(high>=0)out.push(high*16);
  return Uint8Array.from(out);
 }
 literalString() {
  const {bytes}=this;this.pos++;
  const out=[];let depth=1;
  while(this.pos<this.end) {
   const b=bytes[this.pos++];
   if(b===92) {
    const e=bytes[this.pos++];
    if(e===undefined)break;
    if(e===110)out.push(10);else if(e===114)out.push(13);else if(e===116)out.push(9);else if(e===98)out.push(8);else if(e===102)out.push(12);
    else if(e>=48&&e<=55) {
     let v=e-48;
     for(let i=0;i<2&&bytes[this.pos]>=48&&bytes[this.pos]<=55;i++)v=v*8+bytes[this.pos++]-48;
     out.push(v&255);
    } else if(e===13){if(bytes[this.pos]===10)this.pos++;}
    else if(e!==10)out.push(e);
   } else if(b===40){depth++;out.push(b);}
   else if(b===41){if(--depth===0)return Uint8Array.from(out);out.push(b);}
   else out.push(b);
  }
  unsupported('Unterminated literal string');
 }
}

/** Parse one value. `allowRefs` is false inside content streams, where "1 0 R" is not a reference. */
function parseValue(lexer,token,allowRefs,depth=0) {
 if(depth>MAX_NESTING)unsupported('PDF objects are nested too deeply');
 if(token instanceof Keyword) {
  if(token.word==='[') {
   const items=[];
   for(;;) {
    const next=lexer.token();
    if(next===undefined)unsupported('Unterminated array');
    if(next instanceof Keyword&&next.word===']')return items;
    items.push(parseValue(lexer,next,allowRefs,depth+1));
   }
  }
  if(token.word==='<<') {
   const dict=new Map();
   for(;;) {
    const key=lexer.token();
    if(key===undefined)unsupported('Unterminated dictionary');
    if(key instanceof Keyword&&key.word==='>>')return dict;
    if(!(key instanceof Name))unsupported('Dictionary key is not a name');
    const valueToken=lexer.token();
    if(valueToken===undefined)unsupported('Unterminated dictionary');
    dict.set(key.name,parseValue(lexer,valueToken,allowRefs,depth+1));
   }
  }
  return token;
 }
 if(allowRefs&&Number.isInteger(token)&&token>=0) {
  const save=lexer.pos;
  const gen=lexer.token();
  if(Number.isInteger(gen)&&gen>=0) {
   const r=lexer.token();
   if(r instanceof Keyword&&r.word==='R')return new Ref(token,gen);
  }
  lexer.pos=save;
 }
 return token;
}

const name=value=>value instanceof Name?value.name:null;
const dictOf=value=>value instanceof Map?value:value instanceof Stream?value.dict:null;
const num=(value,fallback=0)=>typeof value==='number'&&Number.isFinite(value)?value:fallback;

function pngUnpredict(data,{colors,bitsPerComponent,columns}) {
 const bpp=Math.max(1,Math.ceil(colors*bitsPerComponent/8)),rowLength=Math.ceil(columns*colors*bitsPerComponent/8);
 if(rowLength<1||rowLength>1e6)unsupported('Invalid predictor parameters');
 const rows=Math.floor(data.length/(rowLength+1));
 const out=new Uint8Array(rows*rowLength);
 for(let r=0;r<rows;r++) {
  const filter=data[r*(rowLength+1)],src=r*(rowLength+1)+1,dst=r*rowLength;
  for(let i=0;i<rowLength;i++) {
   const raw=data[src+i],left=i>=bpp?out[dst+i-bpp]:0,up=r>0?out[dst-rowLength+i]:0,upLeft=r>0&&i>=bpp?out[dst-rowLength+i-bpp]:0;
   let value;
   if(filter===0)value=raw;
   else if(filter===1)value=raw+left;
   else if(filter===2)value=raw+up;
   else if(filter===3)value=raw+((left+up)>>1);
   else if(filter===4){const p=left+up-upLeft,pa=Math.abs(p-left),pb=Math.abs(p-up),pc=Math.abs(p-upLeft);value=raw+(pa<=pb&&pa<=pc?left:pb<=pc?up:upLeft);}
   else unsupported('Unknown PNG predictor');
   out[dst+i]=value&255;
  }
 }
 return out;
}

class PdfDocument {
 constructor(bytes,caps,ctx) {
  this.bytes=bytes;this.caps=caps;this.ctx=ctx;
  this.entries=new Map();this.cache=new Map();this.loading=new Set();
  this.inflated=0;this.trailer=null;this.scanned=null;
 }
 async open() {
  if(latin1(this.bytes.subarray(0,1024)).indexOf('%PDF-')===-1)unsupported('Missing PDF header');
  try{await this.readXrefChain();}
  catch(error){if(!(error instanceof ImportError)||error.code!=='PDF_UNSUPPORTED')throw error;this.entries.clear();this.trailer=null;}
  if(!this.trailer||!this.trailer.has('Root'))await this.reconstruct();
  if(this.trailer.has('Encrypt'))fail('PDF_ENCRYPTED','Encrypted PDFs cannot be imported');
 }
 addEntry(num,entry) {
  if(this.entries.has(num))return;
  if(this.entries.size>=this.caps.maxObjects)fail('DOCUMENT_TOO_LARGE','PDF has too many objects');
  this.entries.set(num,entry);
 }
 async readXrefChain() {
  const tail=latin1(this.bytes.subarray(Math.max(0,this.bytes.length-2048)));
  const at=tail.lastIndexOf('startxref');
  if(at===-1)unsupported('startxref not found');
  let offset=Number.parseInt(tail.slice(at+9).trim(),10);
  const seen=new Set();
  while(Number.isSafeInteger(offset)&&offset>=0&&offset<this.bytes.length&&!seen.has(offset)) {
   seen.add(offset);
   const trailer=await this.readXrefSection(offset);
   this.trailer??=trailer;
   const xrefStream=trailer.get('XRefStm');
   if(Number.isInteger(xrefStream)&&!seen.has(xrefStream)){seen.add(xrefStream);await this.readXrefSection(xrefStream);}
   offset=trailer.get('Prev');
  }
 }
 async readXrefSection(offset) {
  const lexer=new Lexer(this.bytes,offset);
  const first=lexer.token();
  if(first instanceof Keyword&&first.word==='xref') {
   for(;;) {
    const start=lexer.token();
    if(start instanceof Keyword&&start.word==='trailer')break;
    const count=lexer.token();
    if(!Number.isInteger(start)||!Number.isInteger(count)||start<0||count<0)unsupported('Malformed xref table');
    if(count>this.caps.maxObjects)fail('DOCUMENT_TOO_LARGE','PDF has too many objects');
    for(let i=0;i<count;i++) {
     const position=lexer.token(),gen=lexer.token(),kind=lexer.token();
     if(!Number.isInteger(position)||!Number.isInteger(gen)||!(kind instanceof Keyword))unsupported('Malformed xref entry');
     if(kind.word==='n')this.addEntry(start+i,{type:1,offset:position,gen});
     else if(kind.word==='f')this.addEntry(start+i,{type:0});
     else unsupported('Malformed xref entry');
    }
   }
   const trailer=parseValue(lexer,lexer.token(),true);
   if(!(trailer instanceof Map))unsupported('Malformed trailer');
   return trailer;
  }
  const object=await this.parseIndirectAt(offset,null);
  if(!(object instanceof Stream)||name(object.dict.get('Type'))!=='XRef')unsupported('Malformed cross-reference stream');
  await this.readXrefStream(object);
  return object.dict;
 }
 async readXrefStream(stream) {
  const widths=stream.dict.get('W');
  if(!Array.isArray(widths)||widths.length!==3||!widths.every(w=>Number.isInteger(w)&&w>=0&&w<=8))unsupported('Malformed xref stream widths');
  const size=num(stream.dict.get('Size'));
  const index=Array.isArray(stream.dict.get('Index'))?stream.dict.get('Index'):[0,size];
  const data=await this.decode(stream);
  const rowLength=widths[0]+widths[1]+widths[2];
  if(rowLength===0)unsupported('Malformed xref stream widths');
  let pos=0;
  const field=(width,fallback)=>{if(width===0)return fallback;let v=0;for(let i=0;i<width;i++)v=v*256+data[pos++];return v;};
  for(let i=0;i+1<index.length;i+=2) {
   const start=index[i],count=index[i+1];
   if(!Number.isInteger(start)||!Number.isInteger(count)||start<0||count<0)unsupported('Malformed xref stream index');
   if(count>this.caps.maxObjects)fail('DOCUMENT_TOO_LARGE','PDF has too many objects');
   for(let j=0;j<count;j++) {
    if(pos+rowLength>data.length)unsupported('Truncated xref stream');
    const type=field(widths[0],1),a=field(widths[1],0),b=field(widths[2],0);
    if(type===1)this.addEntry(start+j,{type:1,offset:a,gen:b});
    else if(type===2)this.addEntry(start+j,{type:2,stream:a,index:b});
    else this.addEntry(start+j,{type:0});
   }
  }
 }
 /** Rebuild the object table by scanning for "n g obj" when cross-references are unusable. */
 async reconstruct() {
  this.scanned=true;
  const text=latin1(this.bytes);
  this.entries.clear();this.cache.clear();
  const offsets=new Map();
  for(const match of text.matchAll(/(?<![0-9])(\d{1,10})[ \t\r\n\f\0]+(\d{1,5})[ \t\r\n\f\0]+obj\b/g)) {
   offsets.set(Number(match[1]),match.index);
   if(offsets.size>this.caps.maxObjects)fail('DOCUMENT_TOO_LARGE','PDF has too many objects');
  }
  for(const [n,offset] of offsets)this.entries.set(n,{type:1,offset,gen:0});
  let trailer=null;
  for(let at=text.lastIndexOf('trailer');at!==-1&&!trailer;at=text.lastIndexOf('trailer',at-1)) {
   try{const lexer=new Lexer(this.bytes,at+7);const value=parseValue(lexer,lexer.token(),true);if(value instanceof Map&&value.has('Root'))trailer=value;}
   catch(error){if(!(error instanceof ImportError))throw error;}
  }
  for(const [n] of offsets) {
   const object=await this.tryObject(n);
   const dict=dictOf(object);
   if(!dict)continue;
   if(object instanceof Stream&&name(dict.get('Type'))==='ObjStm')await this.registerObjectStream(n,object);
   if(!trailer&&name(dict.get('Type'))==='XRef'&&dict.has('Root'))trailer=dict;
   if(!trailer&&name(dict.get('Type'))==='Catalog')trailer=new Map([['Root',new Ref(n,0)]]);
   if(dict.has('Encrypt')&&name(dict.get('Type'))==='XRef')trailer=dict;
  }
  if(!trailer)unsupported('PDF document catalog not found');
  if(trailer.has('Encrypt'))fail('PDF_ENCRYPTED','Encrypted PDFs cannot be imported');
  this.trailer=trailer;
 }
 async tryObject(n) {
  try{return await this.get(n);}catch(error){if(error instanceof ImportError&&error.code==='PDF_UNSUPPORTED')return null;throw error;}
 }
 async registerObjectStream(n,stream) {
  let data;
  try{data=await this.decode(stream);}
  catch(error){if(error instanceof ImportError&&error.code==='PDF_UNSUPPORTED')return;throw error;}
  const count=num(stream.dict.get('N'));
  const lexer=new Lexer(data);
  for(let i=0;i<count&&i<this.caps.maxObjects;i++) {
   const objNum=lexer.token();lexer.token();
   if(!Number.isInteger(objNum))break;
   if(!this.entries.has(objNum))this.addEntry(objNum,{type:2,stream:n,index:i});
  }
 }
 async parseIndirectAt(offset,expected) {
  const lexer=new Lexer(this.bytes,offset);
  const n=lexer.token(),gen=lexer.token(),keyword=lexer.token();
  if(!Number.isInteger(n)||!Number.isInteger(gen)||!(keyword instanceof Keyword)||keyword.word!=='obj'||(expected!==null&&n!==expected))unsupported('Object not found at its cross-reference offset');
  const value=parseValue(lexer,lexer.token(),true);
  if(!(value instanceof Map))return value;
  const save=lexer.pos;
  const next=lexer.token();
  if(!(next instanceof Keyword)||next.word!=='stream'){lexer.pos=save;return value;}
  let start=lexer.pos;
  if(this.bytes[start]===13)start++;
  if(this.bytes[start]===10)start++;
  let length=value.get('Length');
  if(length instanceof Ref)length=this.loading.has(length.num)?null:await this.get(length.num);
  let end=Number.isInteger(length)&&length>=0?start+length:-1;
  const endsCleanly=end>=0&&end<=this.bytes.length&&latin1(this.bytes.subarray(end,Math.min(end+20,this.bytes.length))).trimStart().startsWith('endstream');
  if(!endsCleanly) {
   end=findBytes(this.bytes,ENDSTREAM,start);
   if(end===-1)unsupported('Unterminated stream');
   if(this.bytes[end-1]===10)end--;
   if(this.bytes[end-1]===13)end--;
  }
  return new Stream(value,this.bytes.subarray(start,Math.max(start,end)));
 }
 async get(n) {
  if(this.cache.has(n))return this.cache.get(n);
  const entry=this.entries.get(n);
  if(!entry||entry.type===0)return null;
  if(this.loading.has(n))unsupported('Circular object reference');
  this.loading.add(n);
  try {
   let value;
   if(entry.type===1) {
    try{value=await this.parseIndirectAt(entry.offset,n);}
    catch(error) {
     if(!(error instanceof ImportError)||error.code!=='PDF_UNSUPPORTED'||this.scanned)throw error;
     await this.reconstruct();
     this.loading.delete(n);
     return this.get(n);
    }
   } else {
    const container=this.entries.get(entry.stream);
    if(!container||container.type!==1)unsupported('Object stream is missing');
    const stream=await this.get(entry.stream);
    if(!(stream instanceof Stream))unsupported('Object stream is missing');
    value=await this.objectFromStream(stream,entry.index,n);
   }
   this.cache.set(n,value);
   return value;
  } finally {this.loading.delete(n);}
 }
 async objectFromStream(stream,index,expected) {
  const data=await this.decode(stream),count=num(stream.dict.get('N')),first=num(stream.dict.get('First'));
  if(!Number.isInteger(index)||index>=count||!Number.isInteger(first)||first<0||first>data.length)unsupported('Malformed object stream');
  const header=new Lexer(data,0,first);
  let offset=null;
  for(let i=0;i<=index;i++) {
   const objNum=header.token(),objOffset=header.token();
   if(!Number.isInteger(objNum)||!Number.isInteger(objOffset))unsupported('Malformed object stream header');
   if(i===index){if(objNum!==expected)unsupported('Object stream entry mismatch');offset=objOffset;}
  }
  const lexer=new Lexer(data,first+offset);
  if(lexer.pos>data.length)unsupported('Malformed object stream offset');
  return parseValue(lexer,lexer.token(),true);
 }
 async resolve(value) {
  for(let hops=0;value instanceof Ref;hops++) {
   if(hops>MAX_REF_HOPS)unsupported('Reference chain is too long');
   value=await this.get(value.num);
  }
  return value;
 }
 async decode(stream) {
  if(stream.decoded)return stream.decoded;
  const filters=await this.resolve(stream.dict.get('Filter'));
  const list=filters===undefined||filters===null?[]:Array.isArray(filters)?filters:[filters];
  const paramsValue=await this.resolve(stream.dict.get('DecodeParms'));
  const params=Array.isArray(paramsValue)?paramsValue:[paramsValue];
  let data=stream.raw;
  for(let i=0;i<list.length;i++) {
   const filter=name(await this.resolve(list[i]));
   if(filter!=='FlateDecode'&&filter!=='Fl')unsupported('Unsupported PDF stream filter');
   const remaining=this.caps.maxInflatedBytes-this.inflated;
   data=await boundedInflate(data,'deflate',{maxBytes:remaining,invalidCode:'PDF_UNSUPPORTED',limitCode:'DOCUMENT_TOO_LARGE',limitMessage:'PDF streams inflate beyond the import limit',onTrailingJunk:'accept'});
   this.inflated+=data.length;
   const parms=dictOf(await this.resolve(params[i]));
   const predictor=num(parms?.get('Predictor'),1);
   if(predictor>=10)data=pngUnpredict(data,{colors:Math.max(1,num(parms.get('Colors'),1)),bitsPerComponent:Math.max(1,num(parms.get('BitsPerComponent'),8)),columns:Math.max(1,num(parms.get('Columns'),1))});
   else if(predictor!==1)unsupported('Unsupported stream predictor');
  }
  stream.decoded=data;
  return data;
 }
}

const STANDARD_HIGH={0xA1:'\u00A1',0xA2:'\u00A2',0xA3:'\u00A3',0xA4:'\u2044',0xA5:'\u00A5',0xA6:'\u0192',0xA7:'\u00A7',0xA8:'\u00A4',0xA9:"'",0xAA:'\u201C',0xAB:'\u00AB',0xAC:'\u2039',0xAD:'\u203A',0xAE:'\uFB01',0xAF:'\uFB02',0xB1:'\u2013',0xB2:'\u2020',0xB3:'\u2021',0xB4:'\u00B7',0xB6:'\u00B6',0xB7:'\u2022',0xB8:'\u201A',0xB9:'\u201E',0xBA:'\u201D',0xBB:'\u00BB',0xBC:'\u2026',0xBD:'\u2030',0xBF:'\u00BF',0xC1:'`',0xC2:'\u00B4',0xC3:'\u02C6',0xC4:'\u02DC',0xC5:'\u00AF',0xC6:'\u02D8',0xC7:'\u02D9',0xC8:'\u00A8',0xCA:'\u02DA',0xCB:'\u00B8',0xCD:'\u02DD',0xCE:'\u02DB',0xCF:'\u02C7',0xD0:'\u2014',0xE1:'\u00C6',0xE3:'\u00AA',0xE8:'\u0141',0xE9:'\u00D8',0xEA:'\u0152',0xEB:'\u00BA',0xF1:'\u00E6',0xF5:'\u0131',0xF8:'\u0142',0xF9:'\u00F8',0xFA:'\u0153',0xFB:'\u00DF'};
const WIN_ANSI=new TextDecoder('windows-1252'),MAC_ROMAN=new TextDecoder('macintosh'),UTF16BE=new TextDecoder('utf-16be');
function baseEncoding(encodingName) {
 const table=new Array(256).fill(null);
 for(let code=32;code<256;code++) {
  if(encodingName==='WinAnsiEncoding')table[code]=code===127?null:WIN_ANSI.decode(Uint8Array.of(code));
  else if(encodingName==='MacRomanEncoding')table[code]=code===127?null:MAC_ROMAN.decode(Uint8Array.of(code));
  else table[code]=code<127?(code===0x27?'\u2019':code===0x60?'\u2018':String.fromCharCode(code)):STANDARD_HIGH[code]??null;
 }
 return table;
}
const GLYPHS={space:' ',exclam:'!',quotedbl:'"',numbersign:'#',dollar:'$',percent:'%',ampersand:'&',quotesingle:"'",parenleft:'(',parenright:')',asterisk:'*',plus:'+',comma:',',hyphen:'-',period:'.',slash:'/',colon:':',semicolon:';',less:'<',equal:'=',greater:'>',question:'?',at:'@',bracketleft:'[',backslash:'\\',bracketright:']',asciicircum:'^',underscore:'_',grave:'`',braceleft:'{',bar:'|',braceright:'}',asciitilde:'~',
 zero:'0',one:'1',two:'2',three:'3',four:'4',five:'5',six:'6',seven:'7',eight:'8',nine:'9',quoteleft:'\u2018',quoteright:'\u2019',quotedblleft:'\u201C',quotedblright:'\u201D',quotesinglbase:'\u201A',quotedblbase:'\u201E',endash:'\u2013',emdash:'\u2014',bullet:'\u2022',ellipsis:'\u2026',section:'\u00A7',paragraph:'\u00B6',copyright:'\u00A9',registered:'\u00AE',trademark:'\u2122',degree:'\u00B0',dagger:'\u2020',daggerdbl:'\u2021',
 fi:'fi',fl:'fl',ff:'ff',ffi:'ffi',ffl:'ffl',nbspace:'\u00A0',minus:'\u2212',multiply:'\u00D7',divide:'\u00F7',germandbls:'\u00DF',AE:'\u00C6',ae:'\u00E6',OE:'\u0152',oe:'\u0153',Oslash:'\u00D8',oslash:'\u00F8',dotlessi:'\u0131',sterling:'\u00A3',yen:'\u00A5',cent:'\u00A2',Euro:'\u20AC',guillemotleft:'\u00AB',guillemotright:'\u00BB',periodcentered:'\u00B7',exclamdown:'\u00A1',questiondown:'\u00BF'};
const ACCENTS={acute:'\u0301',grave:'\u0300',circumflex:'\u0302',dieresis:'\u0308',tilde:'\u0303',ring:'\u030A',cedilla:'\u0327',caron:'\u030C'};
function glyphToUnicode(glyph) {
 const base=glyph.split('.')[0];
 if(Object.hasOwn(GLYPHS,base))return GLYPHS[base];
 if(/^[A-Za-z]$/.test(base))return base;
 let m=/^uni([0-9A-F]{4})$/.exec(base)??/^u([0-9A-F]{4,6})$/.exec(base);
 if(m){const cp=parseInt(m[1],16);if(cp<=0x10ffff&&(cp<0xd800||cp>0xdfff))return String.fromCodePoint(cp);}
 m=/^([A-Za-z])(acute|grave|circumflex|dieresis|tilde|ring|cedilla|caron)$/.exec(base);
 if(m)return (m[1]+ACCENTS[m[2]]).normalize('NFC');
 return null;
}

function bytesToCode(bytes,start,length){let v=0;for(let i=0;i<length;i++)v=v*256+bytes[start+i];return v;}

async function parseToUnicode(doc,stream) {
 const lexer=new Lexer(await doc.decode(stream));
 const map=new Map(),codespace=[];
 const add=(code,text)=>{if(map.size<MAX_CMAP_ENTRIES)map.set(code,text);};
 const unicode=bytes=>UTF16BE.decode(bytes).replace(/\0/g,'');
 for(let token=lexer.token();token!==undefined;token=lexer.token()) {
  if(!(token instanceof Keyword))continue;
  if(token.word==='begincodespacerange') {
   for(let lo=lexer.token();lo instanceof Uint8Array;lo=lexer.token()) {
    const hi=lexer.token();
    if(!(hi instanceof Uint8Array)||lo.length!==hi.length||lo.length<1||lo.length>4)break;
    codespace.push({length:lo.length,lo:bytesToCode(lo,0,lo.length),hi:bytesToCode(hi,0,hi.length)});
   }
  } else if(token.word==='beginbfchar') {
   for(let src=lexer.token();src instanceof Uint8Array;src=lexer.token()) {
    const dst=lexer.token();
    if(src.length>4)continue;
    if(dst instanceof Uint8Array)add(src.length*0x100000000+bytesToCode(src,0,src.length),unicode(dst));
    else if(dst instanceof Name){const text=glyphToUnicode(dst.name);if(text)add(src.length*0x100000000+bytesToCode(src,0,src.length),text);}
   }
  } else if(token.word==='beginbfrange') {
   for(let lo=lexer.token();lo instanceof Uint8Array;lo=lexer.token()) {
    const hi=lexer.token(),dst=parseValue(lexer,lexer.token(),false);
    if(!(hi instanceof Uint8Array)||lo.length!==hi.length||lo.length>4)continue;
    const start=bytesToCode(lo,0,lo.length),end=bytesToCode(hi,0,hi.length),key=lo.length*0x100000000;
    if(end<start||end-start>0xffff)continue;
    for(let code=start;code<=end&&map.size<MAX_CMAP_ENTRIES;code++) {
     if(Array.isArray(dst)){const item=dst[code-start];if(item instanceof Uint8Array)add(key+code,unicode(item));}
     else if(dst instanceof Uint8Array&&dst.length>=2) {
      const out=Uint8Array.from(dst);
      let carry=code-start;
      for(let i=out.length-1;i>=0&&carry;i--){const sum=out[i]+carry;out[i]=sum&255;carry=Math.floor(sum/256);}
      add(key+code,unicode(out));
     }
    }
   }
  }
 }
 if(map.size>=MAX_CMAP_ENTRIES)doc.ctx.warn('CMAP_TRUNCATED','A font character map was too large; some characters may be missing');
 return {map,codespace};
}

/** Font decoding: code splitting, Unicode mapping and glyph widths for spacing heuristics. */
async function loadFont(doc,fontValue) {
 const dict=dictOf(await doc.resolve(fontValue));
 if(!dict)return null;
 const subtype=name(await doc.resolve(dict.get('Subtype')));
 const composite=subtype==='Type0';
 const toUnicodeStream=await doc.resolve(dict.get('ToUnicode'));
 let cmap=null;
 if(toUnicodeStream instanceof Stream) {
  try{cmap=await parseToUnicode(doc,toUnicodeStream);}
  catch(error){if(!(error instanceof ImportError)||error.code!=='PDF_UNSUPPORTED')throw error;doc.ctx.warn('TOUNICODE_UNREADABLE','A font character map could not be read');}
 }
 const widths=new Map();let defaultWidth=composite?1000:500,encoding=null,scale=1;
 if(composite) {
  const descendants=await doc.resolve(dict.get('DescendantFonts'));
  const descendant=dictOf(await doc.resolve(Array.isArray(descendants)?descendants[0]:null));
  if(descendant) {
   defaultWidth=num(await doc.resolve(descendant.get('DW')),1000);
   const w=await doc.resolve(descendant.get('W'));
   if(Array.isArray(w))for(let i=0;i<w.length&&widths.size<MAX_CMAP_ENTRIES;) {
    const first=await doc.resolve(w[i]),second=await doc.resolve(w[i+1]);
    if(!Number.isInteger(first))break;
    if(Array.isArray(second)){second.forEach((value,k)=>widths.set(first+k,num(value,defaultWidth)));i+=2;}
    else{const last=second,value=num(await doc.resolve(w[i+2]),defaultWidth);if(!Number.isInteger(last)||last-first>0xffff)break;for(let c=first;c<=last&&widths.size<MAX_CMAP_ENTRIES;c++)widths.set(c,value);i+=3;}
   }
  }
 } else {
  const firstChar=num(await doc.resolve(dict.get('FirstChar')));
  const list=await doc.resolve(dict.get('Widths'));
  if(Array.isArray(list))for(let i=0;i<list.length&&i<256;i++)widths.set(firstChar+i,num(await doc.resolve(list[i]),500));
  const matrix=await doc.resolve(dict.get('FontMatrix'));
  if(subtype==='Type3'&&Array.isArray(matrix))scale=num(matrix[0],0.001)*1000;
  const encodingValue=await doc.resolve(dict.get('Encoding'));
  const encodingDict=dictOf(encodingValue);
  encoding=baseEncoding(name(encodingValue)??name(await doc.resolve(encodingDict?.get('BaseEncoding')))??(subtype==='TrueType'?'WinAnsiEncoding':'StandardEncoding'));
  const differences=await doc.resolve(encodingDict?.get('Differences'));
  if(Array.isArray(differences)) {
   let code=0;
   for(const item of differences) {
    if(typeof item==='number')code=item;
    else if(item instanceof Name){if(code>=0&&code<256)encoding[code]=glyphToUnicode(item.name);code++;}
   }
  }
 }
 const codeLength=(bytes,i)=>{
  if(cmap?.codespace.length) {
   for(const range of cmap.codespace)if(i+range.length<=bytes.length){const code=bytesToCode(bytes,i,range.length);if(code>=range.lo&&code<=range.hi)return range.length;}
   return Math.min(...cmap.codespace.map(range=>range.length));
  }
  return composite?2:1;
 };
 const unmappedComposite=composite&&!cmap;
 return {
  unmappedComposite,
  glyphs(bytes) {
   const out=[];
   for(let i=0;i<bytes.length;) {
    const length=Math.min(codeLength(bytes,i),bytes.length-i);
    const code=bytesToCode(bytes,i,length);
    i+=length;
    let text=cmap?.map.get(length*0x100000000+code);
    if(text===undefined&&!composite)text=encoding[code]??(code<32?'':null);
    out.push({code,text:text??null,width:(widths.get(code)??defaultWidth)*scale/1000,singleByteSpace:length===1&&code===32});
   }
   return out;
  }
 };
}

const multiply=(m,n)=>[m[0]*n[0]+m[1]*n[2],m[0]*n[1]+m[1]*n[3],m[2]*n[0]+m[3]*n[2],m[2]*n[1]+m[3]*n[3],m[4]*n[0]+m[5]*n[2]+n[4],m[4]*n[1]+m[5]*n[3]+n[5]];
const IDENTITY=[1,0,0,1,0,0];

class TextCollector {
 constructor(caps){this.caps=caps;this.lines=[];this.current=null;this.characters=0;this.operators=0;}
 append(text,x,y,size,xEnd) {
  const tolerance=Math.max(1,size*0.3);
  let line=this.current;
  if(!line||Math.abs(line.y-y)>tolerance) {
   line={y,size,text:'',xEnd:x};
   this.lines.push(line);this.current=line;
  } else if(x-line.xEnd>size*0.2&&!/\s$/.test(line.text)&&!/^\s/.test(text))line.text+=' ';
  line.text+=text;line.xEnd=xEnd;line.size=Math.max(line.size,size);
  this.characters+=text.length;
  if(this.characters>LEGAL_LIMITS.bytes)fail('DOCUMENT_TOO_LARGE','The PDF contains more text than the legal schema allows');
 }
 pageBreak(){this.current=null;this.lines.push(null);}
 /** Lines become paragraphs at large vertical gaps, upward jumps and page breaks. */
 text() {
  const paragraphs=[];let paragraph=[],previous=null;
  for(const line of this.lines) {
   if(line===null){if(paragraph.length)paragraphs.push(paragraph);paragraph=[];previous=null;continue;}
   const content=line.text.replace(/\s+$/,'');
   if(!content.trim())continue;
   if(previous) {
    const gap=previous.y-line.y;
    if(gap<0||gap>1.6*Math.max(previous.size,line.size,1)){paragraphs.push(paragraph);paragraph=[];}
   }
   paragraph.push(content);previous=line;
  }
  if(paragraph.length)paragraphs.push(paragraph);
  return paragraphs.map(lines=>lines.join('\n')).join('\n\n');
 }
}

class ContentInterpreter {
 constructor(doc,collector,stats){this.doc=doc;this.collector=collector;this.stats=stats;this.fonts=new Map();}
 async font(resources,fontName) {
  const fonts=dictOf(await this.doc.resolve(resources?.get('Font')));
  const ref=fonts?.get(fontName);
  const key=ref instanceof Ref?ref.num:null;
  if(key!==null&&this.fonts.has(key))return this.fonts.get(key);
  const font=ref===undefined?null:await loadFont(this.doc,ref);
  if(key!==null)this.fonts.set(key,font);
  return font;
 }
 async run(data,resources,depth=0,forms=new Set(),ctm=IDENTITY) {
  const lexer=new Lexer(data);
  const operands=[];
  let state={font:null,size:12,leading:0,charSpacing:0,wordSpacing:0,scale:1,ctm};
  const saved=[];
  let tm=IDENTITY,tlm=IDENTITY;
  const show=bytes=>{
   if(!(bytes instanceof Uint8Array)||!state.font)return;
   if(state.font.unmappedComposite){this.stats.unmappedComposite++;return;}
   // Positions are compared in default user space so flipped or scaled CTMs still read top-down.
   const start=multiply(tm,state.ctm);
   const size=state.size*(Math.hypot(start[2],start[3])||1);
   const x=start[4],y=start[5];
   let text='';
   for(const glyph of state.font.glyphs(bytes)) {
    if(glyph.text===null){text+='\uFFFD';this.stats.unmappedGlyphs++;}
    else text+=glyph.text;
    const advance=(glyph.width*state.size+state.charSpacing+(glyph.singleByteSpace?state.wordSpacing:0))*state.scale;
    tm=[tm[0],tm[1],tm[2],tm[3],tm[4]+advance*tm[0],tm[5]+advance*tm[1]];
   }
   if(text)this.collector.append(text,x,y,size,multiply(tm,state.ctm)[4]);
  };
  const moveLine=(tx,ty)=>{tlm=multiply([1,0,0,1,tx,ty],tlm);tm=tlm;};
  for(let token=lexer.token();token!==undefined;token=lexer.token()) {
   if(!(token instanceof Keyword)||['[','<<'].includes(token.word)) {
    operands.push(parseValue(lexer,token,false));
    if(operands.length>64)operands.shift();
    continue;
   }
   if(++this.collector.operators>this.collector.caps.maxOperators)fail('DOCUMENT_TOO_LARGE','PDF content has too many operations');
   const op=token.word;
   const n=i=>num(operands[operands.length-i]);
   switch(op) {
    case 'q':if(saved.length<MAX_NESTING)saved.push({...state});break;
    case 'Q':if(saved.length)state=saved.pop();break;
    case 'cm':if(operands.length>=6)state.ctm=multiply(operands.slice(-6).map(v=>num(v)),state.ctm);break;
    case 'BT':tm=IDENTITY;tlm=IDENTITY;break;
    case 'Tf':{
     const fontName=name(operands.at(-2));
     state.font=fontName===null?null:await this.font(resources,fontName);
     state.size=n(1)||state.size;break;
    }
    case 'Td':moveLine(n(2),n(1));break;
    case 'TD':state.leading=-n(1);moveLine(n(2),n(1));break;
    case 'Tm':if(operands.length>=6){tlm=operands.slice(-6).map(v=>num(v));tm=tlm;}break;
    case 'T*':moveLine(0,-state.leading);break;
    case 'TL':state.leading=n(1);break;
    case 'Tc':state.charSpacing=n(1);break;
    case 'Tw':state.wordSpacing=n(1);break;
    case 'Tz':state.scale=n(1)/100;break;
    case 'Tj':show(operands.at(-1));break;
    case "'":moveLine(0,-state.leading);show(operands.at(-1));break;
    case '"':state.wordSpacing=n(3);state.charSpacing=n(2);moveLine(0,-state.leading);show(operands.at(-1));break;
    case 'TJ':{
     const items=operands.at(-1);
     if(Array.isArray(items))for(const item of items) {
      if(item instanceof Uint8Array)show(item);
      else if(typeof item==='number'){const shift=-item/1000*state.size*state.scale;tm=[tm[0],tm[1],tm[2],tm[3],tm[4]+shift*tm[0],tm[5]+shift*tm[1]];}
     }
     break;
    }
    case 'Do':await this.xobject(resources,name(operands.at(-1)),depth,forms,state.ctm);break;
    case 'BI':this.inlineImage(lexer);break;
   }
   operands.length=0;
  }
 }
 inlineImage(lexer) {
  this.stats.images++;
  for(let token=lexer.token();token!==undefined;token=lexer.token())if(token instanceof Keyword&&token.word==='ID')break;
  const {bytes}=lexer;
  let pos=lexer.pos+1;
  while(pos+1<lexer.end&&!(bytes[pos]===69&&bytes[pos+1]===73&&isWhite(bytes[pos-1])&&(pos+2>=lexer.end||isWhite(bytes[pos+2])||isDelimiter(bytes[pos+2]))))pos++;
  lexer.pos=Math.min(lexer.end,pos+2);
 }
 async xobject(resources,xname,depth,forms,ctm) {
  if(xname===null)return;
  const xobjects=dictOf(await this.doc.resolve(resources?.get('XObject')));
  const ref=xobjects?.get(xname);
  const object=await this.doc.resolve(ref);
  if(!(object instanceof Stream))return;
  const subtype=name(await this.doc.resolve(object.dict.get('Subtype')));
  if(subtype==='Image'){this.stats.images++;return;}
  if(subtype!=='Form'||depth>=MAX_FORM_DEPTH||(ref instanceof Ref&&forms.has(ref.num)))return;
  const data=await this.streamData(object);
  if(!data)return;
  const formResources=dictOf(await this.doc.resolve(object.dict.get('Resources')))??resources;
  const nested=new Set(forms);if(ref instanceof Ref)nested.add(ref.num);
  const matrix=await this.doc.resolve(object.dict.get('Matrix'));
  const formCtm=Array.isArray(matrix)&&matrix.length===6?multiply(matrix.map(v=>num(v)),ctm):ctm;
  await this.run(data,formResources,depth+1,nested,formCtm);
 }
 async streamData(stream) {
  try{return await this.doc.decode(stream);}
  catch(error) {
   if(!(error instanceof ImportError)||error.code!=='PDF_UNSUPPORTED')throw error;
   this.stats.unreadableStreams++;
   return null;
  }
 }
}

async function collectPages(doc) {
 const catalog=dictOf(await doc.resolve(doc.trailer.get('Root')));
 if(!catalog)unsupported('PDF document catalog is missing');
 const pages=[];const visited=new Set();
 const walk=async(value,inheritedResources,depth)=>{
  if(depth>MAX_NESTING)unsupported('PDF page tree is too deep');
  if(value instanceof Ref){if(visited.has(value.num))return;visited.add(value.num);}
  const node=dictOf(await doc.resolve(value));
  if(!node)return;
  const resources=dictOf(await doc.resolve(node.get('Resources')))??inheritedResources;
  const kids=await doc.resolve(node.get('Kids'));
  if(name(node.get('Type'))==='Pages'||Array.isArray(kids)) {
   if(Array.isArray(kids))for(const kid of kids)await walk(kid,resources,depth+1);
  } else {
   if(pages.length>=doc.caps.maxPages)fail('DOCUMENT_TOO_LARGE','PDF has too many pages');
   pages.push({node,resources});
  }
 };
 await walk(catalog.get('Pages'),null,0);
 return {catalog,pages};
}

async function countActiveContent(doc,catalog,pages) {
 const ctx=doc.ctx;
 const countAction=action=>{
  const type=name(action?.get('S'));
  if(type==='JavaScript'||type==='Launch')ctx.discard('scripts');
  else if(type==='URI'||type==='GoToR'||type==='ImportData'||type==='SubmitForm')ctx.discard('externalReferences');
 };
 countAction(dictOf(await doc.resolve(catalog.get('OpenAction'))));
 if(catalog.has('AA'))ctx.discard('scripts');
 const namesDict=dictOf(await doc.resolve(catalog.get('Names')));
 if(namesDict?.has('JavaScript'))ctx.discard('scripts');
 if(namesDict?.has('EmbeddedFiles'))ctx.discard('embeddedObjects');
 if(catalog.has('AcroForm'))ctx.discard('unsupportedElements');
 for(const {node} of pages) {
  if(node.has('AA'))ctx.discard('scripts');
  const annots=await doc.resolve(node.get('Annots'));
  if(!Array.isArray(annots))continue;
  for(const annotValue of annots.slice(0,MAX_ANNOTATIONS)) {
   const annot=dictOf(await doc.resolve(annotValue));
   if(!annot)continue;
   const subtype=name(annot.get('Subtype'));
   const action=dictOf(await doc.resolve(annot.get('A')));
   countAction(action);
   if(annot.has('AA'))ctx.discard('scripts');
   if(subtype==='FileAttachment'||subtype==='RichMedia'||subtype==='Movie'||subtype==='Sound')ctx.discard('embeddedObjects');
   else if(subtype==='Widget')ctx.discard('unsupportedElements');
  }
 }
 if(ctx.discarded.externalReferences)ctx.warn('PDF_LINKS_NOT_IMPORTED','Link annotations were not imported; their targets were not followed');
}

export async function importPdfText(bytes,options={}) {
 const resolved=resolveOptions(options);
 if(!(bytes instanceof Uint8Array))throw new TypeError('PDF import expects a Uint8Array');
 const caps={...PDF_DEFAULT_LIMITS,...resolved.limits};
 const ctx=new ImportContext('pdf');
 ctx.provisionalReason=PROVISIONAL_REASON;
 const doc=new PdfDocument(bytes,caps,ctx);
 await doc.open();
 const {catalog,pages}=await collectPages(doc);
 if(!pages.length)unsupported('PDF has no pages');
 await countActiveContent(doc,catalog,pages);
 const collector=new TextCollector(caps);
 const stats={images:0,unmappedComposite:0,unmappedGlyphs:0,unreadableStreams:0};
 const interpreter=new ContentInterpreter(doc,collector,stats);
 let pagesWithoutText=0;
 for(const page of pages) {
  const before=collector.characters,imagesBefore=stats.images;
  const contents=await doc.resolve(page.node.get('Contents'));
  const streams=Array.isArray(contents)?contents:[contents];
  const parts=[];
  for(const value of streams) {
   const stream=await doc.resolve(value);
   if(!(stream instanceof Stream))continue;
   const data=await interpreter.streamData(stream);
   if(data)parts.push(data,Uint8Array.of(10));
  }
  const data=new Uint8Array(parts.reduce((sum,part)=>sum+part.length,0));
  let offset=0;for(const part of parts){data.set(part,offset);offset+=part.length;}
  try{await interpreter.run(data,page.resources);}
  catch(error) {
   if(!(error instanceof ImportError)||error.code!=='PDF_UNSUPPORTED')throw error;
   ctx.warn('PDF_CONTENT_UNREADABLE','Part of a page could not be read; text after the damaged operation was skipped');
  }
  collector.pageBreak();
  if(collector.characters===before&&stats.images>imagesBefore)pagesWithoutText++;
 }
 ctx.discard('images',stats.images);
 if(stats.unreadableStreams)ctx.warn('PDF_STREAM_UNSUPPORTED','Some content streams use unsupported filters or are damaged and were skipped',stats.unreadableStreams);
 if(stats.unmappedComposite)ctx.warn('PDF_CID_FONT_WITHOUT_TOUNICODE','Text in composite fonts without a ToUnicode map was skipped',stats.unmappedComposite);
 if(stats.unmappedGlyphs)ctx.warn('PDF_UNMAPPED_GLYPHS','Some glyphs had no Unicode mapping and were replaced with U+FFFD',stats.unmappedGlyphs);
 if(pagesWithoutText)ctx.warn('PDF_IMAGE_ONLY_PAGES','Pages with images but no text layer were skipped; OCR is not implemented',pagesWithoutText);
 const text=collector.text();
 if(!text.trim()) {
  if(stats.unmappedComposite||stats.unreadableStreams)unsupported('The PDF text uses fonts or filters this importer cannot decode');
  fail('PDF_NO_TEXT_LAYER','The PDF has no extractable text layer (for example a scanned document); OCR is not implemented');
 }
 return finishImport(plainTextBlocks(text,{joinLines:' '}),ctx,resolved);
}
