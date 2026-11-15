import test from 'node:test';
import assert from 'node:assert/strict';
import {legalDocumentDigest,legalPlainText,validateLegalDocument} from '../src/legal-schema.mjs';
import {exportDocument,redactDocument,REDACTION_TOKEN} from '../src/export/index.mjs';
import {PdfReader,readStructure} from './support/pdf-reader.mjs';
import {readZip} from './support/zip-reader.mjs';
import {legalFixture,fonts,GENERATED_AT,SECRET} from './support/export-fixture.mjs';

function sensitiveDocument() {
 const d=structuredClone(legalFixture());
 d.content[1].children[0].inlines=[{kind:'text',text:'Contact '},{kind:'text',text:SECRET.slice(0,12),marks:['bold']},{kind:'text',text:SECRET.slice(12)+' for the records.'}];
 d.content.find(n=>n.id==='fn1').inlines=[{kind:'text',text:'Source: '+SECRET}];
 const formats=d.content[1].children[2].children[0];
 formats.inlines[1]={kind:'link',targetUrl:'https://data.example.gov/formats',label:SECRET};
 return validateLegalDocument(d);
}
const forms=text=>[Buffer.from(text,'utf8'),Buffer.from(text,'latin1'),Buffer.from(text,'utf16le').swap16(),Buffer.from(text,'utf16le'),Buffer.from(text.split(' ').at(-1),'utf8')];
const assertAbsent=(bytes,where)=>{const buf=Buffer.from(bytes);for(const form of forms(SECRET))assert(!buf.includes(form),'secret bytes found in '+where);};

const source=sensitiveDocument();
const snapshot=JSON.stringify(source);
const {document:redacted,provenance}=await redactDocument(source,{nodeIds:['fn1','p2b-0'],ranges:[{nodeId:'p2-0',start:'Contact '.length,end:'Contact '.length+SECRET.length}],reason:'Protects an informant'});
const exportAs=format=>exportDocument({document:redacted,format,editionDigest:legalDocumentDigest(redacted),version:6,fonts,options:{generatedAt:GENERATED_AT,redactionProvenance:provenance}});

test('redaction derives a new document and never mutates the input',()=>{
 assert.equal(JSON.stringify(source),snapshot);
 assert(legalPlainText(source).includes(SECRET));
 const plain=legalPlainText(redacted);
 assert(!plain.includes(SECRET)&&!plain.includes('Quintero'));
 assert.equal(redacted.content[1].children[0].inlines.map(r=>r.text).join(''),'Contact '+REDACTION_TOKEN+' for the records.');
 assert.deepEqual(redacted.content.find(n=>n.id==='fn1').inlines,[{kind:'text',text:REDACTION_TOKEN}]);
 assert(Object.isFrozen(redacted));
});

test('provenance binds the source edition and lists each redaction with its reason',()=>{
 assert.equal(provenance.derivedFromDigest,legalDocumentDigest(source));
 assert.equal(provenance.derivedDigest,legalDocumentDigest(redacted));
 assert.deepEqual(provenance.redactions,[{nodeId:'fn1',reason:'Protects an informant'},{nodeId:'p2b-0',reason:'Protects an informant'},{nodeId:'p2-0',reason:'Protects an informant'}]);
 assert.match(provenance.statement,new RegExp(provenance.derivedFromDigest));
 assert(!provenance.statement.includes(SECRET));assert.deepEqual(provenance.warnings,[]);
});

test('PDF of the redacted edition: secret absent from raw bytes, inflated streams, ToUnicode-extracted text and metadata',async()=>{
 const out=await exportAs('pdf');
 assertAbsent(out.bytes,'raw PDF');
 const reader=new PdfReader(out.bytes);
 for(const [num,object] of reader.allObjects())if(object.raw)assertAbsent(reader.streamData(object),'stream '+num);
 const s=readStructure(reader);
 const text=s.content.map(c=>c.segments.map(seg=>seg.actualText??seg.text).join('')).join('\n');
 assert(text.includes(REDACTION_TOKEN));assert(!text.includes('Quintero'));
 assert.deepEqual(out.manifest.redaction,provenance);
 assertAbsent(Buffer.from(JSON.stringify(out.manifest)),'manifest');
});

test('DOCX, HTML, text and JSON exports contain no byte of the secret',async()=>{
 const docx=await exportAs('docx');
 assertAbsent(docx.bytes,'DOCX container');
 for(const [name,entry] of readZip(docx.bytes))assertAbsent(entry.data,'DOCX part '+name);
 for(const format of ['html','text','json']) {
  const out=await exportAs(format);
  assertAbsent(out.bytes,format);
  assert(Buffer.from(out.bytes).includes(REDACTION_TOKEN));
 }
 const json=JSON.parse(Buffer.from((await exportAs('json')).bytes).toString());
 assert.deepEqual(json.manifest.redaction,JSON.parse(JSON.stringify(provenance)));
});

test('redaction requests fail closed',async()=>{
 const reason='Privacy';
 for(const [options,code] of [[{nodeIds:['missing'],reason},'REDACTION_TARGET_UNKNOWN'],[{nodeIds:['s1']},'INVALID_REDACTION'],[{reason},'INVALID_REDACTION'],
  [{ranges:[{nodeId:'p2-0',start:0,end:9999}],reason},'INVALID_REDACTION'],[{ranges:[{nodeId:'p2-0',start:0,end:10},{nodeId:'p2-0',start:5,end:12}],reason},'INVALID_REDACTION'],[{ranges:[{nodeId:'s1',start:0,end:1}],reason},'REDACTION_TARGET_UNKNOWN']])
  await assert.rejects(redactDocument(source,options),{code});
 const surrogate=validateLegalDocument({...structuredClone(source),content:[{kind:'paragraph',id:'x',inlines:[{kind:'text',text:'a\u{1F600}b'}]}]});
 await assert.rejects(redactDocument(surrogate,{ranges:[{nodeId:'x',start:0,end:2}],reason}),{code:'INVALID_REDACTION'});
 const repeated=await redactDocument(validateLegalDocument({...structuredClone(source),content:[{kind:'paragraph',id:'a',inlines:[{kind:'text',text:'Name Alpha here'}]},{kind:'paragraph',id:'b',inlines:[{kind:'text',text:'Alpha again'}]}]}),{ranges:[{nodeId:'a',start:5,end:10}],reason});
 assert.equal(repeated.provenance.warnings.length,1,'text that survives elsewhere is flagged');
});
