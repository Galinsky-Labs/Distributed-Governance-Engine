import {Plugin,PluginKey,TextSelection} from 'prosemirror-state';
import {closeHistory} from 'prosemirror-history';
import {previewLegalNodeMove} from '../src/legal-structure.mjs';
const capability=new PluginKey('standaloneSectionMoves'),prepared=new WeakMap();
export function sectionMoveCapability(enabled){return new Plugin({key:capability,state:{init:()=>Object.freeze({editable:enabled===true}),apply:(_tr,value)=>value}});}
function nearest(position){for(let depth=position.depth;depth>0;depth--)if(position.node(depth).type.name==='section')return depth;return null;}
function context(state){
 const {$from,$to}=state.selection,depth=nearest($from),end=nearest($to);
 if(depth===null||end===null||$from.before(depth)!==$to.before(end))return null;
 const parent=$from.node(depth-1),index=$from.index(depth-1);let position=$from.start(depth-1),previous=null;
 for(let i=0;i<index;i++){const sibling=parent.child(i);if(sibling.type.name==='section')previous={node:sibling,position};position+=sibling.nodeSize;}
 return {node:$from.node(depth),position:$from.before(depth),depth,parent,index,previous};
}
export function selectedSection(state){const info=context(state);return info?{id:info.node.attrs.id,title:info.node.attrs.title,canIndent:!!info.previous,canOutdent:info.parent.type.name==='section'}:null;}
function freeze(value){if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;}
export function prepareSectionMove(state,document,direction){
 const info=context(state);if(!info)throw Error('Select text within one section before moving it.');
 let parentId,index,destination;
 if(direction==='indent'){
  if(!info.previous)throw Error('Indent requires a preceding sibling section.');
  parentId=info.previous.node.attrs.id;index=info.previous.node.childCount;destination=info.previous.position+info.previous.node.nodeSize-1;
 }else if(direction==='outdent'){
  if(info.parent.type.name!=='section')throw Error('Only a nested section can be outdented.');
  const grandparent=state.selection.$from.node(info.depth-2);
  parentId=grandparent.type.name==='doc'?document.id:grandparent.attrs.id;
  index=state.selection.$from.index(info.depth-2)+1;
  destination=state.selection.$from.before(info.depth-1)+info.parent.nodeSize;
 }else throw Error('Choose indent or outdent.');
 // The semantic validator checks hierarchy depth, numbering, IDs, and required
 // parent content before ProseMirror attempts any structural transaction.
 const result=previewLegalNodeMove(document,info.node.attrs.id,parentId,index);
 const placement={relation:direction==='indent'?'inside':'after',title:direction==='indent'?info.previous.node.attrs.title:info.parent.attrs.title};
 const display=freeze(structuredClone({...result,sectionId:info.node.attrs.id,title:info.node.attrs.title,direction,placement}));
 prepared.set(display,{source:state.doc,binding:capability.getState(state),sectionId:info.node.attrs.id,position:info.position,destination,node:info.node});
 return display;
}
export function applyPreparedSectionMove(preview){return(state,dispatch)=>{
 const record=preview&&typeof preview==='object'?prepared.get(preview):null,binding=capability.getState(state),info=context(state);
 if(!record||!binding?.editable||record.binding!==binding||!state.doc.eq(record.source)||info?.node.attrs.id!==record.sectionId)return false;
 if(dispatch){
  const {from,to}=state.selection,offsetFrom=from-record.position,offsetTo=to-record.position;
  const tr=state.tr.delete(record.position,record.position+record.node.nodeSize),destination=tr.mapping.map(record.destination,-1);
  tr.insert(destination,record.node);
  tr.setSelection(TextSelection.create(tr.doc,destination+offsetFrom,destination+offsetTo));
  dispatch(closeHistory(tr).scrollIntoView());
 }
 return true;
};}
