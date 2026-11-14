import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {legalPlainText,legalDocumentDigest,validateLegalDocument} from '../src/legal-schema.mjs';
import {renderPdf} from '../src/export/pdf.mjs';
import {PdfReader,readStructure,collapse,findAll,decodeTextString,Name} from './support/pdf-reader.mjs';
import {legalFixture,smallFixture,fonts,GENERATED_AT,MISSING_GLYPH} from './support/export-fixture.mjs';

const signatures=[{name:'Ana Ruiz',capacity:'Mayor',signedAt:'2026-11-14T12:00:00Z',intent:'I approve this act.',receiptDigest:'a'.repeat(64),mark:{kind:'drawn',width:120,height:40,strokes:[[{x:0,y:30},{x:40,y:5},{x:80,y:35},{x:120,y:10}]]}}];
const options={generatedAt:GENERATED_AT,lineNumbers:'page',watermark:'DRAFT',signatures};
const render=(document,extra={})=>renderPdf({document,fonts,editionDigest:legalDocumentDigest(document),version:3,options:{...options,...extra}});
const fixture=legalFixture();
const rendered=await render(fixture);
const reader=new PdfReader(rendered.bytes);
const structure=readStructure(reader);
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const has=cmd=>{try{execFileSync('which',[cmd],{stdio:'ignore'});return true;}catch{return false;}};

const documentElement=structure.elements[0];
const body=findAll(documentElement,e=>e.type==='Part')[0];

test('xref offsets point at every object and the trailer binds a deterministic /ID',()=>{
 assert(reader.verifyXref()>50);
 const id=reader.trailer.get('ID');
 assert.equal(id.length,2);assert.equal(Buffer.from(id[0].string).toString('hex').length,32);
 assert.equal(reader.pages().length,rendered.manifest.pageCount);
});

test('tagged body text equals the canonical plain text, including labels and resolved references',()=>{
 const extracted=structure.textOf(body,{skip:e=>e.type==='Lbl'});
 assert.equal(collapse(extracted),collapse(legalPlainText(fixture)));
 assert.match(extracted,/See SEC\. 2\(a\)\(1\) for timing/);
 assert(extracted.includes(MISSING_GLYPH),'missing glyph is recovered through ActualText');
});

test('every MCID resolves and every painted text operation sits in tagged or artifact content',()=>{
 structure.content.forEach((page,i)=>{
  assert.equal(page.untagged,0,'text outside marked content on page '+(i+1));
  const tagged=page.segments.filter(s=>s.mcid!==null);
  for(const s of tagged)assert(structure.referenced[i].has(s.mcid),'MCID '+s.mcid+' on page '+(i+1)+' is not in the structure tree');
  for(const mcid of structure.referenced[i])assert(tagged.some(s=>s.mcid===mcid),'structure references a missing MCID');
  for(const s of page.segments)assert(s.artifact||s.mcid!==null);
 });
 // ParentTree maps each page's MCIDs back to structure elements.
 const root=reader.get(reader.catalog,'StructTreeRoot'),nums=reader.get(root,'ParentTree').get('Nums');
 reader.pages().forEach((page,i)=>{
  const key=page.dict.get('StructParents');const at=nums.findIndex((v,j)=>j%2===0&&v===key);
  assert(at>=0);assert.equal(reader.resolve(nums[at+1]).length,structure.content[i].segments.filter(s=>s.mcid!==null).length);
 });
 assert.equal(reader.catalog.get('MarkInfo').get('Marked'),true);
 const types=new Set(findAll(documentElement,()=>true).map(e=>e.type));
 for(const t of ['Document','Sect','H1','H2','H3','H4','P','L','LI','Lbl','LBody','Table','TR','TD','Note','Link','TOC','TOCI','Figure'])assert(types.has(t),'missing structure type '+t);
});

test('headers, footers, line numbers and watermark are artifacts; footer reads Page N of M',()=>{
 const total=structure.pages.length;
 structure.content.forEach((page,i)=>{
  const artifacts=page.segments.filter(s=>s.artifact).map(s=>s.text);
  assert(artifacts.includes('Page '+(i+1)+' of '+total));
  assert(artifacts.includes('DRAFT'));
 });
 assert(structure.content[2].segments.some(s=>s.artifact&&s.text==='1'),'line numbers are artifacts');
});

test('outline mirrors sections and exhibits and targets the pages where headings appear',()=>{
 const pageOf=new Map(reader.pages().map((p,i)=>[p.ref.num,i]));
 const headings=findAll(body,e=>/^H\d$/.test(e.type)).map(h=>({text:collapse(structure.textOf(h)),page:structure.firstPage(h)}));
 const items=[];
 const walk=item=>{for(let at=item;at;at=reader.get(at,'Next')){items.push(at);if(at.get('First'))walk(reader.get(at,'First'));}};
 walk(reader.get(reader.get(reader.catalog,'Outlines'),'First'));
 assert.equal(items.length,headings.length+1);
 for(const item of items) {
  const title=decodeTextString(item.get('Title').string),dest=item.get('Dest');
  if(title==='Signature Appendix')continue;
  const heading=headings.find(h=>h.text===title);
  assert(heading,'outline entry without heading: '+title);
  assert.equal(pageOf.get(dest[0].num),heading.page,title);
 }
});

test('fonts are embedded TrueType (FontFile2) with ToUnicode; no unembedded or base-14 fonts',()=>{
 let count=0;
 for(const [,object] of reader.allObjects()) {
  if(!(object instanceof Map)||object.get('Type')?.value!=='Font')continue;
  const subtype=object.get('Subtype').value;
  assert(['Type0','CIDFontType2'].includes(subtype),'unexpected font subtype '+subtype);
  if(subtype==='Type0'){count++;assert(object.get('ToUnicode'));continue;}
  const descriptor=reader.resolve(object.get('FontDescriptor'));
  const file=reader.resolve(descriptor.get('FontFile2'));
  const data=reader.streamData(file);
  assert.equal(data.length,file.dict.get('Length1'));
  assert.equal(Buffer.from(data.subarray(0,4)).toString('hex'),'00010000');
 }
 assert.equal(count,rendered.manifest.renderProfile.fonts.length);
 assert(count>=3&&count<=4,'only used styles are embedded');
});

test('XMP declares PDF/A-2B and binds the edition; an sRGB output intent carries a valid ICC profile',()=>{
 const metadata=reader.get(reader.catalog,'Metadata');
 assert.equal(metadata.dict.get('Filter'),undefined,'XMP stays uncompressed');
 const xmp=Buffer.from(metadata.raw).toString('utf8');
 assert.match(xmp,/<pdfaid:part>2<\/pdfaid:part>/);assert.match(xmp,/<pdfaid:conformance>B<\/pdfaid:conformance>/);
 assert.match(xmp,/<dc:title><rdf:Alt><rdf:li xml:lang="x-default">Municipal Data Transparency Act<\/rdf:li>/);
 assert.match(xmp,/<xmp:CreateDate>2026-11-14T12:00:00\+00:00<\/xmp:CreateDate>/);
 assert(xmp.includes(rendered.manifest.editionDigest)&&xmp.includes('quill-render-v1'));
 const info=reader.resolve(reader.trailer.get('Info'));
 assert(decodeTextString(info.get('Keywords').string).includes('edition-digest:'+rendered.manifest.editionDigest));
 const intent=reader.resolve(reader.catalog.get('OutputIntents'))[0];
 assert.equal(intent.get('S').value,'GTS_PDFA1');
 const icc=reader.streamData(reader.resolve(intent.get('DestOutputProfile')));
 const view=new DataView(icc.buffer,icc.byteOffset,icc.byteLength);
 assert.equal(view.getUint32(0),icc.length);assert.equal(Buffer.from(icc.subarray(36,40)).toString(),'acsp');
 assert.equal(view.getUint8(8),2);assert.equal(Buffer.from(icc.subarray(16,20)).toString(),'RGB ');
 const tags=new Map();for(let i=0;i<view.getUint32(128);i++){const at=132+12*i;tags.set(Buffer.from(icc.subarray(at,at+4)).toString(),[view.getUint32(at+4),view.getUint32(at+8)]);}
 for(const tag of ['desc','cprt','wtpt','rXYZ','gXYZ','bXYZ','rTRC','gTRC','bTRC']){assert(tags.has(tag),tag);const [o,l]=tags.get(tag);assert(o+l<=icc.length);}
 assert.equal(reader.get(reader.catalog,'Lang').string?Buffer.from(reader.catalog.get('Lang').string).toString():'', 'en-US');
 assert.equal(reader.get(reader.catalog,'ViewerPreferences').get('DisplayDocTitle'),true);
});

test('no active content, encryption, attachments, transparency or non-https URIs',()=>{
 const raw=Buffer.from(rendered.bytes).toString('latin1');
 const inflated=[...reader.allObjects()].filter(([,o])=>o.raw).map(([,o])=>Buffer.from(reader.streamData(o)).toString('latin1')).join('\n');
 for(const forbidden of ['/JS','/JavaScript','/Launch','/EmbeddedFile','/Encrypt','/SMask','/CA ','/ca ','/Transparency','/OpenAction','/AA'])assert(!raw.includes(forbidden)&&!inflated.includes(forbidden),forbidden);
 const uris=[...raw.matchAll(/\/URI \(([^)]*)\)/g)].map(m=>m[1]);
 assert(uris.length>=2);for(const uri of uris)assert.match(uri,/^https:\/\//);
 const annots=[...reader.allObjects()].map(([,o])=>o).filter(o=>o instanceof Map&&o.get('Subtype')?.value==='Link');
 for(const a of annots){assert.equal(a.get('F'),4);assert(a.get('StructParent')!==undefined);assert(a.get('Contents'));}
 assert(annots.some(a=>a.get('Dest')),'internal GoTo destinations for references and the table of contents');
});

test('identical inputs give identical bytes; a changed character changes the hash and /ID',async()=>{
 const again=await render(legalFixture());
 assert.equal(sha(again.bytes),sha(rendered.bytes));
 assert.equal(again.manifest.artifactSha256,rendered.manifest.artifactSha256);
 const changed=structuredClone(legalFixture());changed.content[0].children[2].inlines[0].text='This Act applies to everY ';
 const other=await render(validateLegalDocument(changed));
 assert.notEqual(other.manifest.artifactSha256,rendered.manifest.artifactSha256);
 assert.notDeepEqual(new PdfReader(other.bytes).trailer.get('ID')[0].string,reader.trailer.get('ID')[0].string);
});

test('the manifest binds edition, profile, fonts and warnings; mismatched digests are refused',async()=>{
 const m=rendered.manifest;
 assert.equal(m.schema,'quill-export-manifest-v1');assert.equal(m.artifactSha256,sha(rendered.bytes));
 assert.equal(m.renderProfile.id,'quill-render-v1');assert.equal(m.generatedAt,GENERATED_AT);
 assert(m.warnings.some(w=>w.includes('U+4E2D')));
 for(const f of m.renderProfile.fonts){assert.equal(f.family,'Liberation Serif');assert.match(f.sha256,/^[a-f0-9]{64}$/);}
 await assert.rejects(renderPdf({document:fixture,fonts,editionDigest:'0'.repeat(64),version:1,options}),{code:'EDITION_DIGEST_MISMATCH'});
 await assert.rejects(renderPdf({document:fixture,fonts:{regular:new Uint8Array(20)},editionDigest:legalDocumentDigest(fixture),version:1,options}),{code:'FONT_INVALID'});
 await assert.rejects(renderPdf({document:fixture,fonts,editionDigest:legalDocumentDigest(fixture),version:1,options:{...options,generatedAt:'yesterday'}}),{code:'INVALID_GENERATED_AT'});
});

test('a small document without missing glyphs makes no .notdef warning',async()=>{
 const doc=smallFixture();
 const {manifest,bytes}=await renderPdf({document:doc,fonts,editionDigest:legalDocumentDigest(doc),version:1,options:{generatedAt:GENERATED_AT}});
 assert.deepEqual(manifest.warnings,[]);
 const s=readStructure(new PdfReader(bytes));
 assert.equal(collapse(s.textOf(findAll(s.elements[0],e=>e.type==='Part')[0],{skip:e=>e.type==='Lbl'})),collapse(legalPlainText(doc)));
});

for(const tool of ['qpdf','pdftotext','mutool','gs']) {
 test('optional cross-check with '+tool,{skip:has(tool)?false:tool+' is not installed'},()=>{
  const dir=mkdtempSync(join(tmpdir(),'quill-pdf-'));
  try {
   const file=join(dir,'out.pdf');writeFileSync(file,rendered.bytes);
   if(tool==='qpdf')execFileSync('qpdf',['--check',file]);
   if(tool==='pdftotext'){const text=execFileSync('pdftotext',['-enc','UTF-8',file,'-']).toString();assert.match(collapse(text),/SEC\. 2\. Publication duties/);assert.match(text,/Page 3 of \d+/);}
   if(tool==='mutool')execFileSync('mutool',['show',file,'trailer']);
   if(tool==='gs')execFileSync('gs',['-q','-dNOPAUSE','-dBATCH','-sDEVICE=nullpage',file]);
  } finally {rmSync(dir,{recursive:true,force:true});}
 });
}
