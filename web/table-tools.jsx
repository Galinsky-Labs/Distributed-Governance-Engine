import React from 'react';
import {TABLE_LIMITS,insertTableRow,insertTableColumn,deleteTableRow,deleteTableColumn,deleteTable} from '../editor/tables.mjs';
export function TableTools({selection,editable,run}){
 if(!selection)return null;
 const actions=[
  ['Insert row above',insertTableRow('before'),selection.rows>=TABLE_LIMITS.rows],
  ['Insert row below',insertTableRow('after'),selection.rows>=TABLE_LIMITS.rows],
  ['Insert column left',insertTableColumn('before'),selection.columns>=TABLE_LIMITS.columns],
  ['Insert column right',insertTableColumn('after'),selection.columns>=TABLE_LIMITS.columns],
  ['Delete row',deleteTableRow,selection.rows<=1],
  ['Delete column',deleteTableColumn,selection.columns<=1],
  ['Delete table',deleteTable,false],
 ];
 return <div className="toolbar table-tools" role="group" aria-label="Table layout">
  <p aria-live="polite">Table: {selection.rows} rows, {selection.columns} columns. Row {selection.row+1}, column {selection.column+1}.</p>
  {actions.map(([label,command,unavailable])=><button key={label} disabled={!editable||unavailable} onMouseDown={event=>event.preventDefault()} onClick={()=>run(command,'The table change could not be applied. Select one table cell and try again.')}>{label}</button>)}
  <p className="small">Use Tab and Shift+Tab to move between cells.</p>
 </div>;
}
