import {boundedJson,HttpError} from './account-http.mjs';
import {PrivateDocumentError} from './private-document-store.mjs';

const UUID='[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}';
const ROUTE=new RegExp('^/api/workspaces/('+UUID+')/private-documents/('+UUID+')/updates$');
export const PRIVATE_UPDATE_BODY_LIMIT=65536;
export const privateUpdateBodyLimit=path=>ROUTE.test(path)?PRIVATE_UPDATE_BODY_LIMIT:8192;

/** Mounted ONLY after a production verified device/MLS authorizer is installed. */
export function createPrivateUpdateRoutes({ledger}={}){
 if(typeof ledger?.append!=='function'||typeof ledger?.list!=='function')
  throw Error('Verified private update ledger required');
 return async({request,url,credentials,method,write})=>{
  const match=url.pathname.match(ROUTE);
  if(!match)return null;
  const [,tenantId,documentId]=match;
  try {
   method(['GET','POST']);
   if(request.method==='POST'){
    if(url.search!=='')throw new HttpError(400,'INVALID_QUERY');
    write();
    const frame=await boundedJson(request,[
     'version','cipher','epoch','senderDeviceId','sequence','nonce','ciphertext'
    ],undefined,PRIVATE_UPDATE_BODY_LIMIT);
    return await ledger.append(credentials,tenantId,documentId,frame);
   }
   for(const key of url.searchParams.keys())
    if(!['recipientDeviceId','after','limit'].includes(key)||
       url.searchParams.getAll(key).length!==1)
     throw new HttpError(400,'INVALID_QUERY');
   if(!url.searchParams.has('recipientDeviceId'))throw new HttpError(400,'DEVICE_REQUIRED');
   const options={
    recipientDeviceId:url.searchParams.get('recipientDeviceId'),
    after:Number(url.searchParams.get('after')??0),
    limit:Number(url.searchParams.get('limit')??50)
   };
   return await ledger.list(credentials,tenantId,documentId,options);
  } catch(e) {
   if(e instanceof PrivateDocumentError)throw new HttpError(e.status,e.code);
   throw e;
  }
 };
}
