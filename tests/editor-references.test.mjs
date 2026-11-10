import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {TextSelection,NodeSelection} from 'prosemirror-state';
import {createLegalDocument,legalReferenceLabels,legalReferenceText,legalPlainText,documentIssues,finalizeLegalDocument,publicInputEdition,previewLegalNodeMove,previewLegalNumbering} from '../src/legal-structure.mjs';
import {createLegalEditorState,applyLegalTransaction,commands,editorToLegal,legalToEditor,mountLegalEditor,parsePastedHTML,insertInternalReference,updateInternalReference,selectedInternalReference,removeInternalReference,goToInternalReference,appendDefinition,renameDefinition,selectedDefinition,insertFootnote} from '../editor/model.mjs';
function document(){const d=structuredClone(createLegalDocument({id:'references',tenantId:'org',title:'References act'}));d.content=[{kind:'section',id:'first',title:'Reports',children:[{kind:'paragraph',id:'body',inlines:[{kind:'text',text:'Opening.'}]},{kind:'paragraph',id:'links',inlines:[{kind:'reference',targetId:'second'},{kind:'text',text:' '},{kind:'reference',targetId:'agency'},{kind:'text',text:' '},{kind:'reference',targetId:'second',label:'authored clause'},{kind:'text',text:' '},{kind:'footnote-reference',targetId:'note'}]}]},{kind:'section',id:'second',title:'Review',children:[{kind:'paragraph',id:'review-body',inlines:[{kind:'text',text:'Review reports.'}]}]},{kind:'definition',id:'agency',term:'Agency',inlines:[{kind:'text',text:'The reporting authority.'}]},{kind:'exhibit',id:'schedule',title:'Reporting schedule',children:[{kind:'paragraph',id:'schedule-body',inlines:[{kind:'text',text:'Annually.'}]}]},{kind:'footnote',id:'note',inlines:[{kind:'text',text:'Footnote evidence.'}]}];return d;}
function position(state,id){let result;state.doc.descendants((node,pos)=>{if(node.attrs.id===id)result=pos;});assert.notEqual(result,undefined);return result;}
function selectText(state,id){return state.apply(state.tr.setSelection(TextSelection.create(state.doc,position(state,id)+1)));}
function selectReference(state,target='second'){let at;state.doc.descendants((node,pos)=>{if(at===undefined&&['reference','footnote_reference'].includes(node.type.name)&&node.attrs.targetId===target)at=pos;});assert.notEqual(at,undefined);return state.apply(state.tr.setSelection(NodeSelection.create(state.doc,at)));}
function harness(d=document(),options){let current=d,state=selectText(createLegalEditorState(d,options),'body');return {get doc(){return current;},get state(){return state;},text(id){state=selectText(state,id);},reference(target){state=selectReference(state,target);},run(command){return command(state,tr=>{const result=applyLegalTransaction(state,tr,current);state=result.state;current=result.document;});}};}
test('derived labels share current section, term, exhibit and footnote text with plain export without changing source',()=>{
 const d=document(),before=JSON.stringify(d),labels=legalReferenceLabels(d);
 assert.equal(legalReferenceText({kind:'reference',targetId:'second'},labels),'SEC. 2.');assert.equal(legalReferenceText({kind:'reference',targetId:'agency'},labels),'Agency');assert.equal(legalReferenceText({kind:'reference',targetId:'schedule'},labels),'Reporting schedule');assert.equal(legalReferenceText({kind:'reference',targetId:'note'},labels),'Footnote 1');assert.equal(legalReferenceText({kind:'footnote-reference',targetId:'note'},labels),'1');assert.equal(legalReferenceText({kind:'reference',targetId:'missing'},labels),'[missing]');
 assert.match(legalPlainText(d),/SEC\. 2\. Agency authored clause 1/);assert.equal(JSON.stringify(d),before);assert.deepEqual(editorToLegal(legalToEditor(d),d),d);
});
test('insert/update reference keeps stable target identity and supports automatic or authored labels with undo',()=>{
 const h=harness(),before=h.state.doc;assert.equal(h.run(insertInternalReference({targetId:'second'})),true);assert.equal(selectedInternalReference(h.state).targetId,'second');assert.equal(h.doc.content[0].children[0].inlines[0].label,undefined);
 assert.equal(h.run(updateInternalReference({targetId:'agency',label:'the authority'})),true);assert.equal(selectedInternalReference(h.state).targetId,'agency');assert.equal(selectedInternalReference(h.state).label,'the authority');
 assert.equal(h.run(updateInternalReference({label:null})),true);assert.equal(selectedInternalReference(h.state).label,undefined);
 assert.equal(h.run(commands.undo),true);assert.ok(h.state.doc.eq(before));
});
test('new targets must exist and footnote references cannot point to another kind',()=>{
 const h=harness();for(const options of [{targetId:'missing'},{targetId:'second',kind:'footnote-reference'},{targetId:'second',kind:'unknown'},{targetId:'second',label:'x'.repeat(1001)}])assert.equal(h.run(insertInternalReference(options)),false);
 assert.equal(h.run(insertInternalReference({targetId:'note',kind:'footnote-reference'})),true);assert.equal(selectedInternalReference(h.state).kind,'footnote-reference');assert.equal(h.run(updateInternalReference({targetId:'agency'})),false);
});
test('label edits do not silently repair a legacy missing target, and explicit replacement clears the issue',()=>{
 const d=document();d.content[0].children[1].inlines[0].targetId='missing';const h=harness(d);h.reference('missing');assert.equal(h.run(updateInternalReference({label:'Review clause'})),true);assert.equal(documentIssues(h.doc).filter(issue=>issue.code==='UNRESOLVED_REFERENCE').length,1);assert.throws(()=>finalizeLegalDocument(h.doc),/Unresolved/);
 assert.equal(h.run(updateInternalReference({targetId:'second'})),true);assert.equal(documentIssues(h.doc).length,0);
});
test('removing a reference retains its current derived wording as ordinary text',()=>{
 const h=harness();h.reference();const selected=selectedInternalReference(h.state),text=legalReferenceText(selected,legalReferenceLabels(h.doc));assert.equal(h.run(removeInternalReference(text)),true);assert.equal(h.doc.content[0].children[1].inlines[0].kind,'text');assert.match(h.doc.content[0].children[1].inlines[0].text,/SEC\. 2\./);assert.equal(h.run(commands.undo),true);assert.equal(h.doc.content[0].children[1].inlines[0].targetId,'second');
});
test('new definitions require authored meaning; rename keeps target IDs and reports duplicate terms',()=>{
 const h=harness();assert.equal(h.run(appendDefinition('','Meaning')),false);assert.equal(h.run(appendDefinition('Term','')),false);assert.equal(h.run(appendDefinition('Agency','Another authority.')),true);const created=selectedDefinition(h.state);assert.ok(created.id);assert.equal(documentIssues(h.doc).some(issue=>issue.code==='AMBIGUOUS_DEFINED_TERM'),true);
 assert.equal(h.run(renameDefinition('Reviewer')),true);assert.equal(selectedDefinition(h.state).id,created.id);assert.equal(documentIssues(h.doc).length,0);assert.equal(h.run(commands.undo),true);assert.equal(selectedDefinition(h.state).term,'Agency');
 h.text('agency');assert.equal(h.run(renameDefinition('Reporting agency')),true);assert.equal(h.doc.content[0].children[1].inlines[2].targetId,'agency');assert.equal(legalReferenceText({kind:'reference',targetId:'agency'},legalReferenceLabels(h.doc)),'Reporting agency');
});
test('footnote and stable-ID reference are created and undone together',()=>{
 const h=harness(),before=h.state.doc;assert.equal(h.run(insertFootnote('Additional evidence 🏛️.')),true);const selected=selectedInternalReference(h.state),note=h.doc.content.at(-1);assert.equal(selected.kind,'footnote-reference');assert.equal(selected.targetId,note.id);assert.equal(note.kind,'footnote');assert.equal(note.inlines[0].text,'Additional evidence 🏛️.');assert.equal(documentIssues(h.doc).length,0);
 assert.equal(legalReferenceText(selected,legalReferenceLabels(h.doc)),'2');assert.equal(h.run(commands.undo),true);assert.ok(h.state.doc.eq(before));assert.equal(h.run(commands.redo),true);assert.equal(h.doc.content.at(-1).id,note.id);
});
test('readonly/immutable edits remain blocked while reference navigation changes no source revision',()=>{
 for(const d of [publicInputEdition(document()),finalizeLegalDocument(document()),{...document(),lifecycle:'signed'}]){const h=harness(d);h.run(insertInternalReference({targetId:'second'}));assert.deepEqual(h.doc,d);h.run(insertFootnote('Not permitted'));assert.deepEqual(h.doc,d);}
 const h=harness(document(),{readOnly:true});h.reference();const before=h.doc;assert.equal(h.run(goToInternalReference),true);assert.equal(h.state.selection.$from.parent.attrs.id,'review-body');assert.strictEqual(h.doc,before);
});
test('cross-paragraph reference/footnote insertions refuse ambiguous ranges',()=>{
 const h=harness(),a=position(h.state,'body')+1,b=position(h.state,'review-body')+1,state=h.state.apply(h.state.tr.setSelection(TextSelection.create(h.state.doc,a,b)));
 assert.equal(insertInternalReference({targetId:'second'})(state),false);assert.equal(insertFootnote('Text')(state),false);assert.equal(insertFootnote('')(h.state),false);assert.equal(appendDefinition('x'.repeat(1001),'Meaning')(h.state),false);
});
function domFixture(){const dom=new JSDOM('<div id="editor"></div>',{url:'https://example.test/'});dom.window.Range.prototype.getClientRects=()=>[];dom.window.Range.prototype.getBoundingClientRect=()=>({left:0,right:0,top:0,bottom:0,width:0,height:0});const names=['window','document','Node','HTMLElement','MutationObserver','navigator','getComputedStyle'],old=new Map(names.map(name=>[name,Object.getOwnPropertyDescriptor(globalThis,name)]));for(const name of names)Object.defineProperty(globalThis,name,{value:name==='getComputedStyle'?dom.window.getComputedStyle.bind(dom.window):dom.window[name],configurable:true,writable:true});return {host:dom.window.document.getElementById('editor'),close(){for(const [name,value]of old){if(value)Object.defineProperty(globalThis,name,value);else delete globalThis[name];}dom.window.close();}};}
test('view-only derived labels refresh unchanged reference nodes after numbering/term edits without persisting display text',()=>{
 const dom=domFixture();let editor;const changes=[];
 try{editor=mountLegalEditor(dom.host,document(),{onChange:d=>changes.push(d)});assert.equal(changes.length,0);assert.equal(dom.host.querySelector('[data-reference="second"]').textContent,'SEC. 2.');assert.equal(dom.host.querySelector('[data-reference="agency"]').textContent,'Agency');assert.equal(dom.host.querySelector('sup').textContent,'1');
 const preview=editor.previewNumbering({profile:'corporate-v1',rules:[]});assert.equal(editor.applyNumbering(preview),true);assert.equal(dom.host.querySelector('[data-reference="second"]').textContent,'(II)');assert.match(legalPlainText(editor.getDocument()),/\(II\) Agency authored clause 1/);assert.equal(changes.length,1);assert.equal(editor.getDocument().content[0].children[1].inlines[0].label,undefined);
 const selected=selectReference(editor.view.state),copy=editor.view.someProp('clipboardTextSerializer');assert.equal(copy(selected.selection.content(),editor.view),'(II)');assert.equal(changes.length,1);
 const html=editor.view.someProp('clipboardSerializer').serializeFragment(selected.selection.content().content,{document:dom.host.ownerDocument});assert.equal(html.textContent,'(II)');const wrapper=dom.host.ownerDocument.createElement('div');wrapper.append(html);const pasted=parsePastedHTML(wrapper.innerHTML,dom.host.ownerDocument);assert.equal(pasted.content.textBetween(0,pasted.content.size,''),'(II)');let atoms=0;pasted.content.descendants(node=>{if(node.type.name==='reference')atoms++;});assert.equal(atoms,0,'Untrusted HTML must not promote cross-document reference identity.');
 editor.view.dispatch(editor.view.state.tr.setSelection(TextSelection.create(editor.view.state.doc,position(editor.view.state,'agency')+1)));assert.equal(editor.command(renameDefinition('Authority')),true);assert.equal(dom.host.querySelector('[data-reference="agency"]').textContent,'Authority');assert.equal(changes.length,2);
 }finally{editor?.destroy();dom.close();}
});
test('missing references remain visible and literal authored labels cannot create active DOM markup',()=>{
 const dom=domFixture();let editor;
 try{const d=document();d.content[0].children[1].inlines[0].targetId='missing';d.content[0].children[1].inlines[4].label='<script>active()</script>';editor=mountLegalEditor(dom.host,d,{readOnly:true});assert.equal(dom.host.querySelector('[data-reference="missing"]').dataset.referenceState,'unresolved');assert.equal(dom.host.querySelector('.internal-reference-unresolved').textContent,'[missing]');assert.equal(dom.host.querySelectorAll('script').length,0);assert.ok(dom.host.textContent.includes('<script>active()</script>'));assert.deepEqual(editor.getDocument(),d);
 }finally{editor?.destroy();dom.close();}
});

test('nested reference paths disambiguate parents and report moves when the local label stays unchanged',()=>{
 const d=document(),child={kind:'section',id:'nested',title:'Nested clause',children:[{kind:'paragraph',id:'nested-body',inlines:[{kind:'text',text:'Nested wording.'}]}]};
 d.content[0].children.push(child);d.content[0].children[1].inlines.push({kind:'reference',targetId:'nested'});
 assert.equal(legalReferenceText({kind:'reference',targetId:'nested'},legalReferenceLabels(d)),'SEC. 1(a)');
 const preview=previewLegalNodeMove(d,'nested','second',1);assert.equal(preview.renamed.some(row=>row.id==='nested'),false);
 assert.deepEqual(preview.referenceChanges,[{sourceId:'links',targetId:'nested',from:'SEC. 1(a)',to:'SEC. 2(a)'}]);
 const numbering=previewLegalNumbering(d,[{parentId:d.id,startAt:7}]);assert.ok(numbering.referenceChanges.some(row=>row.targetId==='nested'&&row.to==='SEC. 7(a)'));
});
test('exhibit context is bounded without cutting surrogate pairs or changing source identity',()=>{
 const d=document(),title='x'.repeat(988)+'🏛️'.repeat(3);d.content.push({kind:'exhibit',id:'long-exhibit',title,children:[{kind:'section',id:'exhibit-section',title:'Exhibit clause',children:[{kind:'paragraph',id:'exhibit-clause-body',inlines:[{kind:'text',text:'Wording.'}]}]}]});
 const text=legalReferenceText({kind:'reference',targetId:'exhibit-section'},legalReferenceLabels(d));assert.ok(text.length<=1000);assert.equal(text.endsWith('… — SEC. 1.'),true);assert.equal(text.isWellFormed(),true);assert.equal(d.content.at(-1).title,title);
});
