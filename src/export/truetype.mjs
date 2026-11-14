/**
 * Minimal, bounds-checked TrueType reader: just the metrics, character map and
 * naming data needed to measure text and embed a whole font in PDF/DOCX output.
 * Runs unchanged in Node and browsers (no node: imports, no DOM).
 */

export class TrueTypeError extends Error {
 constructor(code,message) {super(message);this.name='TrueTypeError';this.code=code;}
}

const REQUIRED_TABLES=['head','hhea','hmtx','maxp','cmap','post','OS/2','name'];
const MAX_FONT_BYTES=50*1024*1024;

function fail(message,code='TRUETYPE_MALFORMED') {throw new TrueTypeError(code,message);}

/** Bounds-checked big-endian view over one byte range. */
class Reader {
 constructor(bytes,start=0,end=bytes.byteLength) {
  this.view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);this.start=start;this.end=end;
 }
 check(offset,size) {if(!Number.isSafeInteger(offset)||offset<this.start||offset+size>this.end)fail('Read outside table bounds at offset '+offset);}
 u8(o) {this.check(o,1);return this.view.getUint8(o);}
 u16(o) {this.check(o,2);return this.view.getUint16(o);}
 i16(o) {this.check(o,2);return this.view.getInt16(o);}
 u32(o) {this.check(o,4);return this.view.getUint32(o);}
 fixed(o) {this.check(o,4);return this.view.getInt32(o)/65536;}
 tag(o) {this.check(o,4);return String.fromCharCode(this.u8(o),this.u8(o+1),this.u8(o+2),this.u8(o+3));}
}

function tableDirectory(bytes) {
 const r=new Reader(bytes);
 if(bytes.byteLength<12)fail('Font is too short for a table directory');
 const version=r.u32(0);
 if(version===0x74746366)fail('TrueType collections are not supported','TRUETYPE_UNSUPPORTED');
 if(version===0x4f54544f)fail('CFF-flavoured OpenType fonts are not supported; supply TrueType outlines','TRUETYPE_UNSUPPORTED');
 if(version!==0x00010000&&version!==0x74727565)fail('Not a TrueType font');
 const count=r.u16(4),tables=new Map();
 if(count===0||count>200)fail('Implausible table count');
 for(let i=0;i<count;i++) {
  const at=12+i*16,tag=r.tag(at),offset=r.u32(at+8),length=r.u32(at+12);
  if(offset+length>bytes.byteLength)fail('Table '+tag+' extends past the end of the font');
  tables.set(tag,{offset,length});
 }
 for(const tag of REQUIRED_TABLES)if(!tables.has(tag))fail('Missing required table '+tag);
 return tables;
}

function tableReader(bytes,tables,tag) {const {offset,length}=tables.get(tag);return {r:new Reader(bytes,offset,offset+length),o:offset};}

function parseCmapSubtable(r,o) {
 const format=r.u16(o);
 if(format===4) {
  const segX2=r.u16(o+6);if(segX2%2)fail('Odd cmap segment count');
  const seg=segX2/2,ends=o+14,starts=ends+segX2+2,deltas=starts+segX2,ranges=deltas+segX2,segments=[];
  for(let i=0;i<seg;i++)segments.push({end:r.u16(ends+2*i),start:r.u16(starts+2*i),delta:r.i16(deltas+2*i),rangeAt:ranges+2*i,range:r.u16(ranges+2*i)});
  return cp=>{
   if(cp>0xffff)return 0;
   for(const s of segments) {
    if(cp>s.end)continue;
    if(cp<s.start)return 0;
    if(s.range===0)return (cp+s.delta)&0xffff;
    const g=r.u16(s.rangeAt+s.range+2*(cp-s.start));
    return g===0?0:(g+s.delta)&0xffff;
   }
   return 0;
  };
 }
 if(format===12) {
  const groups=r.u32(o+12);if(groups>1e6)fail('Implausible cmap group count');
  const list=[];
  for(let i=0;i<groups;i++){const at=o+16+12*i;list.push([r.u32(at),r.u32(at+4),r.u32(at+8)]);}
  return cp=>{
   let lo=0,hi=list.length-1;
   while(lo<=hi){const mid=(lo+hi)>>1,[s,e,g]=list[mid];if(cp<s)hi=mid-1;else if(cp>e)lo=mid+1;else return g+cp-s;}
   return 0;
  };
 }
 return null;
}

function parseCmap(bytes,tables) {
 const {r,o}=tableReader(bytes,tables,'cmap');
 const count=r.u16(o+2),candidates=[];
 for(let i=0;i<count;i++) {
  const at=o+4+8*i,platform=r.u16(at),encoding=r.u16(at+2),offset=r.u32(at+4);
  const format=r.u16(o+offset);
  // Prefer full-repertoire Unicode (format 12) over BMP-only Unicode (format 4).
  const rank=format===12&&(platform===3&&encoding===10||platform===0)?2:format===4&&(platform===3&&(encoding===1||encoding===10)||platform===0)?1:0;
  if(rank)candidates.push({rank,offset:o+offset});
 }
 candidates.sort((a,b)=>b.rank-a.rank);
 for(const c of candidates){const lookup=parseCmapSubtable(r,c.offset);if(lookup)return lookup;}
 fail('No Unicode cmap subtable (format 4 or 12)','TRUETYPE_UNSUPPORTED');
}

function decodeName(r,at,length,platform) {
 r.check(at,length);let s='';
 if(platform===3||platform===0){for(let i=0;i+1<length;i+=2)s+=String.fromCharCode(r.u16(at+i));}
 else for(let i=0;i<length;i++)s+=String.fromCharCode(r.u8(at+i));
 return s;
}
function parseNames(bytes,tables) {
 const {r,o}=tableReader(bytes,tables,'name');
 const count=r.u16(o+2),storage=o+r.u16(o+4),found={};
 const keys={0:'copyright',1:'family',2:'subfamily',4:'fullName',5:'version',6:'postScriptName'};
 for(let i=0;i<count;i++) {
  const at=o+6+12*i,platform=r.u16(at),language=r.u16(at+4),id=r.u16(at+6),length=r.u16(at+8),offset=r.u16(at+10);
  const key=keys[id];if(!key)continue;
  const english=platform===3?language===0x409:platform===1?language===0:true;
  if(!english)continue;
  const value=decodeName(r,storage+offset,length,platform);
  if(found[key]===undefined||platform===3)found[key]=value;
 }
 return found;
}

/** Parse a TrueType font. Throws TrueTypeError (codes TRUETYPE_MALFORMED, TRUETYPE_UNSUPPORTED, TRUETYPE_RESTRICTED). */
export function parseTrueType(input) {
 if(!(input instanceof Uint8Array))fail('Font bytes must be a Uint8Array','TRUETYPE_INVALID_INPUT');
 if(input.byteLength>MAX_FONT_BYTES)fail('Font exceeds the size limit');
 const bytes=input,tables=tableDirectory(bytes);
 const head=tableReader(bytes,tables,'head');
 if(head.r.u32(head.o+12)!==0x5f0f3cf5)fail('Bad head magic number');
 const unitsPerEm=head.r.u16(head.o+18);if(unitsPerEm<16||unitsPerEm>16384)fail('Invalid unitsPerEm');
 const bbox=[head.r.i16(head.o+36),head.r.i16(head.o+38),head.r.i16(head.o+40),head.r.i16(head.o+42)];
 const fontRevision=head.r.fixed(head.o+4);
 const maxp=tableReader(bytes,tables,'maxp'),numGlyphs=maxp.r.u16(maxp.o+4);
 if(numGlyphs===0)fail('Font has no glyphs');
 const hhea=tableReader(bytes,tables,'hhea');
 const ascender=hhea.r.i16(hhea.o+4),descender=hhea.r.i16(hhea.o+6),lineGap=hhea.r.i16(hhea.o+8),numberOfHMetrics=hhea.r.u16(hhea.o+34);
 if(numberOfHMetrics===0||numberOfHMetrics>numGlyphs)fail('Invalid horizontal metric count');
 const hmtx=tableReader(bytes,tables,'hmtx');
 hmtx.r.check(hmtx.o,numberOfHMetrics*4+(numGlyphs-numberOfHMetrics)*2);
 const advances=new Uint16Array(numGlyphs);
 for(let g=0;g<numGlyphs;g++)advances[g]=hmtx.r.u16(hmtx.o+4*Math.min(g,numberOfHMetrics-1));
 const post=tableReader(bytes,tables,'post');
 const italicAngle=post.r.fixed(post.o+4),isFixedPitch=post.r.u32(post.o+12)!==0;
 const os2=tableReader(bytes,tables,'OS/2'),os2Version=os2.r.u16(os2.o);
 const weightClass=os2.r.u16(os2.o+4),fsType=os2.r.u16(os2.o+8);
 const capHeight=os2Version>=2?os2.r.i16(os2.o+88):Math.round(ascender*0.7);
 // fsType bit 1 (0x0002) alone = restricted license embedding: must not be embedded.
 if((fsType&0x000f)===0x0002)fail('Font licensing forbids embedding','TRUETYPE_RESTRICTED');
 const lookup=parseCmap(bytes,tables),names=parseNames(bytes,tables);
 const glyphCache=new Map();
 const glyphId=cp=>{let g=glyphCache.get(cp);if(g===undefined){g=lookup(cp);if(g>=numGlyphs)g=0;glyphCache.set(cp,g);}return g;};
 return Object.freeze({
  bytes,unitsPerEm,numGlyphs,ascender,descender,lineGap,capHeight,bbox,italicAngle,isFixedPitch,weightClass,fsType,fontRevision,
  names:Object.freeze(names),
  glyphId,
  hasGlyph:cp=>glyphId(cp)!==0,
  advance:gid=>advances[gid]??advances[0],
  /** Advance width of a string in points at the given size (no kerning). */
  textWidth(text,size) {let units=0;for(const ch of text)units+=advances[glyphId(ch.codePointAt(0))];return units*size/unitsPerEm;}
 });
}
