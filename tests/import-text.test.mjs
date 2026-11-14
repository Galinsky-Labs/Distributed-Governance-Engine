import test from 'node:test';
import assert from 'node:assert/strict';
import {importPlainText} from '../src/import/text.mjs';
import {ImportError} from '../src/import/errors.mjs';
import {validateLegalDocument} from '../src/legal-structure.mjs';
import {prng,mutateText,outline} from './support/import-fixtures.mjs';

const options=()=>{let n=0;return {tenantId:'org',documentId:'doc',idFactory:()=>'n'+(++n)};};
const throwsCode=(fn,code)=>assert.throws(fn,error=>error instanceof ImportError&&error.code===code);

test('legal headings, nested (a)/(1)/(i) markers and paragraphs keep exact text',()=>{
 const source='ARTICLE I\r\n\r\nSection 1. Definitions\r\nIn this Act:\r\n(a) Agency.\u2014The term "agency" means\r\n  any office.\r\n(1) first  item\r\n(2) second\r\n(i) roman\r\n(b) Board.\r\n\r\nSEC. 2. EFFECTIVE DATE.\r\n\r\n   This Act takes effect   on enactment.\r\nSecond line.\r\n\r\n- one\r\n* two\r\n';
 const {document,report}=importPlainText(source,options());
 validateLegalDocument(document);
 assert.equal(document.mode,'collaboration');assert.equal(document.lifecycle,'draft');
 assert.deepEqual(outline(document.content),[
  ['section','ARTICLE I',
   ['section','Definitions','In this Act:',
    ['list','lower-alpha',
     ['list-item','Agency.\u2014The term "agency" means\n  any office.',['list','decimal',['list-item','first  item'],['list-item','second',['list','lower-roman',['list-item','roman']]]]],
     ['list-item','Board.']]],
   ['section','EFFECTIVE DATE.','   This Act takes effect   on enactment.\nSecond line.',['list','bullet',['list-item','one'],['list-item','two']]]]
 ]);
 assert.deepEqual(report.numbering.sourceLabels,['Section 1.','(a)','(1)','(2)','(i)','(b)','SEC. 2.']);
 assert.equal(report.format,'text');assert.equal(report.provisional,false);
 assert.deepEqual(report.structure,{sections:3,paragraphs:9,lists:4,tables:0,footnotes:0,links:0,characters:report.structure.characters});
});

test('markdown and all-caps headings nest; (h)/(i) is read as alphabetic in context',()=>{
 const {document}=importPlainText('# Title\n\n## Part\n\nBody\n\n###### Deep\n\nGENERAL PROVISIONS\n\n(g) g\n(h) h\n(i) i\n(ii) roman',options());
 assert.deepEqual(outline(document.content),[
  ['section','Title',['section','Part','Body',['section','Deep','']]],
  ['section','GENERAL PROVISIONS',['list','lower-alpha',['list-item','g'],['list-item','h'],['list-item','i',['list','lower-roman',['list-item','roman']]]]]
 ]);
});

test('unclear prefixes stay verbatim and empty input yields one empty paragraph',()=>{
 const {document,report}=importPlainText('Section 1.\n\nText\n\n1999 BUDGET ACT',options());
 assert.deepEqual(outline(document.content),[['section','Section 1.','Text',['section','1999 BUDGET ACT','']]]);
 assert.deepEqual(report.numbering.sourceLabels,[]);
 const empty=importPlainText('\n \n',options());
 assert.deepEqual(outline(empty.document.content),['']);
 assert.equal(empty.report.warnings[0].code,'EMPTY_DOCUMENT');
});

test('NUL, lone surrogates and oversized input fail with typed errors',()=>{
 throwsCode(()=>importPlainText('a\0b',options()),'INVALID_TEXT');
 throwsCode(()=>importPlainText('a'+String.fromCharCode(0xd800)+'b',options()),'INVALID_TEXT');
 throwsCode(()=>importPlainText('x'.repeat(3000001),options()),'DOCUMENT_TOO_LARGE');
 throwsCode(()=>importPlainText(Array.from({length:10001},(_,i)=>'p'+i).join('\n\n'),options()),'DOCUMENT_TOO_LARGE');
 assert.throws(()=>importPlainText('x',{tenantId:'bad id'}),TypeError);
 assert.throws(()=>importPlainText(42,options()),TypeError);
});

test('default IDs are UUIDs and the title falls back to the file name',()=>{
 const {document}=importPlainText('Hello',{tenantId:'org',fileName:'C:\\docs\\Bylaws 2026.txt'});
 assert.match(document.id,/^[0-9a-f-]{36}$/);assert.match(document.content[0].id,/^[0-9a-f-]{36}$/);
 assert.equal(document.metadata.title,'Bylaws 2026');assert.equal(document.metadata.locale,'en-US');
});

test('mutation fuzzing yields a valid document or ImportError only',()=>{
 const seed='SECTION 1. SHORT TITLE.\n\nThis Act may be cited as the Example Act.\n\n(a) In general.\n(1) One\n(A) Upper\n(i) roman\n\n# Heading\n\n- bullet\n';
 const random=prng(7);
 for(let i=0;i<400;i++) {
  const input=mutateText(seed,random);
  try{validateLegalDocument(importPlainText(input,options()).document);}
  catch(error){assert(error instanceof ImportError,`case ${i}: ${error?.stack}`);}
 }
});
