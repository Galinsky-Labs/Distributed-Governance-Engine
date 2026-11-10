import test from 'node:test';
import assert from 'node:assert/strict';
import {TextSelection} from 'prosemirror-state';
import {createLegalDocument,publicInputEdition,finalizeLegalDocument,validateLegalDocument} from '../src/legal-structure.mjs';
import {createLegalEditorState,editorToLegal,applyLegalTransaction,commands} from '../editor/model.mjs';
import {selectedTable,insertTableRow,insertTableColumn,deleteTableRow,deleteTableColumn,deleteTable,moveTableCell,TABLE_LIMITS} from '../editor/tables.mjs';
function document(rows=2,columns=2){
 const base=structuredClone(createLegalDocument({id:'table-draft',tenantId:'org',title:'Legal schedule'}));
 base.content=[{kind:'table',id:'table',children:Array.from({length:rows},(_,r)=>({kind:'table-row',id:'row-'+r,children:Array.from({length:columns},(_,c)=>({kind:'table-cell',id:`cell-${r}-${c}`,children:[{kind:'paragraph',id:`p-${r}-${c}`,inlines:[{kind:'text',text:`R${r+1}C${c+1}`,marks:r===0&&c===0?['bold']:[]}]}]}))}))}];
 return validateLegalDocument(base);
}
function select(state,id){let pos;state.doc.descendants((node,p)=>{if(node.type.name==='table_cell'&&node.attrs.id===id)pos=p;});assert.notEqual(pos,undefined);return state.apply(state.tr.setSelection(TextSelection.create(state.doc,pos+2)));}
function harness(doc=document()){
 let current=doc,state=select(createLegalEditorState(doc),'cell-0-0');
 return {get state(){return state;},get doc(){return current;},select(id){state=select(state,id);},run(command){return command(state,tr=>{const result=applyLegalTransaction(state,tr,current);state=result.state;current=result.document;});}};
}
function ids(state){const result=[];state.doc.descendants(node=>{if(!node.isInline)result.push(node.attrs.id);});return result;}
for(const [label,command,rows,columns] of [['row above',insertTableRow('before'),3,2],['row below',insertTableRow('after'),3,2],['column left',insertTableColumn('before'),2,3],['column right',insertTableColumn('after'),2,3]]){
 test('table '+label+' preserves existing identities/text and is one undoable change',()=>{
  const h=harness(),original=h.state.doc,before=ids(h.state);assert.equal(h.run(command),true);
  assert.deepEqual({...selectedTable(h.state),tableId:undefined,row:undefined,column:undefined},{tableId:undefined,row:undefined,column:undefined,rows,columns});
  const after=h.state.doc,all=ids(h.state);assert.equal(all.length,new Set(all).size);for(const id of before)assert.ok(all.includes(id));
  let oldCell;h.state.doc.descendants(node=>{if(node.attrs.id==='p-0-0')oldCell=node;});assert.equal(oldCell.textContent,'R1C1');assert.equal(oldCell.firstChild.marks[0].type.name,'bold');
  assert.equal(h.run(commands.undo),true);assert.ok(h.state.doc.eq(original));assert.equal(h.run(commands.redo),true);assert.ok(h.state.doc.eq(after));
 });
}
test('row/column deletion keeps surviving semantic cells and refuses the last row/column',()=>{
 const h=harness();h.select('cell-1-1');assert.equal(h.run(deleteTableRow),true);assert.equal(selectedTable(h.state).rows,1);
 assert.equal(h.run(deleteTableRow),false);assert.ok(ids(h.state).includes('cell-0-1'));assert.ok(!ids(h.state).includes('cell-1-1'));
 assert.equal(h.run(deleteTableColumn),true);assert.equal(selectedTable(h.state).columns,1);assert.equal(h.run(deleteTableColumn),false);
 assert.deepEqual(h.doc.content[0].children[0].children.map(cell=>cell.id),['cell-0-0']);
});
test('deleting the only table creates a valid empty paragraph and undo restores the exact table',()=>{
 const h=harness(),before=h.state.doc;assert.equal(h.run(deleteTable),true);assert.equal(h.doc.content.length,1);assert.equal(h.doc.content[0].kind,'paragraph');assert.deepEqual(h.doc.content[0].inlines,[]);
 assert.equal(h.run(commands.undo),true);assert.ok(h.state.doc.eq(before));
});
test('Tab navigates existing cells without revision changes and adds a bounded last row',()=>{
 const h=harness(),revision=h.doc.revision;
 assert.equal(h.run(moveTableCell()),true);assert.equal(selectedTable(h.state).column,1);assert.equal(h.doc.revision,revision);
 assert.equal(h.run(moveTableCell({backward:true})),true);assert.equal(selectedTable(h.state).column,0);assert.equal(h.run(moveTableCell({backward:true})),false);
 h.select('cell-1-1');assert.equal(h.run(moveTableCell({grow:false})),false);assert.equal(h.run(moveTableCell({grow:true})),true);
 assert.deepEqual([selectedTable(h.state).row,selectedTable(h.state).column,selectedTable(h.state).rows],[2,0,3]);
 const limit=harness(document(TABLE_LIMITS.rows,TABLE_LIMITS.columns));limit.select(`cell-${TABLE_LIMITS.rows-1}-${TABLE_LIMITS.columns-1}`);
 assert.equal(limit.run(moveTableCell({grow:true})),false);assert.equal(limit.run(insertTableRow()),false);assert.equal(limit.run(insertTableColumn()),false);
});
test('cross-cell selections and non-table paragraphs cannot invoke structural changes',()=>{
 const d=document();let state=createLegalEditorState(d),first,last;
 state.doc.descendants((node,pos)=>{if(node.attrs.id==='cell-0-0')first=pos+2;if(node.attrs.id==='cell-1-1')last=pos+2;});
 state=state.apply(state.tr.setSelection(TextSelection.create(state.doc,first,last)));assert.equal(selectedTable(state),null);
 for(const command of [insertTableRow(),insertTableColumn(),deleteTableRow,deleteTableColumn,deleteTable])assert.equal(command(state),false);
 const plain=createLegalEditorState(createLegalDocument({id:'plain',tenantId:'org',title:'Plain'}));assert.equal(selectedTable(plain),null);assert.equal(insertTableRow()(plain),false);
});
test('immutable public-input/adopted/signed tables reject actual structural transactions',()=>{
 const original=document();
 for(const locked of [publicInputEdition(original),finalizeLegalDocument(original),{...original,lifecycle:'signed'}]){
  let state=select(createLegalEditorState(locked),'cell-0-0'),tr;assert.equal(insertTableColumn()(state,value=>{tr=value;}),true);
  const result=applyLegalTransaction(state,tr,locked);assert.equal(result.changed,false);assert.deepEqual(result.document,locked);assert.ok(state.apply(tr).doc.eq(state.doc));
 }
});
