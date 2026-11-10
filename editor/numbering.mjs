import {Plugin,PluginKey} from 'prosemirror-state';
import {closeHistory} from 'prosemirror-history';
import {previewLegalNumbering} from '../src/legal-structure.mjs';

const capability=new PluginKey('standaloneNumbering');
const prepared=new WeakMap();
export function numberingCapability(enabled){return new Plugin({key:capability,state:{init:()=>Object.freeze({editable:enabled===true}),apply:(_tr,value)=>value}});}
// A Yjs XmlFragment shares the body, not ProseMirror root metadata. Root
// numbering changes require an explicit metadata protocol before live use.
export function fixedNumberingMetadata(){return new Plugin({filterTransaction:(tr,state)=>
 tr.doc.attrs.numberingProfile===state.doc.attrs.numberingProfile&&
 tr.doc.attrs.numberingRulesPresent===state.doc.attrs.numberingRulesPresent&&
 JSON.stringify(tr.doc.attrs.numberingRules)===JSON.stringify(state.doc.attrs.numberingRules)
});}
function freeze(value){if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;}
export function prepareNumbering(state,document,{profile=document.metadata.numberingProfile,rules=document.metadata.numberingRules??[]}={}){
 const settings=structuredClone({profile,rules});
 const result=previewLegalNumbering(document,settings.rules,{numberingProfile:settings.profile});
 const display=freeze(structuredClone(result));
 prepared.set(display,{source:state.doc,settings,binding:capability.getState(state)});
 return display;
}
export function applyPreparedNumbering(preview){return(state,dispatch)=>{
 const record=preview&&typeof preview==='object'?prepared.get(preview):null;
 const binding=capability.getState(state);
 if(!record||!binding?.editable||record.binding!==binding||!state.doc.eq(record.source))return false;
 if(!preview.changed.length&&state.doc.attrs.numberingProfile===record.settings.profile&&
    JSON.stringify(state.doc.attrs.numberingRules??[])===JSON.stringify(record.settings.rules))return false;
 if(dispatch){
  const tr=state.tr.setDocAttribute('numberingProfile',record.settings.profile)
   .setDocAttribute('numberingRules',structuredClone(record.settings.rules))
   .setDocAttribute('numberingRulesPresent',true);
  dispatch(closeHistory(tr));
 }
 return true;
};}
