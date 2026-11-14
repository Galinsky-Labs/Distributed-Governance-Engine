import test from 'node:test';
import assert from 'node:assert/strict';
import {parseTrueType,TrueTypeError} from '../src/export/truetype.mjs';
import {fonts} from './support/export-fixture.mjs';

/** Builds a tiny synthetic TrueType font: glyph 0 (.notdef) plus glyphs for the given code points. */
function syntheticFont({codePoints=[0x41,0x42,0x1F600],cmap='format12',fsType=0,widths=[500,600,700,800]}={}) {
 const table=size=>new DataView(new ArrayBuffer(size));
 const numGlyphs=codePoints.length+1;
 const head=table(54);head.setUint32(0,0x00010000);head.setUint32(12,0x5f0f3cf5);head.setUint16(18,1000);head.setInt16(36,-50);head.setInt16(38,-200);head.setInt16(40,1000);head.setInt16(42,900);
 const hhea=table(36);hhea.setInt16(4,800);hhea.setInt16(6,-200);hhea.setUint16(34,2);
 const maxp=table(6);maxp.setUint32(0,0x00005000);maxp.setUint16(4,numGlyphs);
 // Two full metrics, then left side bearings only: glyphs >= 2 reuse the last advance.
 const hmtx=table(2*4+(numGlyphs-2)*2);hmtx.setUint16(0,widths[0]);hmtx.setUint16(4,widths[1]);
 let sub;
 if(cmap==='format12') {
  sub=table(16+12*codePoints.length);sub.setUint16(0,12);sub.setUint32(4,sub.byteLength);sub.setUint32(12,codePoints.length);
  codePoints.forEach((cp,i)=>{sub.setUint32(16+12*i,cp);sub.setUint32(20+12*i,cp);sub.setUint32(24+12*i,i+1);});
 } else {
  const bmp=codePoints.filter(cp=>cp<=0xffff),segs=bmp.length+1;
  sub=table(16+8*segs);sub.setUint16(0,4);sub.setUint16(2,sub.byteLength);sub.setUint16(6,segs*2);
  bmp.forEach((cp,i)=>{sub.setUint16(14+2*i,cp);sub.setUint16(16+2*segs+2*i,cp);sub.setInt16(16+4*segs+2*i,(i+1-cp)&0xffff);});
  sub.setUint16(14+2*bmp.length,0xffff);sub.setUint16(16+2*segs+2*bmp.length,0xffff);sub.setInt16(16+4*segs+2*bmp.length,1);
 }
 const cmapTable=table(12+sub.byteLength);cmapTable.setUint16(2,1);cmapTable.setUint16(4,3);cmapTable.setUint16(6,cmap==='format12'?10:1);cmapTable.setUint32(8,12);
 new Uint8Array(cmapTable.buffer).set(new Uint8Array(sub.buffer),12);
 const post=table(32);post.setUint32(0,0x00030000);post.setInt32(4,-12*65536);
 const os2=table(96);os2.setUint16(0,2);os2.setUint16(4,700);os2.setUint16(8,fsType);os2.setInt16(88,650);
 const family='Test Sans';
 const name=table(18+family.length*2);name.setUint16(2,1);name.setUint16(4,18);
 name.setUint16(6,3);name.setUint16(8,1);name.setUint16(10,0x409);name.setUint16(12,1);name.setUint16(14,family.length*2);
 [...family].forEach((ch,i)=>name.setUint16(18+2*i,ch.charCodeAt(0)));
 const tables=[['OS/2',os2],['cmap',cmapTable],['head',head],['hhea',hhea],['hmtx',hmtx],['maxp',maxp],['name',name],['post',post]];
 let offset=12+16*tables.length;const total=tables.reduce((s,[,t])=>s+((t.byteLength+3)&~3),offset);
 const out=new Uint8Array(total),dir=new DataView(out.buffer);
 dir.setUint32(0,0x00010000);dir.setUint16(4,tables.length);
 tables.forEach(([tag,t],i)=>{
  for(let c=0;c<4;c++)out[12+16*i+c]=tag.charCodeAt(c);
  dir.setUint32(12+16*i+8,offset);dir.setUint32(12+16*i+12,t.byteLength);
  out.set(new Uint8Array(t.buffer),offset);offset+=(t.byteLength+3)&~3;
 });
 return out;
}

test('Liberation Serif metrics, names and cmap lookups match known values',()=>{
 const regular=parseTrueType(fonts.regular),bold=parseTrueType(fonts.bold),italic=parseTrueType(fonts.italic);
 assert.equal(regular.unitsPerEm,2048);assert.equal(regular.numGlyphs,2602);
 assert.equal(regular.names.family,'Liberation Serif');assert.equal(regular.names.version,'Version 2.1.5');assert.equal(bold.names.postScriptName,'LiberationSerif-Bold');
 assert.equal(regular.glyphId(0x41),36);assert.equal(regular.advance(36),1479);assert.equal(regular.advance(regular.glyphId(0x20)),512);
 assert.equal(regular.textWidth('A A',11),(1479*2+512)*11/2048);
 assert(regular.hasGlyph(0x05D0)&&regular.hasGlyph(0x0416)&&regular.hasGlyph(0x00A7)&&regular.hasGlyph(0x2014),'Hebrew, Cyrillic, section sign and em dash are covered');
 assert(!regular.hasGlyph(0x4E2D)&&!regular.hasGlyph(0x1F600)&&!regular.hasGlyph(0x0627));
 assert.equal(regular.glyphId(0x4E2D),0);
 assert.equal(italic.italicAngle<0,true);assert.equal(regular.italicAngle,0);assert.equal(bold.weightClass,700);
 assert.equal(regular.fsType,0);assert.equal(regular.ascender,1825);assert.equal(regular.descender,-443);
});

test('synthetic fonts exercise cmap formats 4 and 12 and trailing metric reuse',()=>{
 const f12=parseTrueType(syntheticFont());
 assert.equal(f12.glyphId(0x41),1);assert.equal(f12.glyphId(0x42),2);assert.equal(f12.glyphId(0x1F600),3,'format 12 maps astral code points');
 assert.equal(f12.glyphId(0x43),0);
 assert.equal(f12.advance(0),500);assert.equal(f12.advance(1),600);assert.equal(f12.advance(3),600,'glyphs past numberOfHMetrics reuse the last advance');
 assert.equal(f12.names.family,'Test Sans');assert.equal(f12.capHeight,650);assert.equal(f12.italicAngle,-12);
 const f4=parseTrueType(syntheticFont({cmap:'format4'}));
 assert.equal(f4.glyphId(0x41),1);assert.equal(f4.glyphId(0x42),2);assert.equal(f4.glyphId(0x1F600),0,'format 4 is BMP-only');assert.equal(f4.glyphId(0x40),0);
});

test('malformed, unsupported and restricted fonts fail with typed errors',()=>{
 const expectCode=(bytes,code)=>assert.throws(()=>parseTrueType(bytes),error=>error instanceof TrueTypeError&&error.code===code);
 expectCode('not bytes','TRUETYPE_INVALID_INPUT');
 expectCode(new Uint8Array(4),'TRUETYPE_MALFORMED');
 expectCode(new Uint8Array([0x4f,0x54,0x54,0x4f,0,1,0,0,0,0,0,0]),'TRUETYPE_UNSUPPORTED');
 expectCode(new Uint8Array([0x74,0x74,0x63,0x66,0,1,0,0,0,0,0,0]),'TRUETYPE_UNSUPPORTED');
 expectCode(fonts.regular.slice(0,5000),'TRUETYPE_MALFORMED');
 const badMagic=syntheticFont();const view=new DataView(badMagic.buffer);
 const headOffset=view.getUint32(12+16*2+8);view.setUint32(headOffset+12,0);expectCode(badMagic,'TRUETYPE_MALFORMED');
 const pastEnd=syntheticFont();new DataView(pastEnd.buffer).setUint32(12+16*1+12,0x7fffffff);expectCode(pastEnd,'TRUETYPE_MALFORMED');
 const hugeCount=syntheticFont();const hv=new DataView(hugeCount.buffer);hv.setUint16(hv.getUint32(12+16*5+8)+4,0);expectCode(hugeCount,'TRUETYPE_MALFORMED');
 expectCode(syntheticFont({fsType:2}),'TRUETYPE_RESTRICTED');
 // Random corruption never escapes as anything other than a TrueTypeError.
 let seed=7;const rand=()=>(seed=(seed*1103515245+12345)%2147483648)/2147483648;
 for(let i=0;i<200;i++) {
  const bytes=syntheticFont();
  for(let j=0;j<8;j++)bytes[Math.floor(rand()*bytes.length)]=Math.floor(rand()*256);
  try{const font=parseTrueType(bytes);font.textWidth('AB\u{1F600}',10);}catch(error){assert(error instanceof TrueTypeError,error.message);}
 }
});
