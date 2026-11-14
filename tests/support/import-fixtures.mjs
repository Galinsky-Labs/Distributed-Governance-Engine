// Test-only builders for import fixtures. Everything is generated in code; no binary fixtures.
import zlib from 'node:zlib';

const encoder=new TextEncoder();
export const bytesOf=value=>typeof value==='string'?encoder.encode(value):value;

/**
 * Minimal ZIP writer. Each entry may override header fields to produce malformed archives:
 * {name, data, method, flags, crc, size, compressedSize, localName, localFlags, extra, rawCompressed}.
 */
export function zip(entries,{eocd={},zip64Locator=false,comment=''}={}) {
 const locals=[],centrals=[];let offset=0;
 for(const entry of entries) {
  const data=bytesOf(entry.data??'');
  const method=entry.method??8;
  const compressed=entry.rawCompressed??(method===8?zlib.deflateRawSync(data):data);
  const name=bytesOf(entry.name),localName=bytesOf(entry.localName??entry.name),extra=entry.extra??new Uint8Array(0);
  const crc=entry.crc??zlib.crc32(data);
  const flags=entry.flags??0x0800;
  const size=entry.size??data.length,compressedSize=entry.compressedSize??compressed.length;
  const local=Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50,0);local.writeUInt16LE(20,4);local.writeUInt16LE(entry.localFlags??flags,6);local.writeUInt16LE(entry.localMethod??method,8);
  local.writeUInt32LE(entry.localCrc??crc,14);local.writeUInt32LE(compressedSize,18);local.writeUInt32LE(size,22);
  local.writeUInt16LE(localName.length,26);local.writeUInt16LE(0,28);
  const localOffset=entry.localOffset??offset;
  locals.push(local,localName,compressed);
  offset+=local.length+localName.length+compressed.length;
  const central=Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50,0);central.writeUInt16LE(20,4);central.writeUInt16LE(20,6);central.writeUInt16LE(flags,8);central.writeUInt16LE(method,10);
  central.writeUInt32LE(crc,16);central.writeUInt32LE(compressedSize,20);central.writeUInt32LE(size,24);
  central.writeUInt16LE(name.length,28);central.writeUInt16LE(extra.length,30);central.writeUInt32LE(localOffset,42);
  centrals.push(central,name,extra);
 }
 const cd=Buffer.concat(centrals),cdOffset=offset;
 const locator=Buffer.alloc(zip64Locator?20:0);if(zip64Locator)locator.writeUInt32LE(0x07064b50,0);
 const end=Buffer.alloc(22),commentBytes=bytesOf(comment);
 end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(eocd.disk??0,4);end.writeUInt16LE(0,6);
 end.writeUInt16LE(eocd.diskEntries??entries.length,8);end.writeUInt16LE(eocd.count??entries.length,10);
 end.writeUInt32LE(eocd.cdSize??cd.length,12);end.writeUInt32LE(eocd.cdOffset??cdOffset,16);end.writeUInt16LE(commentBytes.length,20);
 return new Uint8Array(Buffer.concat([...locals,cd,locator,end,commentBytes]));
}

/** Deterministic PRNG (mulberry32) so fuzz failures are reproducible from the seed. */
export function prng(seed) {
 let state=seed>>>0;
 return ()=>{state=(state+0x6d2b79f5)>>>0;let t=state;t=Math.imul(t^(t>>>15),t|1);t^=t+Math.imul(t^(t>>>7),t|61);return ((t^(t>>>14))>>>0)/4294967296;};
}
export function mutateBytes(input,random,rounds=1+Math.floor(random()*4)) {
 let out=Uint8Array.from(input);
 const pick=n=>Math.floor(random()*n);
 for(let r=0;r<rounds;r++) {
  const op=pick(6),at=pick(Math.max(1,out.length));
  if(op===0&&out.length)out[at]^=1<<pick(8);
  else if(op===1&&out.length)out[at]=pick(256);
  else if(op===2)out=out.slice(0,at);
  else if(op===3){const len=1+pick(16),insert=Uint8Array.from({length:len},()=>pick(256));out=Uint8Array.from([...out.subarray(0,at),...insert,...out.subarray(at)]);}
  else if(op===4&&out.length){const len=pick(Math.min(64,out.length-at)+1);out=Uint8Array.from([...out.subarray(0,at),...out.subarray(at+len)]);}
  else if(out.length){const from=pick(out.length),len=pick(Math.min(32,out.length-from)+1);out=Uint8Array.from([...out.subarray(0,at),...out.subarray(from,from+len),...out.subarray(at)]);}
 }
 return out;
}
const TOKENS=['<','>','</','/>','"','&','&#0;','&#x110000;','&amp;','<!DOCTYPE x>','<![CDATA[',']]>','<!--','-->','<?pi?>','=',' ','\u0000','\uD800','<w:p>','</w:p>','<w:r><w:t>x</w:t></w:r>','<w:tbl>','<w:tr><w:tc>','<w:ilvl w:val="99"/>','<script>','</script>','<a href="javascript:x">','(a) ','# ','\n\n','SEC. 1. ','<table:table-row>','<text:list>','BT','ET','Tj','TJ','/F1 12 Tf','(x)','<<','>>','[',']','obj','endobj','stream','endstream','R','9999999999'];
/** Structure-aware text mutation: splices markup tokens and slices into otherwise valid input. */
export function mutateText(input,random,rounds=1+Math.floor(random()*4)) {
 let out=input;
 const pick=n=>Math.floor(random()*n);
 for(let r=0;r<rounds;r++) {
  const at=pick(out.length+1),op=pick(4);
  if(op===0)out=out.slice(0,at)+TOKENS[pick(TOKENS.length)]+out.slice(at);
  else if(op===1)out=out.slice(0,at)+out.slice(at+pick(40));
  else if(op===2){const from=pick(out.length+1);out=out.slice(0,at)+out.slice(from,from+pick(80))+out.slice(at);}
  else out=out.slice(0,at);
 }
 return out;
}

export const W_NS='http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R_NS='http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const REL_BASE='http://schemas.openxmlformats.org/officeDocument/2006/relationships';
export const wordXml=(root,body)=>`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:${root} xmlns:w="${W_NS}" xmlns:r="${R_NS}" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">${body}</w:${root}>`;
export const relationship=(id,type,target,external=false)=>`<Relationship Id="${id}" Type="${REL_BASE}/${type}" Target="${target}"${external?' TargetMode="External"':''}/>`;

/** Build a DOCX package. `parts` adds or overrides raw entries by name. */
export function docx({body,styles,numbering,footnotes,rels=[],parts={},macroEnabled=false}) {
 const main=macroEnabled?'application/vnd.ms-word.document.macroEnabled.main+xml':'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml';
 const files={
  '[Content_Types].xml':`<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="${main}"/></Types>`,
  '_rels/.rels':`<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationship('rId1','officeDocument','word/document.xml')}</Relationships>`,
  'word/document.xml':wordXml('document',`<w:body>${body}<w:sectPr/></w:body>`),
  'word/_rels/document.xml.rels':`<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join('')}</Relationships>`
 };
 if(styles!==undefined)files['word/styles.xml']=wordXml('styles',styles);
 if(numbering!==undefined)files['word/numbering.xml']=wordXml('numbering',numbering);
 if(footnotes!==undefined)files['word/footnotes.xml']=wordXml('footnotes',footnotes);
 Object.assign(files,parts);
 return zip(Object.entries(files).filter(([,data])=>data!==null).map(([name,data])=>({name,data})));
}
export const HEADING_STYLES=[1,2,3].map(n=>`<w:style w:type="paragraph" w:styleId="Heading${n}"><w:name w:val="heading ${n}"/><w:pPr><w:outlineLvl w:val="${n-1}"/></w:pPr></w:style>`).join('')
 +'<w:style w:type="character" w:styleId="Strong"><w:name w:val="Strong"/><w:rPr><w:b/></w:rPr></w:style>';
export const p=(content,props='')=>`<w:p>${props?`<w:pPr>${props}</w:pPr>`:''}${content}</w:p>`;
export const r=(text,props='')=>`<w:r>${props?`<w:rPr>${props}</w:rPr>`:''}<w:t xml:space="preserve">${text}</w:t></w:r>`;
export const heading=(level,text)=>p(r(text),`<w:pStyle w:val="Heading${level}"/>`);
export const numbered=(numId,ilvl,text)=>p(r(text),`<w:numPr><w:ilvl w:val="${ilvl}"/><w:numId w:val="${numId}"/></w:numPr>`);
export const cell=content=>`<w:tc>${content}</w:tc>`;
export const table=rows=>`<w:tbl><w:tblPr/>${rows.map(row=>`<w:tr>${row.map(c=>cell(p(r(c)))).join('')}</w:tr>`).join('')}</w:tbl>`;
export const NUMBERING=`<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="lowerLetter"/></w:lvl><w:lvl w:ilvl="1"><w:numFmt w:val="decimal"/></w:lvl><w:lvl w:ilvl="2"><w:numFmt w:val="upperLetter"/></w:lvl></w:abstractNum>`
 +`<w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>`;

const ODT_MIME='application/vnd.oasis.opendocument.text';
const ODT_NS='xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:script="urn:oasis:names:tc:opendocument:xmlns:script:1.0" xmlns:dc="http://purl.org/dc/elements/1.1/"';
export function odt({body,automaticStyles='',styles='',parts={},mimetype=ODT_MIME}) {
 const files={
  mimetype,
  'META-INF/manifest.xml':`<?xml version="1.0" encoding="UTF-8"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"><manifest:file-entry manifest:full-path="/" manifest:media-type="${ODT_MIME}"/></manifest:manifest>`,
  'content.xml':`<?xml version="1.0" encoding="UTF-8"?><office:document-content ${ODT_NS} office:version="1.3"><office:automatic-styles>${automaticStyles}</office:automatic-styles><office:body><office:text>${body}</office:text></office:body></office:document-content>`,
  'styles.xml':`<?xml version="1.0" encoding="UTF-8"?><office:document-styles ${ODT_NS} office:version="1.3"><office:styles>${styles}</office:styles></office:document-styles>`
 };
 Object.assign(files,parts);
 return zip(Object.entries(files).filter(([,data])=>data!==null).map(([name,data])=>({name,data,method:name==='mimetype'?0:8})));
}

const latin1=s=>Uint8Array.from(s,c=>c.charCodeAt(0)&0xff);
/**
 * Classic PDF with an xref table. `objects` are bodies for objects 1..n (strings or
 * {dict, stream:Uint8Array|string}); object 1 must be the catalog.
 */
export function pdf(objects,{trailer='',xrefOffsetDelta=0}={}) {
 const chunks=['%PDF-1.4\n%\xE2\xE3\xCF\xD3\n'];let length=chunks[0].length;const offsets=[];
 objects.forEach((object,i)=>{
  offsets.push(length);
  let body;
  if(typeof object==='string')body=`${i+1} 0 obj\n${object}\nendobj\n`;
  else{const data=typeof object.stream==='string'?object.stream:String.fromCharCode(...object.stream);body=`${i+1} 0 obj\n<<${object.dict} /Length ${data.length}>>\nstream\n${data}\nendstream\nendobj\n`;}
  chunks.push(body);length+=body.length;
 });
 const xref=length;
 let table=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`;
 for(const o of offsets)table+=String(o).padStart(10,'0')+' 00000 n \n';
 chunks.push(table+`trailer\n<< /Size ${objects.length+1} /Root 1 0 R ${trailer}>>\nstartxref\n${xref+xrefOffsetDelta}\n%%EOF\n`);
 return latin1(chunks.join(''));
}
const deflate=s=>new Uint8Array(zlib.deflateSync(typeof s==='string'?latin1(s):s));
/** PNG "Up" predictor rows (predictor 12) as PDF writers emit for xref streams. */
function pngUp(rows,width) {
 const out=[];let previous=new Uint8Array(width);
 for(const row of rows){out.push(2);for(let i=0;i<width;i++)out.push((row[i]-previous[i])&0xff);previous=row;}
 return Uint8Array.from(out);
}
/**
 * PDF 1.5 layout: page content and font in an object stream, an xref stream with a PNG
 * predictor, FlateDecode content and a ToUnicode CMap mapping 2-byte codes.
 */
export function pdfWithObjectStreams({content,cmap}) {
 const header='%PDF-1.5\n%\xE2\xE3\xCF\xD3\n';
 const compressedObjects={
  2:'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  3:'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
  4:'<< /Type /Font /Subtype /Type0 /BaseFont /Custom /Encoding /Identity-H /DescendantFonts [7 0 R] /ToUnicode 6 0 R >>',
  7:'<< /Type /Font /Subtype /CIDFontType2 /BaseFont /Custom /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /DW 500 >>'
 };
 const numbers=Object.keys(compressedObjects).map(Number);
 let headerPart='',bodyPart='';
 for(const n of numbers){headerPart+=`${n} ${bodyPart.length} `;bodyPart+=compressedObjects[n]+'\n';}
 const objStm=deflate(headerPart+bodyPart);
 const pieces=[];let length=header.length;const offsets={};
 const add=(n,dict,data)=>{offsets[n]=length;const head=`${n} 0 obj\n<<${dict} /Length ${data.length}>>\nstream\n`,tail='\nendstream\nendobj\n';pieces.push(latin1(head),data,latin1(tail));length+=head.length+data.length+tail.length;};
 const addPlain=(n,body)=>{offsets[n]=length;const text=`${n} 0 obj\n${body}\nendobj\n`;pieces.push(latin1(text));length+=text.length;};
 addPlain(1,'<< /Type /Catalog /Pages 2 0 R >>');
 add(5,' /Filter /FlateDecode',deflate(content));
 add(6,' /Filter /FlateDecode',deflate(cmap));
 add(8,` /Type /ObjStm /N ${numbers.length} /First ${headerPart.length} /Filter /FlateDecode`,objStm);
 const xrefOffset=length;
 const rows=[];
 for(let n=0;n<=9;n++) {
  if(n===0)rows.push(Uint8Array.of(0,0,0,0,255));
  else if(compressedObjects[n]!==undefined)rows.push(Uint8Array.of(2,0,8,0,numbers.indexOf(n)));
  else if(n===9)rows.push(Uint8Array.of(1,(xrefOffset>>16)&255,(xrefOffset>>8)&255,xrefOffset&255,0));
  else rows.push(Uint8Array.of(1,(offsets[n]>>16)&255,(offsets[n]>>8)&255,offsets[n]&255,0));
 }
 add(9,' /Type /XRef /Size 10 /W [1 3 1] /Root 1 0 R /Filter /FlateDecode /DecodeParms << /Predictor 12 /Columns 5 >>',deflate(pngUp(rows,5)));
 pieces.push(latin1(`startxref\n${xrefOffset}\n%%EOF\n`));
 return new Uint8Array(Buffer.concat([latin1(header),...pieces]));
}
