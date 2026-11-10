import test from 'node:test';
import assert from 'node:assert/strict';
import {EditorState,TextSelection} from 'prosemirror-state';
import {createLegalDocument,publicInputEdition,finalizeLegalDocument,indentLegalSection,outdentLegalSection} from '../src/legal-structure.mjs';
import {createLegalEditorState,applyLegalTransaction,commands,editorSchema} from '../editor/model.mjs';
import {selectedSection,prepareSectionMove,applyPreparedSectionMove} from '../editor/sections.mjs';
const p=(id,text)=>({kind:'paragraph',id,inlines:[{kind:'text',text,marks:['bold']}]});
function document(){const d=structuredClone(createLegalDocument({id:'sections',tenantId:'org',title:'Sections act'}));d.content=[{kind:'section',id:'reports',title:'Reports',children:[p('reports-body','Report annually.')]},p('between','Unnumbered preface.'),{kind:'section',id:'review',title:'Review',children:[p('review-body','Review reports.')]},{kind:'section',id:'records',title:'Records',children:[{kind:'paragraph',id:'records-body',inlines:[{kind:'reference',targetId:'review'}]}]}];return d;}
function select(state,id,offset=1){let pos;state.doc.descendants((node,p)=>{if(node.attrs.id===id)pos=p;});assert.notEqual(pos,undefined);return state.apply(state.tr.setSelection(TextSelection.create(state.doc,pos+offset)));}
function harness(doc=document(),options){let current=doc,state=select(createLegalEditorState(doc,options),'review-body');return {get doc(){return current;},get state(){return state;},select(id,offset){state=select(state,id,offset);},run(command){return command(state,tr=>{const result=applyLegalTransaction(state,tr,current);state=result.state;current=result.document;});}};}
function blocks(doc){const found=new Map();const scan=nodes=>{for(const node of nodes){found.set(node.id,{...node,children:undefined});if(node.children)scan(node.children);}};scan(doc.content);return found;}
test('indent preview shows numbering and references without changing the source',()=>{
 const h=harness(),source=h.state.doc,preview=prepareSectionMove(h.state,h.doc,'indent');
 assert.equal(preview.title,'Review');assert.equal(preview.direction,'indent');assert.deepEqual(preview.placement,{relation:'inside',title:'Reports'});assert.ok(h.state.doc.eq(source));
 assert.deepEqual(preview.renamed,[{id:'review',from:'SEC. 2.',to:'(a)'},{id:'records',from:'SEC. 3.',to:'SEC. 2.'}]);
 assert.deepEqual(preview.affectedReferences,[{sourceId:'records-body',targetId:'review',from:'SEC. 2.',to:'(a)'}]);assert.ok(Object.isFrozen(preview.renamed[0]));
});
test('indent/outdent preserve semantic IDs, exact text, marks and selection through one-step undo/redo',()=>{
 const h=harness(),before=h.state.doc,original=blocks(h.doc);h.select('review-body',5);
 const preview=prepareSectionMove(h.state,h.doc,'indent');assert.equal(h.run(applyPreparedSectionMove(preview)),true);
 assert.deepEqual(h.doc,indentLegalSection(document(),'review'));assert.deepEqual(blocks(h.doc),original);assert.equal(selectedSection(h.state).id,'review');assert.equal(h.state.selection.$from.parentOffset,4);
 const nested=h.state.doc;assert.equal(h.run(commands.undo),true);assert.ok(h.state.doc.eq(before));assert.equal(h.run(commands.redo),true);assert.ok(h.state.doc.eq(nested));
 const out=prepareSectionMove(h.state,h.doc,'outdent');assert.equal(h.run(applyPreparedSectionMove(out)),true);assert.equal(h.doc.content[0].id,'reports');assert.equal(h.doc.content[1].id,'review');assert.equal(h.doc.content[2].id,'between');assert.deepEqual(blocks(h.doc),original);
});
test('stale, reconstructed and foreign previews cannot move sections',()=>{
 const h=harness(),other=harness(),preview=prepareSectionMove(h.state,h.doc,'indent');
 assert.equal(other.run(applyPreparedSectionMove(preview)),false);assert.equal(h.run(applyPreparedSectionMove({...preview})),false);
 h.run((state,dispatch)=>{dispatch(state.tr.insertText('New '));return true;});assert.equal(h.run(applyPreparedSectionMove(preview)),false);
});
test('selection may move within the previewed section but not switch its target silently',()=>{
 const h=harness(),preview=prepareSectionMove(h.state,h.doc,'indent');h.select('reports-body');assert.equal(h.run(applyPreparedSectionMove(preview)),false);h.select('review-body',3);assert.equal(h.run(applyPreparedSectionMove(preview)),true);assert.equal(h.state.selection.$from.parentOffset,2);
});
test('plain paragraphs, cross-section ranges, first siblings and top-level outdents refuse unsuitable moves',()=>{
 const h=harness();h.select('between');assert.equal(selectedSection(h.state),null);assert.throws(()=>prepareSectionMove(h.state,h.doc,'indent'));
 h.select('reports-body');assert.equal(selectedSection(h.state).canIndent,false);assert.throws(()=>prepareSectionMove(h.state,h.doc,'indent'));assert.throws(()=>prepareSectionMove(h.state,h.doc,'outdent'));
 let a,b;h.state.doc.descendants((node,pos)=>{if(node.attrs.id==='reports-body')a=pos+1;if(node.attrs.id==='review-body')b=pos+1;});let state=h.state.apply(h.state.tr.setSelection(TextSelection.create(h.state.doc,a,b)));assert.equal(selectedSection(state),null);
});
test('outdent that would empty a required parent fails before constructing a schema repair',()=>{
 const d=document();d.content[0].children=[d.content[2]];d.content.splice(2,1);const h=harness(d);assert.throws(()=>prepareSectionMove(h.state,h.doc,'outdent'));assert.equal(h.doc.revision,0);
});
test('immutable/read-only and live-fragment states cannot apply prepared section moves',()=>{
 for(const d of [publicInputEdition(document()),finalizeLegalDocument(document()),{...document(),lifecycle:'signed'}]){const h=harness(d);assert.throws(()=>prepareSectionMove(h.state,h.doc,'indent'));}
 const readOnly=harness(document(),{readOnly:true}),preview=prepareSectionMove(readOnly.state,readOnly.doc,'indent');assert.equal(readOnly.run(applyPreparedSectionMove(preview)),false);
 const ordinary=harness(),prepared=prepareSectionMove(ordinary.state,ordinary.doc,'indent');let live=EditorState.create({schema:editorSchema,doc:ordinary.state.doc});live=select(live,'review-body');assert.equal(applyPreparedSectionMove(prepared)(live),false);
});

test('outdent within an exhibit targets the exhibit rather than the document root',()=>{
 const d=document(),review=d.content[2];d.content=[{kind:'exhibit',id:'schedule',title:'Schedule',children:[{...d.content[0],children:[p('reports-body','Report annually.'),review]}]}];
 const h=harness(d),preview=prepareSectionMove(h.state,h.doc,'outdent');assert.equal(h.run(applyPreparedSectionMove(preview)),true);
 assert.deepEqual(h.doc,outdentLegalSection(d,'review'));assert.deepEqual(h.doc.content[0].children.map(node=>node.id),['reports','review']);
});
test('indent beyond the numbering hierarchy is rejected before any structural edit',()=>{
 const d=document(),review=d.content[2];let children=[{kind:'section',id:'deepest',title:'Deepest',children:[p('deepest-body','Body')]},review];
 for(let level=4;level>=0;level--)children=[{kind:'section',id:'level-'+level,title:'Level '+level,children:[p('level-body-'+level,'Body'),...children]}];
 d.content=children;const h=harness(d),before=h.state.doc;assert.throws(()=>prepareSectionMove(h.state,h.doc,'indent'),/numbering depth/);assert.ok(h.state.doc.eq(before));assert.equal(h.doc.revision,0);
});
