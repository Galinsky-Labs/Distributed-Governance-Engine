import test from 'node:test';
import assert from 'node:assert/strict';
import {importDocx} from '../src/import/docx.mjs';
import {ImportError} from '../src/import/errors.mjs';
import {validateLegalDocument} from '../src/legal-structure.mjs';
import {docx,zip,p,r,heading,numbered,table,relationship,HEADING_STYLES,NUMBERING,wordXml,prng,mutateText,mutateBytes,outline} from './support/import-fixtures.mjs';

const options=()=>{let n=0;return {tenantId:'org',documentId:'doc',idFactory:()=>'n'+(++n)};};
const rejects=(promise,code)=>assert.rejects(promise,error=>error instanceof ImportError&&error.code===code);

function hostileDocx() {
 const body=[
  heading(1,'Section 1. Definitions'),
  p(r('The ')+r('Board','<w:b/>')+r(' means ')+r('the board','<w:i/><w:u w:val="single"/>')+r(' as ')+r('struck','<w:strike/>')+r(' constituted','<w:b w:val="0"/>')+r('.')+'<w:r><w:footnoteReference w:id="2"/></w:r>'),
  numbered(1,0,'First level (a)'),
  numbered(1,1,'Second level (1)'),
  numbered(1,2,'Third level (A)'),
  numbered(1,0,'Back to first'),
  numbered(2,0,'A bullet'),
  heading(2,'(b) Tracked changes'),
  p(r('Keep ')+'<w:ins w:id="1" w:author="x"><w:r><w:t>inserted </w:t></w:r></w:ins><w:del w:id="2" w:author="x"><w:r><w:delText>deleted secret </w:delText></w:r></w:del>'+r('text.')),
  p('<w:hyperlink r:id="rLink"><w:r><w:t>the statute</w:t></w:r></w:hyperlink>'+r(' and ')+'<w:hyperlink r:id="rJs"><w:r><w:t>a script link</w:t></w:r></w:hyperlink>'+r(' and ')+'<w:hyperlink w:anchor="_Toc1"><w:r><w:t>an anchor</w:t></w:r></w:hyperlink>'),
  p(r('Field: ')+'<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText>HYPERLINK "javascript:alert(1)"</w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>'+r('shown result')+'<w:r><w:fldChar w:fldCharType="end"/></w:r>'),
  p(r('Pictures ')+'<w:r><w:drawing><wp:inline/></w:drawing></w:r><w:r><w:object/></w:r><w:commentRangeStart w:id="0"/><w:r><w:commentReference w:id="0"/></w:r>'+r('hidden','<w:vanish/>')),
  '<w:altChunk r:id="rChunk"/>',
  '<w:customXml w:element="clause">'+p(r('Inside custom XML'))+'</w:customXml>',
  '<w:sdt><w:sdtContent>'+p(r('Inside content control'))+'</w:sdtContent></w:sdt>',
  table([['Term','Meaning'],['Act','This Act']]),
  '<w:tbl><w:tr><w:trPr><w:del w:id="9" w:author="x"/></w:trPr><w:tc>'+p(r('deleted row'))+'</w:tc></w:tr><w:tr><w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr>'+p(r('merged'))+'</w:tc></w:tr><w:tr><w:tc>'+p(r('x'))+'</w:tc><w:tc>'+table([['nested']])+'</w:tc></w:tr></w:tbl>'
 ].join('');
 return docx({
  body,styles:HEADING_STYLES,numbering:NUMBERING,macroEnabled:true,
  footnotes:'<w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote><w:footnote w:id="2"><w:p><w:r><w:footnoteRef/></w:r><w:r><w:t xml:space="preserve"> See 5 U.S.C. 552.</w:t></w:r></w:p></w:footnote>',
  rels:[relationship('rLink','hyperlink','https://law.example.gov/statute#s1',true),relationship('rJs','hyperlink','javascript:alert(1)',true),
   relationship('rChunk','aFChunk','chunk.html'),relationship('rImg','image','https://tracker.example/pixel.png',true)],
  parts:{
   'word/vbaProject.bin':'MACRO PAYLOAD','word/embeddings/oleObject1.bin':'OLE','word/media/image1.png':'PNG',
   'word/chunk.html':'<script>alert(1)</script>','customXml/item1.xml':'<x/>','word/header1.xml':wordXml('hdr',p(r('Header'))),
   'word/_rels/settings.xml.rels':`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationship('rT','attachedTemplate','https://evil.example/template.dotm',true)}</Relationships>`
  }
 });
}

test('DOCX with macros, tracked changes, links, nested numbering, tables and headings maps to the semantic tree',async()=>{
 const {document,report}=await importDocx(hostileDocx(),options());
 validateLegalDocument(document);
 assert.deepEqual(outline(document.content),[
  ['section','Definitions',
   'The Board means the board as struck constituted.^footnote-reference',
   ['list','lower-alpha',
    ['list-item','First level (a)',['list','decimal',['list-item','Second level (1)',['list','upper-alpha',['list-item','Third level (A)']]]]],
    ['list-item','Back to first']],
   ['list','bullet',['list-item','A bullet']],
   ['section','Tracked changes',
    'Keep inserted text.',
    '[the statute](https://law.example.gov/statute#s1) and a script link and an anchor',
    'Field: shown result',
    'Pictures ',
    'Inside custom XML','Inside content control',
    ['table',['table-row',['table-cell','Term'],['table-cell','Meaning']],['table-row',['table-cell','Act'],['table-cell','This Act']]],
    ['table',['table-row',['table-cell','merged'],['table-cell','']],['table-row',['table-cell','x'],['table-cell','nested']]]]],
  ['footnote',' See 5 U.S.C. 552.']
 ]);
 const marks=document.content[0].children[0].inlines.filter(run=>run.marks).map(run=>[run.text,run.marks]);
 assert.deepEqual(marks,[['Board',['bold']],['the board',['italic','underline']],['struck',['strike']]]);
 const footnote=document.content.at(-1);
 assert.equal(document.content[0].children[0].inlines.at(-1).targetId,footnote.id);
 assert.deepEqual(report.discarded,{macros:1,scripts:0,images:1,embeddedObjects:3,externalReferences:2,comments:1,trackedDeletions:2,unsupportedElements:5});
 const codes=report.warnings.map(w=>w.code);
 for(const code of ['MACROS_DISCARDED','TRACKED_INSERTIONS_ACCEPTED','TRACKED_DELETIONS_DROPPED','LINK_NOT_HTTPS','INTERNAL_LINK_AS_TEXT','FIELDS_FLATTENED','ALT_CHUNK_DISCARDED','HIDDEN_TEXT_DISCARDED','HEADERS_FOOTERS_DISCARDED','TABLE_FLATTENED'])assert(codes.includes(code),code);
 assert.deepEqual(report.numbering.sourceLabels,['Section 1.','(b)']);
 assert.deepEqual(report.structure,{sections:2,paragraphs:20,lists:4,tables:2,footnotes:1,links:1,characters:report.structure.characters});
 const json=JSON.stringify(document);
 for(const forbidden of ['deleted secret','alert','javascript','MACRO','evil.example','tracker.example','Header','deleted row','HYPERLINK','hidden'])assert(!json.includes(forbidden),forbidden);
});

test('legal formatting fixture keeps exact text with (a)/(1) nesting and a table',async()=>{
 const text=['In general.\u2014Except as provided in paragraph (2), the  Secretary shall\u2014','publish  the rule; and','not later than 90 days after\tenactment, report.'];
 const bytes=docx({styles:HEADING_STYLES,numbering:NUMBERING,body:heading(1,'SEC. 101. SHORT TITLE.')+p(r('This Act may be cited as the \u201CExample Act of 2026\u201D.'))+numbered(1,0,text[0])+numbered(1,1,text[1])+numbered(1,1,text[2])+table([['Fiscal year','Amount'],['2027','$1,000,000']])});
 const {document,report}=await importDocx(bytes,options());
 assert.deepEqual(outline(document.content),[
  ['section','SHORT TITLE.','This Act may be cited as the \u201CExample Act of 2026\u201D.',
   ['list','lower-alpha',['list-item',text[0],['list','decimal',['list-item',text[1]],['list-item',text[2]]]]],
   ['table',['table-row',['table-cell','Fiscal year'],['table-cell','Amount']],['table-row',['table-cell','2027'],['table-cell','$1,000,000']]]]
 ]);
 assert.deepEqual(report.numbering.sourceLabels,['SEC. 101.']);
 assert.equal(report.warnings.length,0);
});

test('corrupted, truncated, non-Word and hostile XML packages fail with typed errors',async()=>{
 const good=docx({body:p(r('x'))});
 await rejects(importDocx(good.slice(0,good.length-30),options()),'ARCHIVE_INVALID');
 await rejects(importDocx(zip([{name:'readme.txt',data:'x'}]),options()),'UNSUPPORTED_FORMAT');
 await rejects(importDocx(docx({body:p(r('x')),parts:{'word/document.xml':null}}),options()),'UNSUPPORTED_FORMAT');
 await rejects(importDocx(docx({body:'<w:p>'}),options()),'XML_INVALID');
 await rejects(importDocx(docx({body:'',parts:{'word/document.xml':'<!DOCTYPE d [<!ENTITY x SYSTEM "file:///etc/passwd">]><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>&x;</w:t></w:r></w:p></w:body></w:document>'}}),options()),'XML_DOCTYPE_FORBIDDEN');
 await rejects(importDocx(docx({body:p(r('x')),styles:'<w:style>&lol9;</w:style>'}),options()),'XML_INVALID');
 // Discarded parts are never inflated, so an oversized macro project cannot exhaust memory.
 const unopened=await importDocx(docx({body:p(r('x')),parts:{'word/vbaProject.bin':new Uint8Array(30*1024*1024)}}),options());
 assert.equal(unopened.report.discarded.macros,1);
 await rejects(importDocx(docx({body:p(r('x')),parts:{'word/styles.xml':wordXml('styles',' '.repeat(21*1024*1024))}}),options()),'ARCHIVE_LIMIT');
 // Incompressible text so the archive ratio cap is not what stops it: the legal 3 MB byte limit is.
 const noise=prng(1),words=()=>Array.from({length:800},()=>Math.floor(noise()*36**4).toString(36)).join(' ');
 await rejects(importDocx(docx({body:Array.from({length:900},()=>p(r(words()))).join('')}),options()),'DOCUMENT_TOO_LARGE');
 const deepHeadings=await importDocx(docx({body:Array.from({length:9},(_,i)=>p(r('H'+i),`<w:outlineLvl w:val="${i}"/>`)).join('')}),options());
 validateLegalDocument(deepHeadings.document);
 assert(deepHeadings.report.warnings.some(w=>w.code==='HEADING_LEVEL_CLAMPED'));
 const cyclic=await importDocx(docx({body:p(r('x'),'<w:pStyle w:val="A"/>'),styles:'<w:style w:styleId="A"><w:basedOn w:val="B"/></w:style><w:style w:styleId="B"><w:basedOn w:val="A"/></w:style>'}),options());
 assert.deepEqual(outline(cyclic.document.content),['x']);
});

test('mutation fuzzing of document XML and package bytes yields a document or ImportError only',async()=>{
 const random=prng(2026);
 const body=heading(1,'Title')+p(r('Body','<w:b/>')+'<w:r><w:footnoteReference w:id="2"/></w:r>')+numbered(1,0,'a')+numbered(1,1,'b')+table([['1','2']])+p('<w:hyperlink r:id="rLink"><w:r><w:t>link</w:t></w:r></w:hyperlink>');
 const extra={styles:HEADING_STYLES,numbering:NUMBERING,rels:[relationship('rLink','hyperlink','https://e.example/',true)],footnotes:'<w:footnote w:id="2"><w:p><w:r><w:t>note</w:t></w:r></w:p></w:footnote>'};
 const check=async(bytes,label)=>{
  try{validateLegalDocument((await importDocx(bytes,options())).document);}
  catch(error){assert(error instanceof ImportError,`${label}: ${error?.stack}`);}
 };
 for(let i=0;i<200;i++)await check(docx({...extra,body:mutateText(body,random)}),`xml case ${i}`);
 const seed=docx({...extra,body});
 for(let i=0;i<150;i++)await check(mutateBytes(seed,random),`byte case ${i}`);
});
