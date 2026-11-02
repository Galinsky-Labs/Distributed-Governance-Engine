import {boundedJson,HttpError} from "./account-http.mjs";
import {DocumentError} from "./document-store.mjs";
const pathPattern=/^\/api\/workspaces\/([a-f0-9-]{36})\/documents\/([a-f0-9-]{36})\/proposals\/([a-f0-9-]{36})\/decision(?:\/(ballots|close))?$/;
export const decisionBodyLimit=path=>pathPattern.test(path)?8192:8192;
export function createDecisionRoutes({decisions}){
  return async({request,url,credentials,write,method})=>{
    const parts=url.pathname.match(pathPattern);
    if(!parts)return null;
    if(url.search)throw new HttpError(400,"INVALID_QUERY");
    const [,tenantId,documentId,proposalId,operation]=parts;
    try{
      if(!operation){
        method(["GET","POST"]);
        if(request.method==="GET")return await decisions.read(credentials,tenantId,documentId,proposalId);
        write();
        const body=await boundedJson(request,["hours","commandId"]);
        return await decisions.open(credentials,tenantId,documentId,proposalId,body);
      }
      if(operation==="ballots"){
        method(["POST"]);
        write();
        const body=await boundedJson(request,["choice","expectedVersion","commandId"]);
        return await decisions.cast(credentials,tenantId,documentId,proposalId,body);
      }
      if(operation==="close"){
        method(["POST"]);
        write();
        await boundedJson(request,[]);
        return await decisions.close(credentials,tenantId,documentId,proposalId);
      }
      throw new HttpError(404,"NOT_FOUND");
    }catch(error){
      if(error instanceof DocumentError)throw new HttpError(error.status,error.code);
      throw error;
    }
  };
}
