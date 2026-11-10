import test from 'node:test';
import assert from 'node:assert/strict';
import {compareLegalRevisions,compareRevisionText,verifyRevisionSnapshot} from '../src/revision-comparison.mjs';
import {createLegalDocument,indentLegalSection,applyLegalNumberingRules,publicInputEdition} from '../src/legal-structure.mjs';
import {legalDocumentDigest} from '../src/legal-schema.mjs';
const paragraph=(id,text)=>({kind:'paragraph',id,inlines:[{kind:'text',text}]});
const fixture=()=>({...structuredClone(createLegalDocument({id:'document',tenantId:'tenant',title:'Reports'})),content:[
 {kind:'section',id:'a',title:'Agency',children:[paragraph('a-p','Report annually.')]},
 {kind:'section',id:'b',title:'Board',children:[paragraph('b-p','Review reports.')]},
 {kind:'paragraph',id:'references',inlines:[{kind:'reference',targetId:'b'}]}
]});
test('identical semantics at a new revision do not fabricate content changes',()=>{
 const before=fixture(),after=structuredClone(before);after.revision++;
 const comparison=compareLegalRevisions(before,after);
 assert.equal(comparison.unchanged,true);assert.equal(comparison.afterRevision,1);
 assert.ok(Object.isFrozen(comparison.changes));assert.equal(before.revision,0);
});
test('insertions and deletions do not misclassify surviving sibling nodes as moves',()=>{
 const before=fixture(),after=structuredClone(before);after.content.unshift(paragraph('new','New text.'));
 const inserted=compareLegalRevisions(before,after);
 assert.deepEqual(inserted.changes.map(change=>[change.id,change.kind]),[['new','added']]);
 assert.deepEqual(compareLegalRevisions(after,before).changes.map(change=>[change.id,change.kind]),[['new','removed']]);
});
test('a reorder reports deterministic minimal moved IDs independently from numbering changes',()=>{
 const before=fixture(),after=structuredClone(before);after.content=[after.content[1],after.content[0],after.content[2]];
 const comparison=compareLegalRevisions(before,after);
 assert.deepEqual(comparison.changes.filter(change=>change.moved).map(change=>change.id),['b']);
 assert.deepEqual(comparison.changes.map(change=>change.id),['b','a','references']);
 const reference=comparison.changes.find(change=>change.id==='references');
 assert.deepEqual(reference.fields,[]);assert.notEqual(reference.before.text,reference.after.text);
 assert.equal(reference.moved,false);
});
test('nested section move preserves IDs and reveals complete generated reference paths',()=>{
 const before=fixture(),after=indentLegalSection(before,'b'),comparison=compareLegalRevisions(before,after);
 assert.equal(comparison.changes.find(change=>change.id==='b').moved,true);
 assert.equal(comparison.changes.some(change=>change.id==='b-p'),false,'Child itself was not reordered');
 const reference=comparison.changes.find(change=>change.id==='references');
 assert.equal(reference.before.text,'SEC. 2.');assert.equal(reference.after.text,'SEC. 1(a)');
});
test('format-only, external-target-only and citation metadata changes remain visible',()=>{
 const before=fixture();before.content[0].children[0].inlines.push({kind:'citation',targetUrl:'https://example.org/old',label:'Source',citationMetadata:{publisher:'Old publisher'}});
 const after=structuredClone(before),node=after.content[0].children[0];
 node.inlines[0].marks=['bold'];node.inlines[1].targetUrl='https://example.org/new';node.inlines[1].citationMetadata.publisher='New publisher';
 const comparison=compareLegalRevisions(before,after),change=comparison.changes[0];
 assert.deepEqual(change.fields,['inlines']);assert.match(change.after.source.inlines[1].targetUrl,/new$/);
 assert.equal(change.after.source.inlines[1].citationMetadata.publisher,'New publisher');
 const formatOnly=structuredClone(before);formatOnly.content[0].children[0].inlines[0].marks=['italic'];
 const formatting=compareLegalRevisions(before,formatOnly).changes[0];
 assert.equal(formatting.before.text,formatting.after.text);assert.deepEqual(formatting.fields,['inlines']);
});
test('numbering metadata and all derived labels are compared without changing saved source',()=>{
 const before=fixture(),after=applyLegalNumberingRules(before,[{parentId:'document',startAt:5}]);
 const comparison=compareLegalRevisions(before,after);
 assert.deepEqual(comparison.metadata.map(change=>change.field),['metadata']);
 assert.equal(comparison.changes.find(change=>change.id==='b').after.label,'SEC. 6.');
 assert.equal(comparison.changes.find(change=>change.id==='references').after.text,'SEC. 6.');
 assert.equal(before.metadata.numberingRules,undefined);
});
test('mode and lifecycle changes are explicit and signed/frozen sources remain read-only',()=>{
 const before=fixture(),frozen=publicInputEdition(before),comparison=compareLegalRevisions(before,frozen);
 assert.deepEqual(comparison.metadata.map(change=>change.field),['mode','lifecycle']);
 assert.equal(comparison.changes.length,0);assert.equal(frozen.lifecycle,'published');
 const signed=structuredClone(before);signed.lifecycle='signed';
 assert.equal(compareLegalRevisions(signed,signed).unchanged,true);
});
test('tables, lists, definitions and footnotes retain their own stable structural changes',()=>{
 const before=fixture();before.content.push({kind:'definition',id:'def',term:'Agency',inlines:[{kind:'text',text:'The reporting body.'}]},{kind:'footnote',id:'note',inlines:[{kind:'text',text:'Background.'}]},
 {kind:'table',id:'table',children:[{kind:'table-row',id:'row',children:[{kind:'table-cell',id:'cell',children:[paragraph('cell-p','Cell text')]}]}]},
 {kind:'list',id:'list',style:'bullet',children:[{kind:'list-item',id:'item',children:[paragraph('item-p','List text')]}]});
 const after=structuredClone(before);after.content.find(node=>node.id==='def').term='Board';after.content.find(node=>node.id==='list').style='decimal';after.content.find(node=>node.id==='table').children[0].children[0].children[0].inlines[0].text='New cell';
 assert.deepEqual(compareLegalRevisions(before,after).changes.map(change=>change.id),['def','cell-p','list']);
});
for(const [before,after]of [['A😀B','A😁B'],['x😀y','😀y'],['😀x','😁x'],['same','same'],['','😀'],['😀',''],['ABCD','AXCYD']])test('text replacement reconstructs exact Unicode: '+JSON.stringify([before,after]),()=>{
 const result=compareRevisionText(before,after);
 assert.equal(result.prefix+result.removed+result.suffix,before);assert.equal(result.prefix+result.inserted+result.suffix,after);
 for(const text of Object.values(result))assert.equal(text.isWellFormed(),true);
});
test('comparison rejects unrelated identity, malformed structure and accessors without execution',()=>{
 const before=fixture(),other=fixture();other.id='another';assert.throws(()=>compareLegalRevisions(before,other));
 other.id=before.id;other.tenantId='another';assert.throws(()=>compareLegalRevisions(before,other));
 let read=false;const unsafe=fixture();Object.defineProperty(unsafe.content[0],'title',{get(){read=true;return 'Unsafe';},enumerable:true});
 assert.throws(()=>compareLegalRevisions(before,unsafe));assert.equal(read,false);
});
test('saved snapshot checks exact document, tenant, version and both canonical and history digests',async()=>{
 const document=fixture(),value={document,version:2,digest:legalDocumentDigest(document)};
 const expected={documentId:document.id,tenantId:document.tenantId,version:2,digest:value.digest};
 assert.equal((await verifyRevisionSnapshot(value,expected)).digest,value.digest);
 for(const bad of [{...value,version:3},{...value,digest:'0'.repeat(64)},{...value,document:{...document,metadata:{...document.metadata,title:'Changed'}}}])await assert.rejects(verifyRevisionSnapshot(bad,expected));
 await assert.rejects(verifyRevisionSnapshot(value,{...expected,tenantId:'wrong'}));
 await assert.rejects(verifyRevisionSnapshot(value,{...expected,digest:'0'.repeat(64)}));
});
test('ten thousand sibling nodes compare with bounded structure and stable ordering',()=>{
 const before=fixture();before.content=Array.from({length:10000},(_,i)=>paragraph('p'+i,'Wording '+i));
 const after=structuredClone(before);after.content.unshift(after.content.pop());
 const result=compareLegalRevisions(before,after);assert.deepEqual(result.changes.map(change=>change.id),['p9999']);assert.equal(result.changes[0].moved,true);
});

test('semantic change ordering is independent of source object key ordering',()=>{
 const before=fixture(),after=structuredClone(before);after.content[0].kind='exhibit';after.content[0].title='Exhibit wording';
 const reordered=structuredClone(before);reordered.content[0]=Object.fromEntries(Object.entries(reordered.content[0]).reverse());
 assert.deepEqual(compareLegalRevisions(before,after),compareLegalRevisions(reordered,after));
 assert.deepEqual(compareLegalRevisions(before,after).changes[0].fields,['kind','title']);
});
