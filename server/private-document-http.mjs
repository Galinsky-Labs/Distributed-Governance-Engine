import {boundedJson,HttpError} from './account-http.mjs';
import {PrivateDocumentError} from './private-document-store.mjs';

export const PRIVATE_DOCUMENT_BODY_LIMIT=3_950_000;
const PATH=/^\/api\/workspaces\/([a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12})\/private-documents(?:\/([a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}))?$/;
const DEVICE=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
export const privateDocumentBodyLimit=path=>PATH.test(path)?PRIVATE_DOCUMENT_BODY_LIMIT:8192;

/**
 * Mount only after the server installs an authoritative device verifier.
 * This route never accepts a semantic document, plaintext, title, or group key.
 */
export function createPrivateDocumentRoutes({documents}={}){
 if(typeof documents?.create!=='function'||typeof documents?.read!=='function'||typeof documents?.save!=='function')
  throw Error('Private document service required');
 return async({request,url,credentials,write,method})=>{
  const match=url.pathname.match(PATH);
  if(!match)return null;
  if(url.search!=='')throw new HttpError(400,'INVALID_QUERY');
  const [,tenantId,documentId]=match;
  // A claimed endpoint device is only a selector: the installed authorizer
  // must prove it is the session account's own authorized roster device.
  const claimed=request.headers.get('x-dge-device');
  if(claimed!==null&&!DEVICE.test(claimed))throw new HttpError(400,'INVALID_DEVICE');
  const device=claimed===null?{}:{deviceId:claimed};
  try{
   if(!documentId){
    method(['POST']);write();
    const body=await boundedJson(request,['documentId','envelope','commandId'],undefined,PRIVATE_DOCUMENT_BODY_LIMIT);
    return await documents.create(credentials,tenantId,body,device);
   }
   method(['GET','PUT']);
   if(request.method==='GET')return await documents.read(credentials,tenantId,documentId,device);
   write();
   const body=await boundedJson(request,['envelope','expectedVersion','commandId'],undefined,PRIVATE_DOCUMENT_BODY_LIMIT);
   return await documents.save(credentials,tenantId,documentId,body,device);
  }catch(e){
   if(e instanceof PrivateDocumentError)throw new HttpError(e.status,e.code);
   throw e;
  }
 };
}
