/**
 * PDF 1.7 writer for layout display lists: embedded TrueType fonts (Type0 /
 * CIDFontType2, Identity-H), Tagged PDF structure, outline, link annotations,
 * XMP and an sRGB output intent aimed at PDF/A-2b. Byte-deterministic for
 * identical inputs. Platform-neutral (Node 24 and browsers).
 */
import {validateLegalDocument} from '../legal-structure.mjs';
import {parseTrueType,TrueTypeError} from './truetype.mjs';
import {layoutDocument,normalizeLayoutOptions,FONT_STYLES} from './layout.mjs';
import {ExportError,PRODUCER,RENDER_PROFILE_ID,concatBytes,deflate,utf8,sha256Hex,xmlEscape,prepareExport,exportManifest,fontEntries,requireTimestamp} from './common.mjs';

const num=n=>{const r=Math.round(n*1000)/1000;return Object.is(r,-0)?'0':String(r);};
const name=value=>'/'+String(value).replace(/[^A-Za-z0-9_.-]/g,ch=>'#'+ch.charCodeAt(0).toString(16).padStart(2,'0'));
const ref=id=>id+' 0 R';

/** PDF text string: literal for printable ASCII, otherwise UTF-16BE with BOM. */
export function pdfString(text) {
 if(/^[\x20-\x7e]*$/.test(text))return '('+text.replace(/[\\()]/g,ch=>'\\'+ch)+')';
 let hex='FEFF';
 for(let i=0;i<text.length;i++)hex+=text.charCodeAt(i).toString(16).padStart(4,'0').toUpperCase();
 return '<'+hex+'>';
}
const utf16Hex=text=>{let hex='';for(let i=0;i<text.length;i++)hex+=text.charCodeAt(i).toString(16).padStart(4,'0').toUpperCase();return hex;};

const fontCache=new WeakMap();
/** Parses (and caches per byte array) the caller's font set. */
export function parseFontSet(fonts) {
 if(!fonts||typeof fonts!=='object')throw new ExportError('FONT_MISSING','fonts must provide TrueType bytes for regular, bold, italic and boldItalic');
 const parsed={};
 for(const style of FONT_STYLES) {
  const bytes=fonts[style];
  if(bytes===undefined)continue;
  if(!fontCache.has(bytes)) {
   try {fontCache.set(bytes,parseTrueType(bytes));}
   catch(error) {throw error instanceof TrueTypeError?new ExportError('FONT_INVALID','Font for style '+style+' is not usable: '+error.message,{cause:error}):error;}
  }
  parsed[style]=fontCache.get(bytes);
 }
 if(!parsed.regular)throw new ExportError('FONT_MISSING','A regular font is required');
 return parsed;
}
const compressedFonts=new WeakMap();
async function compressedFont(font) {
 if(!compressedFonts.has(font.bytes))compressedFonts.set(font.bytes,deflate(font.bytes));
 return compressedFonts.get(font.bytes);
}

/* ---------- sRGB ICC profile (version 2.1, display class) ---------- */

let iccProfile=null;
/** Builds a minimal, valid ICC v2 sRGB profile: D50 colorants, white point and 1024-entry sRGB tone curves. */
export function srgbIccProfile() {
 if(iccProfile)return iccProfile;
 const s15=v=>Math.round(v*65536);
 const xyz=(x,y,z)=>{const b=new DataView(new ArrayBuffer(20));b.setUint32(0,0x58595a20);b.setInt32(8,s15(x));b.setInt32(12,s15(y));b.setInt32(16,s15(z));return new Uint8Array(b.buffer);};
 const curve=(()=>{
  const n=1024,b=new DataView(new ArrayBuffer(12+2*n));
  b.setUint32(0,0x63757276);b.setUint32(8,n);
  for(let i=0;i<n;i++){const c=i/(n-1),v=c<=0.04045?c/12.92:((c+0.055)/1.055)**2.4;b.setUint16(12+2*i,Math.round(v*65535));}
  return new Uint8Array(b.buffer);
 })();
 const ascii=text=>Array.from(text,ch=>ch.charCodeAt(0));
 const desc=(()=>{
  const text=ascii('sRGB IEC61966-2.1 (Quill minimal)\0');
  const b=new Uint8Array(12+text.length+12+67);const v=new DataView(b.buffer);
  v.setUint32(0,0x64657363);v.setUint32(8,text.length);b.set(text,12);
  return b; // Unicode and ScriptCode sections are present but empty (zero counts).
 })();
 const cprt=(()=>{const text=ascii('No copyright, use freely\0');const b=new Uint8Array(8+text.length);new DataView(b.buffer).setUint32(0,0x74657874);b.set(text,8);return b;})();
 const tags=[['desc',desc],['cprt',cprt],['wtpt',xyz(0.9642,1,0.8249)],['rXYZ',xyz(0.4361,0.2225,0.0139)],['gXYZ',xyz(0.3851,0.7169,0.0971)],['bXYZ',xyz(0.1431,0.0606,0.7141)],['rTRC',curve],['gTRC',curve],['bTRC',curve]];
 const pad=n=>(n+3)&~3;
 let offset=128+4+12*tags.length;const placed=new Map(),entries=[];
 for(const [sig,data] of tags) {
  if(!placed.has(data)){placed.set(data,offset);offset=pad(offset+data.length);}
  entries.push([sig,placed.get(data),data.length]);
 }
 const out=new Uint8Array(offset),v=new DataView(out.buffer);
 v.setUint32(0,offset);v.setUint32(8,0x02100000);
 out.set(ascii('mntrRGB XYZ '),12);
 v.setUint16(24,2026);v.setUint16(26,1);v.setUint16(28,1);
 out.set(ascii('acsp'),36);
 v.setInt32(68,s15(0.9642));v.setInt32(72,s15(1));v.setInt32(76,s15(0.8249));
 v.setUint32(128,tags.length);
 entries.forEach(([sig,at,length],i)=>{out.set(ascii(sig),132+12*i);v.setUint32(136+12*i,at);v.setUint32(140+12*i,length);});
 for(const [data,at] of placed)out.set(data,at);
 return iccProfile=out;
}

/* ---------- Object writer ---------- */

class PdfWriter {
 constructor() {this.objects=[null];}
 reserve() {this.objects.push(null);return this.objects.length-1;}
 set(id,body) {this.objects[id]={body};}
 add(body) {const id=this.reserve();this.set(id,body);return id;}
 stream(id,dict,data) {this.objects[id]={dict,data};}
 addStream(dict,data) {const id=this.reserve();this.stream(id,dict,data);return id;}
 serialize(trailer) {
  const parts=[utf8('%PDF-1.7\n%'),new Uint8Array([0xe2,0xe3,0xcf,0xd3]),utf8('\n')];
  let length=parts.reduce((s,p)=>s+p.length,0);const offsets=[];
  const push=bytes=>{parts.push(bytes);length+=bytes.length;};
  for(let id=1;id<this.objects.length;id++) {
   const object=this.objects[id];
   if(!object)throw new Error('PDF object '+id+' was reserved but never written');
   offsets[id]=length;
   if(object.data) {
    push(utf8(id+' 0 obj\n<<'+object.dict+' /Length '+object.data.length+'>>\nstream\n'));
    push(object.data);push(utf8('\nendstream\nendobj\n'));
   } else push(utf8(id+' 0 obj\n'+object.body+'\nendobj\n'));
  }
  const xref=length;
  let table='xref\n0 '+this.objects.length+'\n0000000000 65535 f\r\n';
  for(let id=1;id<this.objects.length;id++)table+=String(offsets[id]).padStart(10,'0')+' 00000 n\r\n';
  push(utf8(table+'trailer\n<<'+trailer+' /Size '+this.objects.length+'>>\nstartxref\n'+xref+'\n%%EOF\n'));
  return concatBytes(parts);
 }
}

/* ---------- Text encoding per font ---------- */

class FontUse {
 constructor(style,font,resource) {this.style=style;this.font=font;this.resource=resource;this.unicode=new Map();this.missing=new Set();}
 /** Hex glyph string, plus whether ActualText is needed (missing or shared glyphs). */
 encode(text) {
  let hex='',ambiguous=false;
  for(const ch of text) {
   const gid=this.font.glyphId(ch.codePointAt(0));
   if(gid===0){ambiguous=true;this.missing.add(ch);}
   else if(!this.unicode.has(gid))this.unicode.set(gid,ch);
   else if(this.unicode.get(gid)!==ch)ambiguous=true;
   hex+=gid.toString(16).padStart(4,'0');
  }
  return {hex,ambiguous};
 }
 widths() {
  const gids=[0,...[...this.unicode.keys()]].sort((a,b)=>a-b);
  let out='',run=[];
  const flush=()=>{if(run.length)out+=run[0]+' ['+run.map(g=>Math.round(this.font.advance(g)*1000/this.font.unitsPerEm)).join(' ')+'] ';run=[];};
  for(const g of gids){if(run.length&&g!==run.at(-1)+1)flush();if(!run.includes(g))run.push(g);}
  flush();return out.trim();
 }
 toUnicode() {
  const entries=[...this.unicode].sort((a,b)=>a[0]-b[0]);
  let body='';
  for(let i=0;i<entries.length;i+=100) {
   const chunk=entries.slice(i,i+100);
   body+=chunk.length+' beginbfchar\n'+chunk.map(([gid,ch])=>'<'+gid.toString(16).padStart(4,'0').toUpperCase()+'> <'+utf16Hex(ch)+'>').join('\n')+'\nendbfchar\n';
  }
  return '/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n'+body+'endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n';
 }
}

const RTL_RUN=/[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF](?:[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF ]*[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF])?/g;
/**
 * Minimal visual reordering for right-to-left runs embedded in left-to-right lines
 * (reverses each run; not the full Unicode Bidirectional Algorithm, no shaping).
 */
export const visualOrder=text=>text.replace(RTL_RUN,run=>Array.from(run).reverse().join(''));

const pdfDate=iso=>'D:'+iso.slice(0,4)+iso.slice(5,7)+iso.slice(8,10)+iso.slice(11,13)+iso.slice(14,16)+iso.slice(17,19)+"+00'00'";
const xmpDate=iso=>iso.slice(0,19)+'+00:00';

function xmpPacket({title,subject,keywords,producer,created,lang}) {
 const e=value=>xmlEscape(value);
 return '<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>\n'
 +'<x:xmpmeta xmlns:x="adobe:ns:meta/">\n<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">\n'
 +'<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:pdf="http://ns.adobe.com/pdf/1.3/" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/">\n'
 +'<dc:format>application/pdf</dc:format>\n'
 +'<dc:title><rdf:Alt><rdf:li xml:lang="x-default">'+e(title)+'</rdf:li></rdf:Alt></dc:title>\n'
 +'<dc:description><rdf:Alt><rdf:li xml:lang="x-default">'+e(subject)+'</rdf:li></rdf:Alt></dc:description>\n'
 +'<dc:language><rdf:Bag><rdf:li>'+e(lang)+'</rdf:li></rdf:Bag></dc:language>\n'
 +'<pdf:Producer>'+e(producer)+'</pdf:Producer>\n<pdf:Keywords>'+e(keywords)+'</pdf:Keywords>\n'
 +'<xmp:CreatorTool>'+e(producer)+'</xmp:CreatorTool>\n<xmp:CreateDate>'+created+'</xmp:CreateDate>\n<xmp:ModifyDate>'+created+'</xmp:ModifyDate>\n<xmp:MetadataDate>'+created+'</xmp:MetadataDate>\n'
 +'<pdfaid:part>2</pdfaid:part>\n<pdfaid:conformance>B</pdfaid:conformance>\n'
 +'</rdf:Description>\n</rdf:RDF>\n</x:xmpmeta>\n<?xpacket end="r"?>';
}

/**
 * Serialises a layout (see layout.mjs) to PDF bytes.
 * meta: {title, lang, editionDigest, generatedAt, version, documentId}.
 */
export async function writePdf({layout,fonts,meta}) {
 const w=new PdfWriter();
 const catalogId=w.reserve(),pagesId=w.reserve();
 const pageIds=layout.pages.map(()=>w.reserve());
 const fontUses=new Map();
 const fontUse=style=>{
  if(!fontUses.has(style)){if(!fonts[style])throw new ExportError('FONT_MISSING','No font supplied for style '+style);fontUses.set(style,new FontUse(style,fonts[style],'F'+(FONT_STYLES.indexOf(style)+1)));}
  return fontUses.get(style);
 };

 // Content references → MCIDs (page-local, in paint order) and their owning elements.
 const structure=layout.structure,owner=new Map();
 for(const element of structure.elements)for(const kid of element.kids)if(kid.content)owner.set(kid.content.page+':'+kid.content.item,element.id);
 const mcids=new Map(),parentTree=[];
 const tagOf=id=>{const t=structure.elements[id].type;return ['Document','Part','Sect','Div','L','LI','LBody','Table','TR','TOC','TOCI'].includes(t)?'Span':t;};

 const contentStreams=[];
 layout.pages.forEach((page,pageIndex)=>{
  const ops=[],pageMcids=[];
  const order=[...page.items.keys()].sort((a,b)=>(page.items[b].artifact==='Watermark')-(page.items[a].artifact==='Watermark')||a-b);
  for(const index of order) {
   const item=page.items[index],elementId=owner.get(pageIndex+':'+index);
   let open,actual='';
   if(item.type==='text') {
    const visual=visualOrder(item.text);
    const use=fontUse(item.style),{hex,ambiguous}=use.encode(visual);
    if(ambiguous||visual!==item.text)actual=' /ActualText '+pdfString(item.text);
    const matrix=item.rotate?[Math.cos(item.rotate),Math.sin(item.rotate),-Math.sin(item.rotate),Math.cos(item.rotate),item.x,item.y]:[1,0,0,1,item.x,item.y];
    item.ops='BT /'+use.resource+' '+num(item.size)+' Tf '+item.color.map(num).join(' ')+' rg '+matrix.map(num).join(' ')+' Tm <'+hex+'> Tj ET';
   } else if(item.type==='line') {
    item.ops='q '+num(item.width)+' w '+item.color.map(num).join(' ')+' RG '+num(item.x1)+' '+num(item.y1)+' m '+num(item.x2)+' '+num(item.y2)+' l S Q';
   } else if(item.type==='rect') {
    item.ops='q '+num(item.lineWidth)+' w '+item.stroke.map(num).join(' ')+' RG '+[item.x,item.y,item.w,item.h].map(num).join(' ')+' re S Q';
   } else if(item.type==='path') {
    item.ops='q 1 J 1 j '+num(item.width)+' w '+item.color.map(num).join(' ')+' RG '+item.strokes.map(stroke=>stroke.length===1?num(stroke[0][0])+' '+num(stroke[0][1])+' m '+num(stroke[0][0]+0.01)+' '+num(stroke[0][1])+' l':stroke.map(([x,y],i)=>num(x)+' '+num(y)+(i?' l':' m')).join(' ')).join(' ')+' S Q';
   }
   if(elementId!==undefined) {
    const mcid=pageMcids.length;pageMcids.push(elementId);mcids.set(pageIndex+':'+index,mcid);
    open=name(tagOf(elementId)).slice(1)+' <</MCID '+mcid+actual+'>> BDC';
    ops.push('/'+open,item.ops,'EMC');
   } else {
    const kind=item.artifact==='Watermark'?' <</Type /Pagination /Subtype /Watermark>> BDC':item.artifact==='Pagination'?' <</Type /Pagination>> BDC':item.artifact==='Layout'?' <</Type /Layout>> BDC':' BMC';
    ops.push('/Artifact'+kind,item.ops,'EMC');
   }
  }
  parentTree[pageIndex]=pageMcids;
  contentStreams.push(ops.join('\n'));
 });

 // Fonts (only the styles actually painted).
 const fontRefs={};
 for(const [style,use] of fontUses) {
  const font=use.font,scale=1000/font.unitsPerEm,ps=font.names.postScriptName??('QuillFont'+use.resource);
  const fileId=w.addStream(' /Filter /FlateDecode /Length1 '+font.bytes.length,await compressedFont(font));
  const flags=32|2|(font.italicAngle!==0?64:0)|(font.isFixedPitch?1:0);
  const descriptorId=w.add('<</Type /FontDescriptor /FontName '+name(ps)+' /Flags '+flags+' /FontBBox ['+font.bbox.map(v=>Math.round(v*scale)).join(' ')+'] /ItalicAngle '+num(font.italicAngle)+' /Ascent '+Math.round(font.ascender*scale)+' /Descent '+Math.round(font.descender*scale)+' /CapHeight '+Math.round(font.capHeight*scale)+' /StemV '+(font.weightClass>=600?120:80)+' /FontFile2 '+ref(fileId)+'>>');
  const cidId=w.add('<</Type /Font /Subtype /CIDFontType2 /BaseFont '+name(ps)+' /CIDSystemInfo <</Registry (Adobe) /Ordering (Identity) /Supplement 0>> /FontDescriptor '+ref(descriptorId)+' /DW '+Math.round(font.advance(0)*scale)+' /W ['+use.widths()+'] /CIDToGIDMap /Identity>>');
  const cmapId=w.addStream(' /Filter /FlateDecode',await deflate(utf8(use.toUnicode())));
  fontRefs[use.resource]=w.add('<</Type /Font /Subtype /Type0 /BaseFont '+name(ps)+' /Encoding /Identity-H /DescendantFonts ['+ref(cidId)+'] /ToUnicode '+ref(cmapId)+'>>');
 }
 const fontDict='<<'+Object.entries(fontRefs).map(([k,v])=>'/'+k+' '+ref(v)).join(' ')+'>>';

 // Structure tree: drop elements without any content so the tree has no empty tags.
 const keep=new Set();
 const hasContent=id=>{
  const element=structure.elements[id];let found=false;
  for(const kid of element.kids)if(kid.content?mcids.has(kid.content.page+':'+kid.content.item):hasContent(kid.element))found=true;
  if(found)keep.add(id);return found;
 };
 const roots=structure.elements.filter(e=>e.parent===null);
 roots.forEach(e=>hasContent(e.id));
 const elementObj=new Map();
 for(const element of structure.elements)if(keep.has(element.id))elementObj.set(element.id,w.reserve());
 const structRootId=w.reserve();

 // Annotations.
 const annotationsByPage=layout.pages.map(()=>[]);const objrs=new Map();
 let nextStructParent=layout.pages.length;
 const destinationArray=nodeId=>{const d=layout.destinations.get(nodeId);return d?'['+ref(pageIds[d.page])+' /XYZ null '+num(d.y)+' null]':null;};
 layout.pages.forEach((page,pageIndex)=>{
  for(const link of page.links) {
   let action;
   if(link.uri){if(!/^https:\/\//.test(link.uri))continue;action='/A <</S /URI /URI '+pdfString(link.uri)+'>>';}
   else{const d=destinationArray(link.dest);if(!d)continue;action='/Dest '+d;}
   const structOk=link.struct!==null&&elementObj.has(link.struct);
   const key=structOk?nextStructParent++:null;
   const id=w.add('<</Type /Annot /Subtype /Link /Rect ['+link.rect.map(num).join(' ')+'] /Border [0 0 0] /F 4 '+action+' /Contents '+pdfString(link.contents||'Link')+(structOk?' /StructParent '+key:'')+'>>');
   annotationsByPage[pageIndex].push(id);
   if(structOk){parentTree[key]=link.struct;(objrs.get(link.struct)??objrs.set(link.struct,[]).get(link.struct)).push({id,page:pageIndex});}
  }
 });

 for(const element of structure.elements) {
  if(!keep.has(element.id))continue;
  const kids=[];
  for(const kid of element.kids) {
   if(kid.element!==undefined){if(keep.has(kid.element))kids.push(ref(elementObj.get(kid.element)));}
   else{const key=kid.content.page+':'+kid.content.item;if(mcids.has(key))kids.push('<</Type /MCR /Pg '+ref(pageIds[kid.content.page])+' /MCID '+mcids.get(key)+'>>');}
  }
  for(const o of objrs.get(element.id)??[])kids.push('<</Type /OBJR /Obj '+ref(o.id)+' /Pg '+ref(pageIds[o.page])+'>>');
  const parent=element.parent===null?ref(structRootId):ref(elementObj.get(element.parent));
  let extra='';
  if(element.title)extra+=' /T '+pdfString(element.title);
  if(element.alt)extra+=' /Alt '+pdfString(element.alt);
  if(element.bbox)extra+=' /A <</O /Layout /BBox ['+element.bbox.map(num).join(' ')+']>>';
  if(element.parent===null)extra+=' /Lang '+pdfString(meta.lang);
  if(element.type==='Note')extra+=' /ID '+pdfString('note-'+element.id);
  w.set(elementObj.get(element.id),'<</Type /StructElem /S '+name(element.type)+' /P '+parent+extra+' /K ['+kids.join(' ')+']>>');
 }
 const nums=[];
 parentTree.forEach((entry,key)=>{
  if(Array.isArray(entry))nums.push(key+' ['+entry.map(id=>ref(elementObj.get(id))).join(' ')+']');
  else if(entry!==undefined)nums.push(key+' '+ref(elementObj.get(entry)));
 });
 const parentTreeId=w.add('<</Nums ['+nums.join(' ')+']>>');
 w.set(structRootId,'<</Type /StructTreeRoot /K ['+roots.filter(e=>keep.has(e.id)).map(e=>ref(elementObj.get(e.id))).join(' ')+'] /ParentTree '+ref(parentTreeId)+' /ParentTreeNextKey '+nextStructParent+'>>');

 // Pages.
 for(const [pageIndex,page] of layout.pages.entries()) {
  const contentId=w.addStream(' /Filter /FlateDecode',await deflate(utf8(contentStreams[pageIndex])));
  const annots=annotationsByPage[pageIndex].length?' /Annots ['+annotationsByPage[pageIndex].map(ref).join(' ')+']':'';
  w.set(pageIds[pageIndex],'<</Type /Page /Parent '+ref(pagesId)+' /MediaBox [0 0 '+num(page.width)+' '+num(page.height)+'] /Resources <</Font '+fontDict+'>> /Contents '+ref(contentId)+' /StructParents '+pageIndex+' /Tabs /S'+annots+'>>');
 }
 w.set(pagesId,'<</Type /Pages /Kids ['+pageIds.map(ref).join(' ')+'] /Count '+pageIds.length+'>>');

 // Outline mirroring sections and exhibits.
 let outlinesRef='';
 if(layout.outline.length) {
  const rootId=w.reserve();
  const items=layout.outline.filter(e=>layout.destinations.has(e.nodeId)).map(e=>({...e,id:w.reserve(),children:[]}));
  const top=[],stack=[];
  for(const item of items) {
   while(stack.length&&stack.at(-1).level>=item.level)stack.pop();
   item.parent=stack.at(-1)??null;(item.parent?item.parent.children:top).push(item);stack.push(item);
  }
  const count=list=>list.reduce((s,i)=>s+1+count(i.children),0);
  const emit=(list,parentId)=>list.forEach((item,i)=>{
   const kids=item.children.length?' /First '+ref(item.children[0].id)+' /Last '+ref(item.children.at(-1).id)+' /Count '+count(item.children):'';
   w.set(item.id,'<</Title '+pdfString(item.title)+' /Parent '+ref(parentId)+(i>0?' /Prev '+ref(list[i-1].id):'')+(i<list.length-1?' /Next '+ref(list[i+1].id):'')+kids+' /Dest '+destinationArray(item.nodeId)+'>>');
   emit(item.children,item.id);
  });
  emit(top,rootId);
  w.set(rootId,'<</Type /Outlines'+(top.length?' /First '+ref(top[0].id)+' /Last '+ref(top.at(-1).id)+' /Count '+count(top):'')+'>>');
  outlinesRef=' /Outlines '+ref(rootId)+' /PageMode /UseOutlines';
 }

 const subject='Edition '+meta.editionDigest+' rendered with '+RENDER_PROFILE_ID;
 const keywords='edition-digest:'+meta.editionDigest+' render-profile:'+RENDER_PROFILE_ID+' document:'+meta.documentId+' version:'+meta.version;
 const xmp=utf8(xmpPacket({title:meta.title,subject,keywords,producer:PRODUCER,created:xmpDate(meta.generatedAt),lang:meta.lang}));
 const metadataId=w.addStream(' /Type /Metadata /Subtype /XML',xmp);
 const iccId=w.addStream(' /N 3 /Filter /FlateDecode',await deflate(srgbIccProfile()));
 const outputIntent='<</Type /OutputIntent /S /GTS_PDFA1 /OutputConditionIdentifier (sRGB IEC61966-2.1) /Info (sRGB IEC61966-2.1) /DestOutputProfile '+ref(iccId)+'>>';
 w.set(catalogId,'<</Type /Catalog /Pages '+ref(pagesId)+outlinesRef+' /StructTreeRoot '+ref(structRootId)+' /MarkInfo <</Marked true>> /Lang '+pdfString(meta.lang)+' /ViewerPreferences <</DisplayDocTitle true>> /Metadata '+ref(metadataId)+' /OutputIntents ['+outputIntent+']>>');
 const date=pdfDate(meta.generatedAt);
 const infoId=w.add('<</Title '+pdfString(meta.title)+' /Subject '+pdfString(subject)+' /Keywords '+pdfString(keywords)+' /Producer '+pdfString(PRODUCER)+' /Creator '+pdfString(PRODUCER)+' /CreationDate ('+date+') /ModDate ('+date+')>>');
 const id=(await sha256Hex(meta.editionDigest+'\0'+RENDER_PROFILE_ID+'\0'+meta.profileKey)).slice(0,32);
 const bytes=w.serialize(' /Root '+ref(catalogId)+' /Info '+ref(infoId)+' /ID [<'+id+'> <'+id+'>]');
 const notdef=[...fontUses.values()].some(use=>use.missing.size>0);
 return {bytes,usedStyles:[...fontUses.keys()],notdef,documentId:id};
}

/** Canonical key of the render profile used for the deterministic /ID. */
export const profileKey=profile=>JSON.stringify({pageSize:profile.pageSize,margins:profile.margins,lineNumbers:profile.lineNumbers,watermark:profile.watermark,fontSize:profile.fontSize,cover:profile.cover,toc:profile.toc,tableHeaderRow:profile.tableHeaderRow,signatures:profile.signatures.length});

export const NOTDEF_WARNING='The PDF draws .notdef for missing characters; PDF/A-2 forbids .notdef references, so this file is not PDF/A-2b conformant';

/** Renders a validated legal edition to PDF. */
export async function renderPdf({document,fonts,editionDigest,version,options={}}) {
 const doc=await prepareExport({document,editionDigest,version,validate:validateLegalDocument});
 const profile=normalizeLayoutOptions(options);requireTimestamp(profile.generatedAt);
 const parsed=parseFontSet(fonts);
 const layout=layoutDocument({document:doc,fonts:parsed,editionDigest,version,options});
 const result=await writePdf({layout,fonts:parsed,meta:{title:doc.metadata.title,lang:doc.metadata.locale,editionDigest,generatedAt:profile.generatedAt,version,documentId:doc.id,profileKey:profileKey(profile)}});
 const warnings=[...layout.warnings,...(result.notdef?[NOTDEF_WARNING]:[])];
 const manifest=await exportManifest({doc,format:'pdf',editionDigest,version,profile,fonts:await fontEntries(parsed,result.usedStyles),bytes:result.bytes,pageCount:layout.pageCount,warnings});
 return {bytes:result.bytes,manifest};
}
