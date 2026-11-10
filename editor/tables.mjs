import {Fragment} from 'prosemirror-model';
import {TextSelection} from 'prosemirror-state';
import {closeHistory} from 'prosemirror-history';

export const TABLE_LIMITS=Object.freeze({rows:20,columns:10});
const id=()=>globalThis.crypto.randomUUID();
function cellDepth(position){for(let depth=position.depth;depth>0;depth--)if(position.node(depth).type.name==='table_cell')return depth;return null;}
function context(state){
 const {$from,$to}=state.selection,depth=cellDepth($from),end=cellDepth($to);
 if(depth===null||end===null||$from.before(depth)!==$to.before(end)||depth<3)return null;
 const row=$from.node(depth-1),table=$from.node(depth-2);
 if(row.type.name!=='table_row'||table.type.name!=='table'||!table.childCount||!row.childCount)return null;
 const widths=Array.from({length:table.childCount},(_,i)=>table.child(i).childCount);
 if(widths.some(width=>width!==widths[0]))return null;
 return {table,tablePos:$from.before(depth-2),row:$from.index(depth-2),column:$from.index(depth-1),parent:$from.node(depth-3)};
}
export function selectedTable(state){const info=context(state);return info?{tableId:info.table.attrs.id,row:info.row,column:info.column,rows:info.table.childCount,columns:info.table.firstChild.childCount}:null;}
function rowPosition(info,index){let pos=info.tablePos+1;for(let i=0;i<index;i++)pos+=info.table.child(i).nodeSize;return pos;}
function cellPosition(info,row,column){let pos=rowPosition(info,row)+1;for(let i=0;i<column;i++)pos+=info.table.child(row).child(i).nodeSize;return pos;}
function blankCell(schema){return schema.nodes.table_cell.createChecked({id:id()},schema.nodes.paragraph.create({id:id()}));}
function blankRow(schema,columns){return schema.nodes.table_row.createChecked({id:id()},Array.from({length:columns},()=>blankCell(schema)));}
function selectCell(tr,cellId){let position=null;tr.doc.descendants((node,pos)=>{if(node.type.name==='table_cell'&&node.attrs.id===cellId)position=pos;});if(position!==null)tr.setSelection(TextSelection.near(tr.doc.resolve(position+1),1));return tr;}
function finish(dispatch,tr,cellId){if(dispatch)dispatch(closeHistory(selectCell(tr,cellId)).scrollIntoView());return true;}
function rowCommand(side,firstColumn=false){return(state,dispatch)=>{
 const info=context(state);if(!info||!['before','after'].includes(side)||info.table.childCount>=TABLE_LIMITS.rows)return false;
 if(!dispatch)return true;
 const index=info.row+(side==='after'?1:0),row=blankRow(state.schema,info.table.firstChild.childCount);
 return finish(dispatch,state.tr.insert(rowPosition(info,index),row),row.child(firstColumn?0:info.column).attrs.id);
};}
export const insertTableRow=(side='after')=>rowCommand(side);
export function insertTableColumn(side='after'){return(state,dispatch)=>{
 const info=context(state);if(!info||!['before','after'].includes(side)||info.table.firstChild.childCount>=TABLE_LIMITS.columns)return false;
 if(!dispatch)return true;
 const index=info.column+(side==='after'?1:0),tr=state.tr;let focus;
 // Descending positions preserve existing Yjs/ProseMirror cells and their text.
 for(let row=info.table.childCount-1;row>=0;row--){const cell=blankCell(state.schema);if(row===info.row)focus=cell.attrs.id;tr.insert(cellPosition(info,row,index),cell);}
 return finish(dispatch,tr,focus);
};}
export function deleteTableRow(state,dispatch){
 const info=context(state);if(!info||info.table.childCount<=1)return false;
 if(!dispatch)return true;
 const position=rowPosition(info,info.row),focus=info.table.child(info.row===info.table.childCount-1?info.row-1:info.row+1).child(info.column).attrs.id;
 return finish(dispatch,state.tr.delete(position,position+info.table.child(info.row).nodeSize),focus);
}
export function deleteTableColumn(state,dispatch){
 const info=context(state);if(!info||info.table.firstChild.childCount<=1)return false;
 if(!dispatch)return true;
 const focus=info.table.child(info.row).child(info.column===info.table.firstChild.childCount-1?info.column-1:info.column+1).attrs.id,tr=state.tr;
 for(let row=info.table.childCount-1;row>=0;row--){const position=cellPosition(info,row,info.column);tr.delete(position,position+info.table.child(row).child(info.column).nodeSize);}
 return finish(dispatch,tr,focus);
}
export function deleteTable(state,dispatch){
 const info=context(state);if(!info)return false;
 const needsParagraph=info.parent.childCount===1&&!info.parent.type.validContent(Fragment.empty);
 const paragraph=needsParagraph?state.schema.nodes.paragraph.create({id:id()}):null;
 if(paragraph&&!info.parent.type.validContent(Fragment.from(paragraph)))return false;
 if(dispatch){const tr=paragraph?state.tr.replaceWith(info.tablePos,info.tablePos+info.table.nodeSize,paragraph):state.tr.delete(info.tablePos,info.tablePos+info.table.nodeSize);tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(info.tablePos,tr.doc.content.size)),1));dispatch(closeHistory(tr).scrollIntoView());}
 return true;
}
export function moveTableCell({backward=false,grow=false}={}){return(state,dispatch,view)=>{
 const info=context(state);if(!info)return false;
 const columns=info.table.firstChild.childCount,index=info.row*columns+info.column+(backward?-1:1);
 if(index<0)return false;
 if(index>=info.table.childCount*columns){
  const permitted=typeof grow==='function'?grow():grow;
  return !backward&&permitted&&(!view||view.editable)?rowCommand('after',true)(state,dispatch):false;
 }
 if(dispatch)dispatch(selectCell(state.tr,info.table.child(Math.floor(index/columns)).child(index%columns).attrs.id).scrollIntoView());
 return true;
};}
