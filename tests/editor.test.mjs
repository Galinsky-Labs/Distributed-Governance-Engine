import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {NodeSelection,TextSelection} from 'prosemirror-state';
import {createLegalDocument,publicInputEdition,finalizeLegalDocument} from '../src/legal-structure.mjs';
import {legalToEditor,editorToLegal,createLegalEditorState,applyLegalTransaction,commands,appendSection,appendTable,insertExternalLink,insertCitation,selectedExternalInline,updateExternalInline,removeExternalInline,parsePastedHTML,cleanPastedHTML,renderedFragment,mountLegalEditor} from '../editor/model.mjs';
const draft=()=>({...structuredClone(createLegalDocument({id:'draft',tenantId:'org',title:'Draft bill'})),content:[{kind:'section',id:'s1',title:'Reporting',children:[{kind:'paragraph',id:'p1',inlines:[{kind:'text',text:'Report annually.',marks:['bold']}]},{kind:'paragraph',id:'p2',inlines:[{kind:'text',text:'See '},{kind:'reference',targetId:'s1',label:'section 1'}]}]}]});
test('the editor round-trips legal IDs, exact text, marks and cross-references',()=>{const d=draft();assert.deepEqual(editorToLegal(legalToEditor(d),d),d);});
test('external links and citations round-trip and unsafe schemes cannot enter the document',()=>{
 const d=draft();d.content[0].children[0].inlines=[{kind:'link',targetUrl:'https://example.gov/report',label:'report'},{kind:'text',text:' and '},{kind:'citation',targetUrl:'https://law.example/source',label:'authority',title:'Statute',citationMetadata:{publisher:'Congress',publishedOn:'2026-10-17',pinpoint:'§ 4',accessedOn:'2026-10-18'}}];assert.deepEqual(editorToLegal(legalToEditor(d),d),d);
 let s=createLegalEditorState(draft());s=s.apply(s.tr.setSelection(TextSelection.create(s.doc,2,8)));assert.equal(insertExternalLink('https://example.gov/report')(s,tr=>{s=s.apply(tr);}),true);const next=editorToLegal(s.doc,draft());assert.equal(next.content[0].children[0].inlines[0].kind,'link');assert.equal(next.content[0].children[0].inlines[0].label,'Report');assert.equal(insertCitation('javascript:alert(1)','bad')(s),false);assert.equal(insertCitation('https://law.example/source','bad',null,{publisher:'Agency',unknown:'unsafe'})(s),false);assert.equal(insertCitation('https://law.example/source','bad',null,{publisher:'Agency',publishedOn:20261017})(s),false);
});
test('selected external atoms can be inspected, edited, unlinked and restored through history',()=>{
 const d=draft();d.content[0].children[0].inlines=[{kind:'link',targetUrl:'https://example.gov/report',label:'Report'},{kind:'text',text:' annually.'}];let s=createLegalEditorState(d);
 s=s.apply(s.tr.setSelection(NodeSelection.create(s.doc,2)));assert.deepEqual(selectedExternalInline(s),{kind:'link',targetUrl:'https://example.gov/report',label:'Report'});
 assert.equal(updateExternalInline({targetUrl:'https://example.gov/revised',label:'Revised report',title:'Source'})(s,tr=>{s=s.apply(tr);}),true);assert.equal(s.doc.nodeAt(2).attrs.label,'Revised report');assert.equal(updateExternalInline({targetUrl:'https://example.gov/revised',label:'Revised report',citationMetadata:{publisher:'Not allowed'}})(s),false);
 const before=s.doc;assert.equal(updateExternalInline({targetUrl:'javascript:alert(1)',label:'Unsafe'})(s),false);assert.equal(s.doc.eq(before),true);
 commands.undo(s,tr=>{s=s.apply(tr);});assert.equal(s.doc.nodeAt(2).attrs.label,'Report');commands.redo(s,tr=>{s=s.apply(tr);});assert.equal(s.doc.nodeAt(2).attrs.label,'Revised report');
 s=s.apply(s.tr.setSelection(NodeSelection.create(s.doc,2)));assert.equal(removeExternalInline(s,tr=>{s=s.apply(tr);}),true);const next=editorToLegal(s.doc,d);assert.equal(next.content[0].children[0].inlines[0].kind,'text');assert.equal(next.content[0].children[0].inlines.map(run=>run.text).join(''),'Revised report annually.');
});
test('citation metadata is normalized, inspectable, editable and undoable',()=>{
 const d=draft();let inserted=createLegalEditorState(d);inserted=inserted.apply(inserted.tr.setSelection(TextSelection.create(inserted.doc,2,8)));assert.equal(insertCitation('https://law.example/source','Authority',null,{publisher:' Congress ',publishedOn:'2026-10-17',pinpoint:' § 4 '})(inserted,tr=>{inserted=inserted.apply(tr);}),true);
 const withCitation=editorToLegal(inserted.doc,d),s=createLegalEditorState(withCitation);s.apply(s.tr.setSelection(NodeSelection.create(s.doc,2)));let selected=s.apply(s.tr.setSelection(NodeSelection.create(s.doc,2)));assert.deepEqual(selectedExternalInline(selected).citationMetadata,{publisher:'Congress',publishedOn:'2026-10-17',pinpoint:'§ 4'});
 let state=selected;assert.equal(updateExternalInline({targetUrl:'https://law.example/source',label:'Authority',title:'Statute',citationMetadata:{publisher:'Congress',accessedOn:'2026-10-18'}})(state,tr=>{state=state.apply(tr);}),true);assert.deepEqual(state.doc.nodeAt(2).attrs.citationMetadata,{publisher:'Congress',accessedOn:'2026-10-18'});
 commands.undo(state,tr=>{state=state.apply(tr);});assert.equal(state.doc.nodeAt(2).attrs.citationMetadata.pinpoint,'§ 4');assert.equal(updateExternalInline({targetUrl:'https://law.example/source',label:'Authority',citationMetadata:{publishedOn:'2026-02-30'}})(state),false);
});
test('external atom changes are rejected for immutable editions',()=>{
 const d=draft();d.content[0].children[0].inlines=[{kind:'link',targetUrl:'https://example.gov/report',label:'Report'}];const locked=publicInputEdition(d);let s=createLegalEditorState(locked),transaction;s=s.apply(s.tr.setSelection(NodeSelection.create(s.doc,2)));updateExternalInline({targetUrl:'https://example.gov/new',label:'New'})(s,tr=>{transaction=tr;});const result=applyLegalTransaction(s,transaction,locked);assert.equal(result.changed,false);assert.deepEqual(result.document,locked);
});
test('actual edit transactions increment the revision without mutating the old edition',()=>{const d=draft(),s=createLegalEditorState(d),r=applyLegalTransaction(s,s.tr.insertText('A ',2),d);assert.equal(r.changed,true);assert.equal(r.document.revision,1);assert.match(r.document.content[0].children[0].inlines.map(r=>r.text).join(''),/^A Report/);assert.equal(d.revision,0);});
test('published, adopted and public-input content reject direct editor transactions',()=>{
 const d=draft();for(const locked of [publicInputEdition(d),finalizeLegalDocument(d),{...d,lifecycle:'signed'}]){const s=createLegalEditorState(locked),r=applyLegalTransaction(s,s.tr.insertText('FORGED',2),locked);assert.equal(r.changed,false);assert.deepEqual(r.document,locked);assert.equal(s.apply(s.tr.insertText('FORGED',2)).doc.eq(s.doc),true);}
});
test('format commands change real marks, and undo/redo restore the exact state',()=>{
 const d=draft();let s=createLegalEditorState(d);s=s.apply(s.tr.setSelection(TextSelection.create(s.doc,2,8)));
 commands.italic(s,tr=>{s=s.apply(tr);});assert.equal(s.doc.nodeAt(2).marks.some(m=>m.type.name==='italic'),true);
 commands.undo(s,tr=>{s=s.apply(tr);});assert.equal(s.doc.nodeAt(2).marks.some(m=>m.type.name==='italic'),false);
 commands.redo(s,tr=>{s=s.apply(tr);});assert.equal(s.doc.nodeAt(2).marks.some(m=>m.type.name==='italic'),true);
});
test('new sections and tables receive stable IDs and remain valid legal data',()=>{
 const d=draft();let s=createLegalEditorState(d);appendSection('Effective date')(s,tr=>{s=s.apply(tr);});appendTable()(s,tr=>{s=s.apply(tr);});const next=editorToLegal(s.doc,d);assert.equal(next.content[1].title,'Effective date');assert.equal(next.content[2].kind,'table');assert.equal(next.content[2].children[0].children.length,2);
});
test('numbering is rendered and recomputed without becoming a semantic ID or title',()=>{
 const d=draft();let s=createLegalEditorState(d);appendSection('Effective date')(s,tr=>{s=s.apply(tr);});assert.equal(s.doc.child(1).attrs.numberLabel,'SEC. 2.');const next=editorToLegal(s.doc,d);assert.equal(next.content[1].title,'Effective date');assert.equal(Object.hasOwn(next.content[1],'numberLabel'),false);const dom=new JSDOM(''),fragment=renderedFragment(next,dom.window.document);assert.match(fragment.querySelector('h2').textContent,/SEC\. 1\./);dom.window.close();
});
test('split and pasted blocks receive unique IDs instead of copying existing identity',()=>{
 const d=draft(),s=createLegalEditorState(d),tr=s.tr.split(8),r=applyLegalTransaction(s,tr,d);const ids=r.document.content[0].children.map(n=>n.id);assert.equal(new Set(ids).size,ids.length);assert.equal(ids[0],'p1');
});
test('safe paste discards executable objects, active attributes and unsupported markup',()=>{
 const dom=new JSDOM(''),slice=parsePastedHTML('<script>alert(1)</script><iframe src="https://evil.test"></iframe><p onclick="steal()"><strong>Keep</strong> <a href="javascript:steal()">text</a><img src=x onerror=steal()></p>',dom.window.document);
 const json=JSON.stringify(slice.toJSON());assert.match(json,/Keep/);assert.doesNotMatch(json,/steal|script|iframe|onerror|javascript/);dom.window.close();
});
test('legal markup-like text renders as text rather than executable DOM',()=>{
 const d=draft();d.content[0].children[0].inlines=[{kind:'text',text:'<img src=x onerror=steal()>'}];const dom=new JSDOM(''),fragment=renderedFragment(d,dom.window.document);assert.equal(fragment.querySelector('img'),null);assert.match(fragment.textContent,/<img/);dom.window.close();
});
test('oversized or malformed editor commands fail without modifying a document',()=>{const s=createLegalEditorState(draft());assert.equal(appendSection('')(s),false);assert.equal(appendTable(10000,1)(s),false);});
test('a mounted editor renders real text, reports accepted changes and enforces read-only state',()=>{
 const dom=new JSDOM('<div id="editable"></div><div id="fixed"></div>'),names=['window','document','Node','HTMLElement','MutationObserver','navigator','getComputedStyle'],previous=new Map(names.map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]));
 for(const name of names)Object.defineProperty(globalThis,name,{value:name==='getComputedStyle'?dom.window.getComputedStyle.bind(dom.window):dom.window[name],configurable:true,writable:true});
 let editor,fixed;try{
  const changes=[],errors=[];editor=mountLegalEditor(dom.window.document.getElementById('editable'),draft(),{onChange:d=>changes.push(d),onError:e=>errors.push(e)});
  assert.match(editor.view.dom.textContent,/Report annually/);editor.view.dispatch(editor.view.state.tr.insertText('Now ',2));assert.equal(changes.length,1);assert.equal(errors.length,0);assert.equal(changes[0].revision,1);const before=editor.getDocument();assert.equal(editor.command((state,dispatch)=>{dispatch(state.tr.insertText('\ud800',2));return true;}),false);assert.deepEqual(editor.getDocument(),before);assert.equal(errors.length,1);
  const source=publicInputEdition(draft());fixed=mountLegalEditor(dom.window.document.getElementById('fixed'),source);assert.equal(fixed.view.dom.getAttribute('contenteditable'),'false');fixed.view.dispatch(fixed.view.state.tr.insertText('FORGED',2));assert.deepEqual(fixed.getDocument(),source);
 }finally{editor?.destroy();fixed?.destroy();for(const[name,descriptor]of previous){if(descriptor)Object.defineProperty(globalThis,name,descriptor);else delete globalThis[name];}dom.window.close();}
});
test('DCE-036: pasted HTML is parsed in an inert document, never in the live page',()=>{
 const dom=new JSDOM('<!doctype html><body></body>'),live=dom.window.document;
 let liveParses=0;const original=live.createElement.bind(live);
 live.createElement=(name,...rest)=>{liveParses++;return original(name,...rest);};
 const container=cleanPastedHTML('<p>Keep<img src="https://tracker.invalid/x" onerror="window.pwned=1"></p><script>window.pwned=2</script>',live);
 assert.equal(liveParses,0,'no element of the live document receives untrusted markup');
 assert.notEqual(container.ownerDocument,live);
 assert.equal(container.querySelector('script'),null);
 assert.equal(dom.window.pwned,undefined);
 assert.equal(container.textContent,'Keep');
});
