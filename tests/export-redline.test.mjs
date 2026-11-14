import test from 'node:test';
import assert from 'node:assert/strict';
import {legalDocumentDigest,validateLegalDocument,moveLegalNode} from '../src/legal-schema.mjs';
import {exportDocument,redlineModel,redlineText} from '../src/export/index.mjs';
import {PdfReader,readStructure,collapse,findAll} from './support/pdf-reader.mjs';
import {readZip,parseXml} from './support/zip-reader.mjs';
import {fonts,GENERATED_AT} from './support/export-fixture.mjs';

const para=(id,text)=>({kind:'paragraph',id,inlines:[{kind:'text',text}]});
const base=()=>validateLegalDocument({schemaVersion:2,id:'bylaws',tenantId:'club',mode:'collaboration',lifecycle:'draft',revision:3,
 metadata:{title:'Club bylaws',locale:'en-US',numberingProfile:'us-federal-v1'},
 content:[{kind:'section',id:'s1',title:'Meetings',children:[para('p1','The board shall meet monthly.'),para('p2','Minutes are public.')]},{kind:'section',id:'s2',title:'Quorum',children:[para('p3','A majority constitutes a quorum.')]}]});
const edit=mutate=>{const d=structuredClone(base());mutate(d);d.revision++;return validateLegalDocument(d);};

test('golden: insertion',()=>{
 const after=edit(d=>d.content[1].children.push(para('p4','Remote attendance counts.')));
 assert.equal(redlineText(redlineModel(base(),after)),['SEC. 1. Meetings','The board shall meet monthly.','Minutes are public.','SEC. 2. Quorum','A majority constitutes a quorum.','{+Remote attendance counts.+}'].join('\n'));
 assert.deepEqual(redlineModel(base(),after).entries.at(-1),{id:'p4',kind:'paragraph',depth:1,status:'inserted',label:{before:null,after:null},note:null,segments:[{op:'insert',text:'Remote attendance counts.'}]});
});

test('golden: deletion keeps the deleted block where it stood',()=>{
 const after=edit(d=>d.content[0].children.splice(1,1));
 assert.equal(redlineText(redlineModel(base(),after)),['SEC. 1. Meetings','The board shall meet monthly.','[-Minutes are public.-]','SEC. 2. Quorum','A majority constitutes a quorum.'].join('\n'));
 const deletedSection=edit(d=>d.content.splice(0,1));
 assert.equal(redlineText(redlineModel(base(),deletedSection)),['[-SEC. 1.-] [-Meetings-]','[-The board shall meet monthly.-]','[-Minutes are public.-]','[-SEC. 2.-]{+SEC. 1.+} Quorum','A majority constitutes a quorum.'].join('\n'));
});

test('golden: replacement within a clause',()=>{
 const after=edit(d=>{d.content[0].children[0].inlines[0].text='The board shall meet quarterly.';});
 const model=redlineModel(base(),after);
 assert.deepEqual(model.entries[1].segments,[{op:'equal',text:'The board shall meet '},{op:'delete',text:'month'},{op:'insert',text:'quarter'},{op:'equal',text:'ly.'}]);
 assert.equal(model.entries[1].status,'changed');
 assert.equal(redlineText(model).split('\n')[1],'The board shall meet [-month-]{+quarter+}ly.');
});

test('golden: a moved clause is marked as moved',()=>{
 const after=moveLegalNode(base(),'p2','s2',0);
 const model=redlineModel(base(),after);
 assert.equal(redlineText(model),['SEC. 1. Meetings','The board shall meet monthly.','SEC. 2. Quorum','Minutes are public. (Moved)','A majority constitutes a quorum.'].join('\n'));
 assert.deepEqual(model.entries.map(e=>e.status),['unchanged','unchanged','unchanged','moved','unchanged']);
 const section=redlineModel(base(),moveLegalNode(base(),'s2','bylaws',0));
 assert.equal(redlineText(section),['[-SEC. 2.-]{+SEC. 1.+} Quorum (Moved from SEC. 2.)','A majority constitutes a quorum.','[-SEC. 1.-]{+SEC. 2.+} Meetings','The board shall meet monthly.','Minutes are public.'].join('\n'));
});

test('golden: a large edit is one contiguous replacement',()=>{
 const long='Article text. '.repeat(300).trim();
 const after=edit(d=>{d.content[0].children[1].inlines[0].text=long;});
 const entry=redlineModel(base(),after).entries.find(e=>e.id==='p2');
 assert.deepEqual(entry.segments.map(s=>[s.op,s.text.length]),[['delete','Minutes are public'.length],['insert',long.length-1],['equal',1]]);
 assert.equal(redlineModel(base(),base()).unchanged,true);
 assert.throws(()=>redlineModel(base(),{...structuredClone(base()),id:'other'}),{code:'INVALID_COMPARISON'});
});

const after=edit(d=>{d.content[0].children[0].inlines[0].text='The board shall meet quarterly.';d.content[0].children.splice(1,1);d.content[1].children.push(para('p4','Remote attendance counts.'));});
const redline=format=>exportDocument({document:after,compareTo:base(),format,editionDigest:legalDocumentDigest(after),version:4,fonts,options:{generatedAt:GENERATED_AT,cover:false}});

test('redline PDF marks changes by text markers, decoration and colour',async()=>{
 const out=await redline('pdf');
 assert.equal(out.fileName,'club-bylaws-r4-v4-redline.pdf');
 assert.equal(out.manifest.redline.beforeEditionDigest,legalDocumentDigest(base()));
 const reader=new PdfReader(out.bytes);reader.verifyXref();
 const s=readStructure(reader);
 const text=collapse(s.textOf(findAll(s.elements[0],e=>e.type==='Part')[0]));
 assert(text.includes('The board shall meet [-month-]{+quarter+}ly.'));
 assert(text.includes('[-Minutes are public.-]'));assert(text.includes('{+Remote attendance counts.+}'));
 assert(text.startsWith('Legend:'));
 const ops=s.content.map(c=>c.raw).join('\n');
 assert.match(ops,/0\.7 0 0 rg/);assert.match(ops,/0 0 0\.7 rg/);assert.match(ops,/0\.7 0 0 RG/,'deleted text is struck through');
});

test('redline DOCX uses tracked changes; redline HTML uses <del>/<ins>',async()=>{
 const docx=readZip((await redline('docx')).bytes);
 const xml=docx.get('word/document.xml').data.toString('utf8');parseXml(xml);
 assert.match(xml,/<w:del w:id="\d+" w:author="Quill redline" w:date="2026-11-14T12:00:00Z"><w:r><w:delText xml:space="preserve">month<\/w:delText><\/w:r><\/w:del>/);
 assert.match(xml,/<w:ins w:id="\d+" w:author="Quill redline" w:date="2026-11-14T12:00:00Z"><w:r><w:t xml:space="preserve">quarter<\/w:t><\/w:r><\/w:ins>/);
 const html=new TextDecoder().decode((await redline('html')).bytes);
 assert(html.includes('The board shall meet <del>[-month-]</del><ins>{+quarter+}</ins>ly.'));
 assert(html.includes('<del>[-Minutes are public.-]</del>'));assert(!/<script/i.test(html));
});
