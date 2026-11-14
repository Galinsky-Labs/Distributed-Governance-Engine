import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {legalPlainText,legalDocumentDigest,validateLegalDocument} from '../src/legal-schema.mjs';
import {exportDocument} from '../src/export/index.mjs';
import {writeZip,crc32} from '../src/export/zip-writer.mjs';
import {readZip,parseXml} from './support/zip-reader.mjs';
import {legalFixture,smallFixture,fonts,GENERATED_AT} from './support/export-fixture.mjs';

const collapse=text=>text.replace(/\s+/g,' ').trim();
const exportDocx=(document,options={})=>exportDocument({document,format:'docx',editionDigest:legalDocumentDigest(document),version:5,fonts,options:{generatedAt:GENERATED_AT,...options}});
const fixture=legalFixture();
const result=await exportDocx(fixture,{lineNumbers:'continuous',signatures:[{name:'Ana Ruiz',signedAt:'2026-11-14T12:00:00Z',intent:'Approve',receiptDigest:'a'.repeat(64),mark:{kind:'typed',text:'Ana Ruiz'}}]});
const parts=readZip(result.bytes);
const xml=name=>parseXml(parts.get(name).data.toString('utf8'));
const has=cmd=>{try{execFileSync('which',[cmd],{stdio:'ignore'});return true;}catch{return false;}};

function paragraphText(p,{skipStyle}={}) {
 let out='';
 for(const el of p.getElementsByTagName('*')) {
  if(el.tagName==='w:t'){const run=el.parentNode;const style=run.getElementsByTagName('w:rStyle')[0]?.getAttribute('w:val');if(skipStyle&&style===skipStyle)continue;out+=el.textContent;}
  else if(el.tagName==='w:tab')out+='\t';else if(el.tagName==='w:br')out+='\n';
 }
 return out;
}
const styleOf=p=>p.getElementsByTagName('w:pStyle')[0]?.getAttribute('w:val')??'';

test('the package is a well-formed DOCX with complete content types and relationships',()=>{
 assert.equal(result.mediaType,'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
 assert.equal(result.fileName,'municipal-data-transparency-act-r4-v5.docx');
 for(const [name,entry] of parts){if(name.endsWith('.xml')||name.endsWith('.rels'))xml(name);assert.equal(entry.date,33);assert.equal(entry.time,0);}
 const types=xml('[Content_Types].xml');
 const overrides=new Set([...types.getElementsByTagName('Override')].map(o=>o.getAttribute('PartName')));
 for(const name of parts.keys())if(!name.endsWith('.rels')&&name!=='[Content_Types].xml')assert(overrides.has('/'+name),'content type missing for '+name);
 for(const part of overrides)assert(parts.has(part.slice(1)),'override for missing part '+part);
 for(const relsName of ['_rels/.rels','word/_rels/document.xml.rels']) {
  const base=relsName==='_rels/.rels'?'':'word/';
  for(const rel of xml(relsName).getElementsByTagName('Relationship')) {
   if(rel.getAttribute('TargetMode')==='External'){assert.match(rel.getAttribute('Target'),/^https:\/\//);continue;}
   assert(parts.has(base+rel.getAttribute('Target')),'dangling relationship '+rel.getAttribute('Target'));
  }
 }
 assert(parts.has('word/numbering.xml'),'lists use Word numbering');
 assert(![...parts.keys()].some(n=>/vbaProject|\.bin$|activeX|embeddings/.test(n)),'no macros or embedded objects');
});

test('document and footnote text equal the canonical plain text, with literal legal labels',()=>{
 const body=[...xml('word/document.xml').getElementsByTagName('w:p')].filter(p=>!/^Quill/.test(styleOf(p))).map(p=>paragraphText(p)).join('\n');
 const notes=[...xml('word/footnotes.xml').getElementsByTagName('w:footnote')].filter(f=>!f.getAttribute('w:type')).map(f=>paragraphText(f,{skipStyle:'FootnoteReference'})).join('\n');
 assert.equal(collapse(body+' '+notes),collapse(legalPlainText(fixture)));
 assert.match(body,/SEC\. 2\. Publication duties/);assert.match(body,/\(A\) Exceptions/);
 const headings=[...xml('word/document.xml').getElementsByTagName('w:p')].filter(p=>/^Heading/.test(styleOf(p))).map(p=>styleOf(p));
 assert(headings.includes('Heading4'),'nested (A) sections map to a fourth heading level');
});

test('marks, hyperlinks, internal anchors, footnotes, tables and page setup are encoded',()=>{
 const doc=parts.get('word/document.xml').data.toString('utf8');
 assert.match(doc,/<w:i\/><\/w:rPr><w:t xml:space="preserve">agency<\/w:t>/);
 assert.match(doc,/<w:b\/><\/w:rPr><w:t xml:space="preserve">binding<\/w:t>/);
 assert.match(doc,/<w:hyperlink r:id="rIdLink1">/);
 const anchor=/<w:hyperlink w:anchor="(_Quill\d+)">/.exec(doc)[1];assert(doc.includes('w:name="'+anchor+'"'),'internal reference has a bookmark target');
 assert.match(doc,/<w:footnoteReference w:customMarkFollows="1" w:id="1"\/><w:t>1<\/w:t>/);
 assert.equal((doc.match(/<w:tr>/g)??[]).length,35);
 assert.match(doc,/<w:pgSz w:w="12240" w:h="15840"\/>/);assert.match(doc,/<w:lnNumType w:countBy="1" w:restart="continuous"\/>/);
 assert.match(doc,/<w:pageBreakBefore\/>/);
 assert.match(parts.get('word/footer1.xml').data.toString(),/w:instr=" PAGE "/);
 const core=parts.get('docProps/core.xml').data.toString();
 assert(core.includes(result.manifest.editionDigest)&&core.includes('<dcterms:created xsi:type="dcterms:W3CDTF">'+GENERATED_AT));
});

test('DOCX bytes are deterministic and the manifest binds them',async()=>{
 const again=await exportDocx(legalFixture(),{lineNumbers:'continuous',signatures:[{name:'Ana Ruiz',signedAt:'2026-11-14T12:00:00Z',intent:'Approve',receiptDigest:'a'.repeat(64),mark:{kind:'typed',text:'Ana Ruiz'}}]});
 assert.deepEqual(again.bytes,result.bytes);
 assert.equal(result.manifest.format,'docx');assert.equal(result.manifest.version,5);
 assert.deepEqual(result.manifest.conformance,{pdfa:'not applicable to docx',tagged:false});
});

test('XML-hostile text is escaped and invalid XML characters are removed with a warning',async()=>{
 const doc=structuredClone(smallFixture());
 doc.content[0].children[0].inlines=[{kind:'text',text:'A & B <script>alert(1)</script> "q" \u0001end'}];
 const out=await exportDocx(validateLegalDocument(doc));
 const text=readZip(out.bytes).get('word/document.xml').data.toString('utf8');
 parseXml(text);
 assert(text.includes('A &amp; B &lt;script&gt;alert(1)&lt;/script&gt; &quot;q&quot; end'));
 assert(!text.includes('\u0001'));
 assert(out.manifest.warnings.some(w=>w.includes('U+0001')));
});

test('ZIP writer: CRC-32, fixed timestamps, unsafe names refused',async()=>{
 assert.equal(crc32(new TextEncoder().encode('123456789')),0xcbf43926);
 const zip=readZip(await writeZip([{name:'a.txt',data:'hello'},{name:'dir/b.txt',data:'x'.repeat(1000)}]));
 assert.equal(zip.get('a.txt').method,0,'tiny entries are stored');assert.equal(zip.get('dir/b.txt').method,8);
 for(const name of ['../evil','/abs','a/../b','dup']) await assert.rejects(writeZip([{name,data:'1'},...(name==='dup'?[{name,data:'2'}]:[])]),{code:'ZIP_INVALID'});
});

test('optional cross-check: LibreOffice converts the DOCX to text',{skip:has('soffice')?false:'soffice is not installed',timeout:120000},()=>{
 const dir=mkdtempSync(join(tmpdir(),'quill-docx-'));
 try {
  const file=join(dir,'out.docx');writeFileSync(file,result.bytes);
  execFileSync('soffice',['-env:UserInstallation=file://'+join(dir,'profile'),'--headless','--convert-to','txt:Text','--outdir',dir,file],{stdio:'ignore',timeout:110000});
  const text=collapse(readFileSync(join(dir,'out.txt'),'utf8'));
  assert.match(text,/SEC\. 2\. Publication duties/);assert.match(text,/Quarterly, within 44 days/);
 } finally {rmSync(dir,{recursive:true,force:true});}
});
