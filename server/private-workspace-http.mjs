import {boundedJson,HttpError} from './account-http.mjs';
import {PrivateDocumentError} from './private-document-store.mjs';

const ID='[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}';
const DEVICES=new RegExp('^/api/workspaces/('+ID+')/private-devices$');
const PACKAGES=new RegExp('^/api/workspaces/('+ID+')/private-devices/('+ID+')/key-packages$');
const CLAIM=new RegExp('^/api/workspaces/('+ID+')/private-devices/('+ID+')/key-packages/claim$');
const GROUPS=new RegExp('^/api/workspaces/('+ID+')/private-groups$');
const GROUP=new RegExp('^/api/workspaces/('+ID+')/private-groups/('+ID+')$');
const MESSAGES=new RegExp('^/api/workspaces/('+ID+')/private-groups/('+ID+')/messages$');
export const PRIVATE_HANDSHAKE_BODY_LIMIT=2_800_000;
export const PRIVATE_PACKAGE_BODY_LIMIT=1_500_000;
export const privateWorkspaceBodyLimit=path=>MESSAGES.test(path)?PRIVATE_HANDSHAKE_BODY_LIMIT:PACKAGES.test(path)?PRIVATE_PACKAGE_BODY_LIMIT:
 [DEVICES,CLAIM,GROUPS,GROUP].some(r=>r.test(path))?16384:8192;

function query(url,allowed){
 for(const key of url.searchParams.keys())
  if(!allowed.includes(key)||url.searchParams.getAll(key).length!==1)throw new HttpError(400,'INVALID_QUERY');
}
const integer=(value,fallback)=>value===null?fallback:/^[0-9]{1,7}$/.test(value)?Number(value):NaN;

/** Public-material and handshake routes; never accepts plaintext or private keys. */
export function createPrivateWorkspaceRoutes({workspace}={}){
 for(const name of ['publishDevice','publishKeyPackages','directory','claimKeyPackage','createGroup','groups','group','postCommit','messages'])
  if(typeof workspace?.[name]!=='function')throw Error('Private workspace service required');
 return async({request,url,credentials,write,method})=>{
  let match;
  try{
   if((match=url.pathname.match(DEVICES))){
    method(['GET','POST']);
    if(request.method==='GET'){query(url,[]);return await workspace.directory(credentials,match[1]);}
    write();
    return await workspace.publishDevice(credentials,match[1],await boundedJson(request,['deviceId','identity','signatureKey'],undefined,16384));
   }
   if((match=url.pathname.match(PACKAGES))){
    method(['POST']);write();
    return await workspace.publishKeyPackages(credentials,match[1],match[2],await boundedJson(request,['packages'],undefined,PRIVATE_PACKAGE_BODY_LIMIT));
   }
   if((match=url.pathname.match(CLAIM))){
    method(['POST']);write();
    return await workspace.claimKeyPackage(credentials,match[1],match[2],await boundedJson(request,[],undefined,1024));
   }
   if((match=url.pathname.match(GROUPS))){
    method(['GET','POST']);
    if(request.method==='GET'){query(url,[]);return await workspace.groups(credentials,match[1]);}
    write();
    return await workspace.createGroup(credentials,match[1],await boundedJson(request,['documentId','groupId','deviceId'],undefined,16384));
   }
   if((match=url.pathname.match(GROUP))){
    method(['GET']);query(url,[]);
    return await workspace.group(credentials,match[1],match[2]);
   }
   if((match=url.pathname.match(MESSAGES))){
    method(['GET','POST']);
    if(request.method==='POST'){
     write();
     return await workspace.postCommit(credentials,match[1],match[2],await boundedJson(request,
      ['deviceId','epoch','commit','welcome','add','remove','commandId'],undefined,PRIVATE_HANDSHAKE_BODY_LIMIT));
    }
    query(url,['deviceId','after','limit']);
    if(!url.searchParams.has('deviceId'))throw new HttpError(400,'DEVICE_REQUIRED');
    return await workspace.messages(credentials,match[1],match[2],{deviceId:url.searchParams.get('deviceId'),
     after:integer(url.searchParams.get('after'),0),limit:integer(url.searchParams.get('limit'),50)});
   }
   return null;
  }catch(e){
   if(e instanceof PrivateDocumentError)throw new HttpError(e.status,e.code);
   throw e;
  }
 };
}
