import {EditorState} from 'prosemirror-state';
import {EditorView} from 'prosemirror-view';
import {toggleMark,baseKeymap} from 'prosemirror-commands';
import {keymap} from 'prosemirror-keymap';
import {splitListItem} from 'prosemirror-schema-list';
import {ySyncPlugin,yUndoPlugin,undo as yUndo,redo as yRedo,initProseMirrorDoc} from 'y-prosemirror';
import {editorSchema,editorToLegal,identityPlugin} from './model.mjs';
import {moveTableCell} from './tables.mjs';
import {fixedNumberingMetadata} from './numbering.mjs';
import {referencePresentation} from './reference-presentation.mjs';

/**
 * ProseMirror view over an END-TO-END ENCRYPTED private session's Yjs document.
 * The view never talks to the network: the private workspace session encrypts
 * every local Yjs update with the current MLS epoch key before it leaves the
 * endpoint, and verifies/decrypts every remote update before applying it.
 */
export function mountPrivateEditor(element,session,{readOnly=false,onChange=()=>{},onError=()=>{}}={}){
 if(!element?.ownerDocument||!session?.ydoc||!session.base)throw Error('Private session required');
 const base=session.base;
 const type=session.ydoc.getXmlFragment('prosemirror');
 const {doc,mapping}=initProseMirrorDoc(type,editorSchema);
 let state=EditorState.create({schema:editorSchema,doc,plugins:[
  fixedNumberingMetadata(),referencePresentation(s=>editorToLegal(s.doc,base)),identityPlugin(base),ySyncPlugin(type,{mapping}),yUndoPlugin(),
  keymap({'Mod-z':yUndo,'Mod-y':yRedo,'Mod-Shift-z':yRedo,
   'Mod-b':toggleMark(editorSchema.marks.bold),'Mod-i':toggleMark(editorSchema.marks.italic),
   'Mod-u':toggleMark(editorSchema.marks.underline),
   'Enter':splitListItem(editorSchema.nodes.list_item),'Tab':moveTableCell({grow:()=>!readOnly}),'Shift-Tab':moveTableCell({backward:true})}),
  keymap(baseKeymap)
 ]});
 const view=new EditorView(element,{state,editable:()=>!readOnly&&!session.removed,
  attributes:{role:'textbox','aria-label':'Private document text','aria-multiline':'true',spellcheck:'true'},
  dispatchTransaction(transaction){
   try{
    const applied=state.applyTransaction(transaction);state=applied.state;view.updateState(state);
    if(applied.transactions.some(tr=>tr.docChanged))onChange(editorToLegal(state.doc,base));
   }catch(error){onError(error.message);}
  }
 });
 return Object.freeze({
  view,
  setReadOnly(value){readOnly=!!value;view.setProps({editable:()=>!readOnly&&!session.removed});},
  destroy(){view.destroy();}
 });
}
