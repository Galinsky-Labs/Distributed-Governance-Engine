import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import {importPdfText} from '../src/import/pdf.mjs';
import {ImportError} from '../src/import/errors.mjs';
import {validateLegalDocument} from '../src/legal-structure.mjs';
import {pdf,pdfWithObjectStreams,prng,mutateText,mutateBytes,outline} from './support/import-fixtures.mjs';

const options=()=>{let n=0;return {tenantId:'org',documentId:'doc',idFactory:()=>'n'+(++n)};};
const rejects=(promise,code,pattern)=>assert.rejects(promise,error=>error instanceof ImportError&&error.code===code&&(!pattern||pattern.test(error.message)));

const PAGE_ONE='BT /F1 12 Tf 72 720 Td (SECTION 1. PURPOSE.) Tj ET\n'
 +'BT /F1 12 Tf 72 690 Td (The Board shall) Tj 0 -14 Td [(publish) -300 (the) -300 (rep) 20 (ort.)] TJ ET\n'
 +'BT /F1 12 Tf 14 TL 72 650 Td ((a) In general.) Tj T* ((b) Exception \\(narrow\\) under \\247 2.) Tj ET';
const PAGE_TWO='q 1 0 0 1 0 0 cm BT /F1 12 Tf 72 720 Td (SECTION 2. EFFECTIVE DATE.) Tj ET Q\n'
 +'BT /F1 12 Tf 72 700 Td (Takes effect on enactment) Tj ( \\226 now.) Tj ET';
function classicPdf({pageOne=PAGE_ONE,trailer=''}={}) {
 return pdf([
  '<< /Type /Catalog /Pages 2 0 R /OpenAction << /S /JavaScript /JS (app.alert\\(1\\)) >> >>',
  '<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 /Resources << /Font << /F1 4 0 R >> >> >>',
  '<< /Type /Page /Parent 2 0 R /Contents 5 0 R /Annots [<< /Subtype /Link /A << /S /URI /URI (https://evil.example/) >> >>] >>',
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  {dict:'',stream:pageOne},
  '<< /Type /Page /Parent 2 0 R /Contents [7 0 R] >>',
  {dict:'',stream:PAGE_TWO}
 ],{trailer});
}

const CODES=new Map([['S',1],['\u00A7',2],[' ',0x30],['\u{1F600}',0x31]]);
for(let i=0;i<26;i++)CODES.set(String.fromCharCode(97+i),0x10+i);
const hex=text=>'<'+[...text].map(c=>CODES.get(c).toString(16).padStart(4,'0')).join('')+'>';
const CMAP='/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CMapName /Custom def 1 begincodespacerange <0000> <FFFF> endcodespacerange\n'
 +'2 beginbfchar <0001> <0053> <0002> <00A7> endbfchar\n2 beginbfrange <0010> <0029> <0061> <0030> <0031> [<0020> <D83DDE00>] endbfrange endcmap CMapName currentdict /CMap defineresource pop end end';
const COMPRESSED_CONTENT=`BT /F1 12 Tf 72 700 Td ${hex('Sample text')} Tj 0 -14 Td [${hex('continues')} -400 ${hex('here')}] TJ ET\nBT /F1 12 Tf 72 640 Td ${hex('\u00A7 more \u{1F600}')} Tj ET`;

test('uncompressed PDF: page order, Td/TJ/T*/quote operators, WinAnsi and structure heuristics',async()=>{
 const {document,report}=await importPdfText(classicPdf(),options());
 validateLegalDocument(document);
 assert.deepEqual(outline(document.content),[
  ['section','PURPOSE.','The Board shall publish the report.',['list','lower-alpha',['list-item','In general.'],['list-item','Exception (narrow) under \u00A7 2.']]],
  ['section','EFFECTIVE DATE.','Takes effect on enactment \u2013 now.']
 ]);
 assert.equal(report.format,'pdf');assert.equal(report.provisional,true);
 assert.match(report.provisionalReason,/review/);assert.match(report.provisionalReason,/OCR is not implemented/);
 assert.equal(report.discarded.scripts,1);assert.equal(report.discarded.externalReferences,1);
 assert(!JSON.stringify(document).includes('evil.example'));
});

test('FlateDecode with xref stream, PNG predictor, object stream and ToUnicode CMap',async()=>{
 const {document,report}=await importPdfText(pdfWithObjectStreams({content:COMPRESSED_CONTENT,cmap:CMAP}),options());
 validateLegalDocument(document);
 assert.deepEqual(outline(document.content),['Sample text continues here','\u00A7 more \u{1F600}']);
 assert.equal(report.provisional,true);
 assert.deepEqual(report.warnings,[]);
});

test('broken cross-references are recovered by scanning objects',async()=>{
 const shifted=pdf(['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',{dict:'',stream:'BT /F1 12 Tf 72 700 Td (Recovered text) Tj ET'}],{xrefOffsetDelta:7});
 assert.deepEqual(outline((await importPdfText(shifted,options())).document.content),['Recovered text']);
 const noXref=Uint8Array.from(Buffer.from(shifted).toString('latin1').replace(/xref[\s\S]*$/,'trailer << /Root 1 0 R >>\n%%EOF'),c=>c.charCodeAt(0));
 assert.deepEqual(outline((await importPdfText(noXref,options())).document.content),['Recovered text']);
});

test('encrypted, image-only, undecodable and oversized PDFs fail with typed errors',async()=>{
 await rejects(importPdfText(classicPdf({trailer:'/Encrypt << /Filter /Standard /V 2 >>'}),options()),'PDF_ENCRYPTED');
 const imageOnly=pdf(['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /Resources << /XObject << /Im1 5 0 R >> >> /Contents 4 0 R >>',{dict:'',stream:'q 612 0 0 792 0 0 cm /Im1 Do Q BI /W 1 /H 1 /CS /G /BPC 8 ID \xff EI'},{dict:' /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8',stream:'\x00'}]);
 await rejects(importPdfText(imageOnly,options()),'PDF_NO_TEXT_LAYER',/OCR is not implemented/);
 const cidWithoutMap=pdf(['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type0 /BaseFont /X /Encoding /Identity-H /DescendantFonts [<< /Subtype /CIDFontType2 >>] >>',{dict:'',stream:'BT /F1 12 Tf 72 700 Td <00010002> Tj ET'}]);
 await rejects(importPdfText(cidWithoutMap,options()),'PDF_UNSUPPORTED');
 const lzw=pdf(['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>',{dict:' /Filter /LZWDecode',stream:'xx'}]);
 await rejects(importPdfText(lzw,options()),'PDF_UNSUPPORTED');
 await rejects(importPdfText(new TextEncoder().encode('not a pdf'),options()),'PDF_UNSUPPORTED');
 await rejects(importPdfText(classicPdf(),{...options(),limits:{maxPages:1}}),'DOCUMENT_TOO_LARGE');
 const bomb=pdfWithObjectStreams({content:COMPRESSED_CONTENT+' '.repeat(5000),cmap:CMAP});
 await rejects(importPdfText(bomb,{...options(),limits:{maxInflatedBytes:2000}}),'DOCUMENT_TOO_LARGE');
 const flate=zlib.deflateSync(Buffer.alloc(3*1024*1024,32)).toString('latin1');
 const zeros=pdf(['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>',{dict:' /Filter /FlateDecode',stream:flate}]);
 await rejects(importPdfText(zeros,{...options(),limits:{maxInflatedBytes:1024*1024}}),'DOCUMENT_TOO_LARGE');
 const cyclic=pdf(['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [2 0 R 3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',{dict:'',stream:'BT /F1 12 Tf (Once) Tj ET'}]);
 assert.deepEqual(outline((await importPdfText(cyclic,options())).document.content),['Once']);
});

test('mutation fuzzing of PDF bytes and content streams yields a document or ImportError only',async()=>{
 const random=prng(31337);
 const check=async(bytes,label)=>{
  try{validateLegalDocument((await importPdfText(bytes,options())).document);}
  catch(error){assert(error instanceof ImportError,`${label}: ${error?.stack}`);}
 };
 const classic=classicPdf(),compressed=pdfWithObjectStreams({content:COMPRESSED_CONTENT,cmap:CMAP});
 for(let i=0;i<150;i++)await check(mutateBytes(classic,random),`classic byte case ${i}`);
 for(let i=0;i<150;i++)await check(mutateBytes(compressed,random),`compressed byte case ${i}`);
 for(let i=0;i<150;i++)await check(classicPdf({pageOne:mutateText(PAGE_ONE,random)}),`content case ${i}`);
 for(let i=0;i<60;i++)await check(pdfWithObjectStreams({content:mutateText(COMPRESSED_CONTENT,random),cmap:mutateText(CMAP,random)}),`cmap case ${i}`);
});
