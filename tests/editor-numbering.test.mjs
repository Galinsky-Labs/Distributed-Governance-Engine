import test from 'node:test';
import assert from 'node:assert/strict';
import {EditorState,TextSelection} from 'prosemirror-state';
import {createLegalDocument,legalOutline,publicInputEdition,finalizeLegalDocument,previewLegalNumbering,applyLegalNumberingRules} from '../src/legal-structure.mjs';
import {createLegalEditorState,editorToLegal,applyLegalTransaction,commands,editorSchema} from '../editor/model.mjs';
import {prepareNumbering,applyPreparedNumbering,fixedNumberingMetadata} from '../editor/numbering.mjs';
function document(){const d=structuredClone(createLegalDocument({id:'numbered',tenantId:'org',title:'Numbered act'}));d.content=[{kind:'section',id:'first',title:'Reports',children:[{kind:'paragraph',id:'first-body',inlines:[{kind:'text',text:'Report annually.',marks:['bold']}]}]},{kind:'section',id:'second',title:'Review',children:[{kind:'paragraph',id:'second-body',inlines:[{kind:'text',text:'See '},{kind:'reference',targetId:'first'}]}]}];return d;}
function harness(d=document(),options){let current=d,state=createLegalEditorState(d,options);return {get doc(){return current;},get state(){return state;},run(command){return command(state,tr=>{const result=applyLegalTransaction(state,tr,current);state=result.state;current=result.document;});}};}
const labels=doc=>legalOutline(doc).map(row=>row.label);
test('preview of profile, starting number and reserved ordinal leaves source unchanged and lists dependent references',()=>{
 const h=harness(),old=h.state.doc;
 const preview=prepareNumbering(h.state,h.doc,{profile:'corporate-v1',rules:[{parentId:'numbered',startAt:4,reserved:[5]}]});
 assert.deepEqual(preview.after.map(row=>row.label),['(IV)','(VI)']);
 assert.deepEqual(preview.affectedReferences,[{sourceId:'second-body',targetId:'first',from:'SEC. 1.',to:'(IV)'}]);
 assert.ok(h.state.doc.eq(old));assert.equal(h.doc.revision,0);assert.ok(Object.isFrozen(preview.changed[0]));
});
test('applying numbering is one undoable revision preserving all semantic IDs, text and marks',()=>{
 const h=harness(),content=structuredClone(h.doc.content),old=h.state.doc;
 const preview=prepareNumbering(h.state,h.doc,{profile:'corporate-v1',rules:[{parentId:'numbered',startAt:4,reserved:[5]}]});
 assert.equal(h.run(applyPreparedNumbering(preview)),true);assert.equal(h.doc.revision,1);assert.deepEqual(labels(h.doc),['(IV)','(VI)']);assert.deepEqual(h.doc.content,content);
 const applied=h.state.doc;assert.equal(h.run(commands.undo),true);assert.ok(h.state.doc.eq(old));assert.equal(h.doc.metadata.numberingProfile,'us-federal-v1');assert.equal(Object.hasOwn(h.doc.metadata,'numberingRules'),false);
 assert.equal(h.run(commands.redo),true);assert.ok(h.state.doc.eq(applied));assert.deepEqual(labels(h.doc),['(IV)','(VI)']);
});
test('undo restores preexisting rules rather than keeping the latest base metadata',()=>{
 const d=document();d.metadata.numberingRules=[{parentId:d.id,startAt:11}];const h=harness(d);
 const preview=prepareNumbering(h.state,h.doc,{rules:[]});assert.equal(h.run(applyPreparedNumbering(preview)),true);assert.deepEqual(labels(h.doc),['SEC. 1.','SEC. 2.']);
 assert.equal(h.run(commands.undo),true);assert.deepEqual(labels(h.doc),['SEC. 11.','SEC. 12.']);assert.deepEqual(h.doc.metadata.numberingRules,d.metadata.numberingRules);
});
test('prepared settings are detached from caller mutation and stale or reconstructed previews cannot apply',()=>{
 const h=harness(),options={profile:'decimal-v1',rules:[{parentId:'numbered',startAt:7}]};
 const preview=prepareNumbering(h.state,h.doc,options);options.rules[0].startAt=99;
 assert.equal(h.run(applyPreparedNumbering({...preview})),false);assert.equal(h.run(applyPreparedNumbering(preview)),true);assert.deepEqual(labels(h.doc),['(7)','(8)']);
 assert.equal(h.run(applyPreparedNumbering(preview)),false);
 const pending=prepareNumbering(h.state,h.doc,{rules:[]});h.run((state,dispatch)=>{dispatch(state.tr.insertText('New ',2));return true;});
 assert.equal(h.run(applyPreparedNumbering(pending)),false);
});
test('selection-only navigation does not invalidate a prepared numbering preview',()=>{
 const h=harness(),preview=prepareNumbering(h.state,h.doc,{rules:[{parentId:'numbered',startAt:3}]});
 h.run((state,dispatch)=>{dispatch(state.tr.setSelection(TextSelection.create(state.doc,4)));return true;});
 assert.equal(h.run(applyPreparedNumbering(preview)),true);assert.equal(h.state.selection.from,4);
});
test('invalid and unrenderable profiles/rules cannot prepare or mutate an editor',()=>{
 const h=harness();for(const options of [{profile:'unknown'},{profile:'corporate-v1',rules:[{parentId:'numbered',startAt:4000}]},{rules:[{parentId:'missing'}]},{rules:[{parentId:'numbered',reserved:[3,2]}]}])assert.throws(()=>prepareNumbering(h.state,h.doc,options));
 assert.equal(h.doc.revision,0);
});
test('immutable and read-only editors cannot apply prepared metadata changes',()=>{
 for(const d of [publicInputEdition(document()),finalizeLegalDocument(document()),{...document(),lifecycle:'signed'},document()]){
  const h=harness(d,{readOnly:true}),preview=prepareNumbering(h.state,h.doc,{rules:[{parentId:d.id,startAt:4}]});
  assert.equal(h.run(applyPreparedNumbering(preview)),false);assert.deepEqual(h.doc,d);
 }
});
test('legacy root defaults retain trusted base metadata while live roots reject metadata mutation',()=>{
 const base=document();base.metadata.numberingProfile='corporate-v1';base.metadata.numberingRules=[{parentId:base.id,startAt:5}];
 const body=createLegalEditorState(base).doc.content,root=editorSchema.nodes.doc.createChecked(null,body);
 assert.deepEqual(editorToLegal(root,base),base);
 const state=EditorState.create({schema:editorSchema,doc:root,plugins:[fixedNumberingMetadata()]});
 const next=state.apply(state.tr.setDocAttribute('numberingProfile','decimal-v1'));assert.ok(next.doc.eq(root));
 const preview=prepareNumbering(state,base,{rules:[]});assert.equal(applyPreparedNumbering(preview)(state),false);
});
test('domain profile override previews and applies the same labels without changing old call defaults',()=>{
 const d=document(),rules=[{parentId:d.id,startAt:3}];
 assert.deepEqual(previewLegalNumbering(d,rules).after.map(row=>row.label),['SEC. 3.','SEC. 4.']);
 const preview=previewLegalNumbering(d,rules,{numberingProfile:'corporate-v1'}),next=applyLegalNumberingRules(d,rules,{numberingProfile:'corporate-v1'});
 assert.deepEqual(labels(next),preview.after.map(row=>row.label));assert.deepEqual(next.content,d.content);
});

test('a numbering preview cannot be applied in another editor with identical body and settings',()=>{
 const first=harness(),other=harness();assert.ok(first.state.doc.eq(other.state.doc));
 const preview=prepareNumbering(first.state,first.doc,{rules:[{parentId:'numbered',startAt:8}]});
 assert.equal(other.run(applyPreparedNumbering(preview)),false);assert.equal(first.run(applyPreparedNumbering(preview)),true);
});
