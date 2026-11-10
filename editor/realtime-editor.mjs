import * as Y from 'yjs';
import {EditorState,TextSelection} from 'prosemirror-state';
import {EditorView} from 'prosemirror-view';
import {toggleMark,baseKeymap} from 'prosemirror-commands';
import {keymap} from 'prosemirror-keymap';
import {splitListItem} from 'prosemirror-schema-list';
import {ySyncPlugin,yUndoPlugin,undo as yUndo,redo as yRedo,initProseMirrorDoc,yDocToProsemirror} from 'y-prosemirror';
import {validateLegalDocument} from '../src/legal-structure.mjs';
import {validateTextSelection} from '../src/text-selections.mjs';
import {editorSchema,editorToLegal,commands,identityPlugin} from './model.mjs';
import {findTextMatches,findNextText} from './search.mjs';
import {moveTableCell} from './tables.mjs';
import {fixedNumberingMetadata} from './numbering.mjs';

const UUID=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const binary=(code,bytes)=>{const out=new Uint8Array(bytes.length+1);out[0]=code;out.set(bytes,1);return out;};
const asBytes=data=>data instanceof ArrayBuffer?new Uint8Array(data):
 data instanceof Uint8Array?data:(()=>{throw Error('Expected binary realtime frame');})();
function verifyUpdate(doc,update,base) {
 const trial=new Y.Doc();
 try{
  Y.applyUpdate(trial,Y.encodeStateAsUpdate(doc));
  Y.applyUpdate(trial,update);
  editorToLegal(yDocToProsemirror(editorSchema,trial),base);
 }finally{trial.destroy();}
}
/**
 * Live ProseMirror/Yjs editor, explicitly PUBLIC only. The server owns
 * authorization and persistence; no plaintext private-workspace fallback.
 */
export async function mountPublicRealtimeEditor(element,initial,{
 classification,origin,readOnly=false,onChange=()=>{},onStatus=()=>{},onError=()=>{},onAcknowledged=()=>{},onSelectionChange=()=>{},onConnectionChange=()=>{},
 WebSocketCtor=globalThis.WebSocket,timeoutMs=10000,acknowledgementTimeoutMs=15000
}={}) {
 const base=validateLegalDocument(initial);
 const site=new URL(origin);
 if(classification!=='public'||base.mode!=='collaboration'||base.lifecycle!=='draft'||
    !UUID.test(base.tenantId)||!UUID.test(base.id)||site.protocol!=='https:'||
    site.origin!==origin||!element?.ownerDocument||typeof WebSocketCtor!=='function'||
    !Number.isSafeInteger(timeoutMs)||timeoutMs<100||timeoutMs>60000||
    !Number.isSafeInteger(acknowledgementTimeoutMs)||acknowledgementTimeoutMs<100||acknowledgementTimeoutMs>60000)
  throw Error('Authorized public collaboration editor required');
 const socket=new WebSocketCtor('wss://'+site.host+'/ws/public/'+base.tenantId+'/'+base.id,'dge-public-v1');
 socket.binaryType='arraybuffer';
 let view=null,ydoc=null,acknowledged=null,closed=false,connected=false,sendPending=false,state=null,current=base,inFlight=null,ackTimer,lastAcknowledgedVersion=0;
 const stop=(message)=>{
  if(closed||!connected)return;
  connected=false;clearTimeout(ackTimer);
  if(view)view.setProps({editable:()=>false});
  onConnectionChange(false);
  onStatus(message);
 };
 const initialState=await new Promise((resolve,reject)=>{
  let finished=false;
  const timeout=setTimeout(()=>finish(Error('Public realtime handshake timed out')),timeoutMs);
  const finish=(err,payload)=>{
   if(finished)return;finished=true;clearTimeout(timeout);
   socket.removeEventListener('message',receive);
   socket.removeEventListener('error',failure);
   socket.removeEventListener('close',failure);
   if(err)reject(err);else resolve(payload);
  };
  const receive=event=>{
   try {
    const data=asBytes(event.data);
    if(data[0]!==1||data.length<3||data.length>3000001)
     throw Error('Invalid realtime snapshot');
    finish(null,data.slice(1));
   }catch(error){finish(error);}
  };
  const failure=()=>finish(Error('Public realtime connection rejected'));
  socket.addEventListener('message',receive);
  socket.addEventListener('error',failure);
  socket.addEventListener('close',failure);
 }).catch(error=>{socket.close();throw error;});
 try {
  ydoc=new Y.Doc();
  Y.applyUpdate(ydoc,initialState,'remote');
  // Keep only server-confirmed history here, including the initial wire state
  // before any local editor normalization creates new Yjs clock entries.
  acknowledged=new Y.Doc();
  Y.applyUpdate(acknowledged,initialState,'remote');
  const type=ydoc.getXmlFragment('prosemirror');
  const {doc,mapping}=initProseMirrorDoc(type,editorSchema);
  current=editorToLegal(doc,base);
  state=EditorState.create({schema:editorSchema,doc,plugins:[
   fixedNumberingMetadata(),identityPlugin(base),ySyncPlugin(type,{mapping}),yUndoPlugin(),
   keymap({'Mod-z':yUndo,'Mod-y':yRedo,'Mod-Shift-z':yRedo,
    'Mod-b':toggleMark(editorSchema.marks.bold),
    'Mod-i':toggleMark(editorSchema.marks.italic),
    'Mod-u':toggleMark(editorSchema.marks.underline),
    'Enter':splitListItem(editorSchema.nodes.list_item),'Tab':moveTableCell({grow:()=>connected&&!readOnly}),'Shift-Tab':moveTableCell({backward:true})}),
   keymap(baseKeymap)
  ]});
  view=new EditorView(element,{state,editable:()=>connected&&!readOnly,
   attributes:{role:'textbox','aria-label':'Shared legal document text','aria-multiline':'true',spellcheck:'true'},
   dispatchTransaction(transaction) {
    try {
     const applied=state.applyTransaction(transaction),next=applied.state;
     const changed=applied.transactions.some(tr=>tr.docChanged);
     const legal=changed?editorToLegal(next.doc,base,{increment:true}):current;
     state=next;view?.updateState(next);if(view)onSelectionChange(view.state);
     if(changed){current=legal;onChange(current);}
    }catch(error){onError(error.message);}
   }
  });
  if(state!==view.state)view.updateState(state);
  onSelectionChange(view.state);
  const remaining=()=>{
   // State vectors alone omit delete-set confirmation. Yjs snapshots compare
   // both clocks and deletion ranges, avoiding repeated already-saved deletes.
   if(Y.equalSnapshots(Y.snapshot(ydoc),Y.snapshot(acknowledged)))return null;
   return Y.encodeStateAsUpdate(ydoc,Y.encodeStateVector(acknowledged));
  };
  const schedule=()=>{
   if(sendPending||closed||!connected||readOnly)return;
   sendPending=true;
   queueMicrotask(()=>{
    sendPending=false;
    if(closed||!connected||inFlight||socket.readyState!==1)return;
    try {
     const update=remaining();
     if(!update)return;
     if(update.byteLength>65535)throw Error('Realtime update exceeds 64 KiB');
     if(update.byteLength<=2)return;
     inFlight=update;
     ackTimer=setTimeout(()=>{
      if(closed||!connected||!inFlight)return;
      stop('Save acknowledgement timed out. Export unsaved text before reopening.');socket.close();
     },acknowledgementTimeoutMs);
     socket.send(binary(2,update));
    }catch(error){onError(error.message);stop('Realtime updates paused; preserve a local export.');socket.close();}
   });
  };
  ydoc.on('update',(_update,source)=>{
   if(source==='remote'||!connected||readOnly)return;
   onStatus('Saving live edits; waiting for server confirmation.');
   schedule();
  });
  const receive=event=>{
   if(closed||!connected)return;
   try {
    const data=asBytes(event.data);
    if(data[0]===4) {
     if(data.length!==5)throw Error('Invalid collaboration save acknowledgement');
     const version=new DataView(data.buffer,data.byteOffset+1,4).getUint32(0);
     if(version<1||version>1000000||version<lastAcknowledgedVersion||!inFlight)throw Error('Invalid acknowledged version');
     clearTimeout(ackTimer);
     Y.applyUpdate(acknowledged,inFlight,'confirmed');inFlight=null;lastAcknowledgedVersion=version;
     onAcknowledged(version);
     if(remaining()){
      onStatus('Saving remaining live edits after public version '+version+'.');
      schedule();
     }else onStatus('Live edit acknowledged and saved as public version '+version+'.');
     return;
    }
    if(data.length<3||data.length>3000001||![1,2].includes(data[0]))
     throw Error('Unexpected public collaboration frame');
    const update=data.slice(1);
    verifyUpdate(ydoc,update,base);
    Y.applyUpdate(acknowledged,update,'remote');
    Y.applyUpdate(ydoc,update,'remote');
   }catch(error){onError(error.message);stop('Invalid collaboration update; reopen source.');socket.close();}
  };
  const failed=()=>stop('Live connection ended. Export any unsaved text before reopening.');
  socket.addEventListener('message',receive);
  socket.addEventListener('error',failed);
  socket.addEventListener('close',failed);
  connected=true;
  // EditorView computes contenteditable when props/state change; the closure
  // alone does not refresh the DOM after the handshake has completed.
  view.setProps({editable:()=>connected&&!readOnly});
  onConnectionChange(true);
  onStatus('Public collaboration connected; server save acknowledgement is pending.');
  return Object.freeze({
   view,getDocument:()=>current,
   getTextSelection() {
    const selection=view.state.selection;
    if(selection.empty||!selection.$from.sameParent(selection.$to)||!selection.$from.parent.isTextblock)
     throw Error('Select text within one body paragraph.');
    const start=selection.$from.parentOffset,end=selection.$to.parentOffset;
    return validateTextSelection(current,{blockId:selection.$from.parent.attrs.id,start,end,
     quote:selection.$from.parent.textBetween(start,end,'','\uFFFC')});
   },
   findNext(query,options={}) {
    const matches=findTextMatches(view.state,query,options);
    const found=findNextText(query,options)(view.state,view.dispatch);
    if(found)view.focus();
    return {...matches,found};
   },
   command(command) {
    if(closed||!connected||readOnly)return false;
    const action=command===commands.undo?yUndo:command===commands.redo?yRedo:command;
    const changed=action(view.state,view.dispatch,view);
    if(changed)view.focus();
    return !!changed;
   },
   destroy() {
    if(closed)return;closed=true;connected=false;clearTimeout(ackTimer);
    socket.removeEventListener('message',receive);
    socket.removeEventListener('error',failed);
    socket.removeEventListener('close',failed);
    if(socket.readyState<2)socket.close();
    view.destroy();ydoc.destroy();acknowledged.destroy();
    onConnectionChange(false);
   }
  });
 }catch(error){
  if(view)view.destroy();
  if(ydoc)ydoc.destroy();
  if(acknowledged)acknowledged.destroy();
  clearTimeout(ackTimer);
  if(socket.readyState<2)socket.close();
  throw error;
 }
}
