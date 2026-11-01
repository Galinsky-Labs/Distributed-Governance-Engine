import {validateLegalDocument} from '../src/legal-structure.mjs';
/** Public-content cache only. Private drafts require the encrypted cache adapter. */
export function createPublicDraftCache(storage,{namespace,classification}) {
 if(classification!=='public'||typeof namespace!=='string'||!/^[a-z0-9-]{1,40}$/.test(namespace))throw new Error('Plaintext cache is restricted to explicitly public content');
 const key=(tenantId,id)=>'quill-public-draft-v1:'+namespace+':'+encodeURIComponent(tenantId)+':'+encodeURIComponent(id);
 return {
  save(input){const document=validateLegalDocument(input);if(document.lifecycle!=='draft'||document.mode!=='collaboration')throw new Error('Only working drafts can be cached');try{storage.setItem(key(document.tenantId,document.id),JSON.stringify({version:1,classification:'public',savedAt:new Date().toISOString(),document}));return {state:'saved'};}catch{return {state:'failed',reason:'Storage unavailable or full'};}},
  load({tenantId,id}){let value;try{value=storage.getItem(key(tenantId,id));}catch{return {state:'failed',reason:'Storage unavailable'};}if(value===null)return {state:'empty'};try{
   const record=JSON.parse(value);
   if(record.version!==1||record.classification!=='public')throw Error('Unsupported record');
   if(typeof record.savedAt!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(record.savedAt)||
      !Number.isFinite(Date.parse(record.savedAt))||new Date(record.savedAt).toISOString()!==record.savedAt)
     throw Error('Invalid cache timestamp');
   const document=validateLegalDocument(record.document);
   if(document.tenantId!==tenantId||document.id!==id||document.lifecycle!=='draft'||document.mode!=='collaboration')
     throw Error('Record identity/state mismatch');
   return {state:'available',document,savedAt:record.savedAt};
  }catch{return {state:'corrupt',reason:'The saved public draft could not be validated'};}},
  clear({tenantId,id}){try{storage.removeItem(key(tenantId,id));return {state:'cleared'};}catch{return {state:'failed',reason:'Storage unavailable'};}}
 };
}
