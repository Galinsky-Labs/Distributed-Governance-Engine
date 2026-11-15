import {boundedJson,HttpError} from "./account-http.mjs";
import {DocumentError} from "./document-store.mjs";
const pathPattern=/^\/api\/workspaces\/([a-f0-9-]{36})\/documents\/([a-f0-9-]{36})\/proposals\/([a-f0-9-]{36})\/decision(?:\/(ballots|close|finalize|challenges)(?:\/([a-f0-9-]{36})\/(resolve))?)?$/;
export const decisionBodyLimit=path=>pathPattern.test(path)?16384:8192;
export function createDecisionRoutes({decisions}){
  return async({request,url,credentials,write,method})=>{
    const publicReceipt=url.pathname.match(/^\/api\/public\/documents\/([a-f0-9-]{36})\/proposals\/([a-f0-9-]{36})\/decision\/receipt$/);
    if(publicReceipt){
      method(["GET"]);
      if(url.search)throw new HttpError(400,"INVALID_QUERY");
      try{return await decisions.publicReceipt(publicReceipt[1],publicReceipt[2]);}
      catch(error){
        if(error instanceof DocumentError)throw new HttpError(error.status,error.code);
        throw error;
      }
    }
    const parts=url.pathname.match(pathPattern);
    if(!parts)return null;
    if(url.search)throw new HttpError(400,"INVALID_QUERY");
    const [,tenantId,documentId,proposalId,operation,challengeId,resolve]=parts;
    if(challengeId&&operation!=="challenges")throw new HttpError(404,"NOT_FOUND");
    try{
      if(!operation){
        method(["GET","POST"]);
        if(request.method==="GET")return await decisions.read(credentials,tenantId,documentId,proposalId);
        write();
        const body=await boundedJson(request,["hours","commandId","policySettings","electorate","weighting","challengeWindowHours","bundle"],
          ["hours","commandId"],16384);
        return await decisions.open(credentials,tenantId,documentId,proposalId,body);
      }
      if(operation==="ballots"){
        method(["POST"]);
        write();
        const body=await boundedJson(request,["choice","expectedVersion","commandId","onBehalfOf"],["choice","expectedVersion","commandId"]);
        return await decisions.cast(credentials,tenantId,documentId,proposalId,body);
      }
      if(operation==="close"){
        method(["POST"]);
        write();
        await boundedJson(request,[]);
        return await decisions.close(credentials,tenantId,documentId,proposalId);
      }
      if(operation==="finalize"){
        method(["POST"]);
        write();
        await boundedJson(request,[]);
        return await decisions.finalize(credentials,tenantId,documentId,proposalId);
      }
      if(resolve){
        method(["POST"]);
        write();
        const body=await boundedJson(request,["resolution","note","commandId"],["resolution","commandId"]);
        return await decisions.resolveChallenge(credentials,tenantId,documentId,proposalId,challengeId,body);
      }
      method(["GET","POST"]);
      if(request.method==="GET")return await decisions.listChallenges(credentials,tenantId,documentId,proposalId);
      write();
      const body=await boundedJson(request,["reasonCategory","statement","commandId"],undefined,16384);
      return await decisions.challenge(credentials,tenantId,documentId,proposalId,body);
    }catch(error){
      if(error instanceof DocumentError)throw new HttpError(error.status,error.code);
      throw error;
    }
  };
}
