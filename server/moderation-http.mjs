import {boundedJson,HttpError} from "./account-http.mjs";
import {DocumentError} from "./document-store.mjs";

const ID="([a-f0-9-]{36})";
const reports=new RegExp(`^/api/workspaces/${ID}/reports$`);
const moderation=new RegExp(`^/api/workspaces/${ID}/moderation(?:/(actions|appeals|mine)(?:/${ID}/(resolve))?)?$`);
const publicLog=new RegExp(`^/api/public/documents/${ID}/moderation$`);
export const moderationBodyLimit=()=>8192;

/** Report intake, moderator queue and actions, author appeals and the public log. */
export function createModerationRoutes({moderation:store}){
  return async({request,url,credentials,write,method})=>{
    const log=url.pathname.match(publicLog),report=url.pathname.match(reports),manage=url.pathname.match(moderation);
    if(!log&&!report&&!manage)return null;
    if(url.search)throw new HttpError(400,"INVALID_QUERY");
    try{
      if(log){method(["GET"]);return await store.publicLog(log[1]);}
      if(report){
        method(["POST"]);write();
        return await store.report(credentials,report[1],await boundedJson(request,
          ["targetKind","targetId","reasonCategory","note","commandId"],["targetKind","targetId","reasonCategory","commandId"]));
      }
      const [,tenantId,section,appealId,resolve]=manage;
      if(!section){method(["GET"]);return await store.queue(credentials,tenantId);}
      if(section==="mine"&&!appealId){method(["GET"]);return await store.mine(credentials,tenantId);}
      if(section==="actions"&&!appealId){
        method(["POST"]);write();
        return await store.act(credentials,tenantId,await boundedJson(request,["targetKind","targetId","action","reasonCategory","expectedVersion","commandId"]));
      }
      if(section==="appeals"&&!appealId){
        method(["POST"]);write();
        return await store.appeal(credentials,tenantId,await boundedJson(request,["actionId","statement","commandId"]));
      }
      if(section==="appeals"&&resolve){
        method(["POST"]);write();
        return await store.resolveAppeal(credentials,tenantId,appealId,await boundedJson(request,["decision","note","commandId"],["decision","commandId"]));
      }
      throw new HttpError(404,"NOT_FOUND");
    }catch(error){
      if(error instanceof DocumentError)throw new HttpError(error.status,error.code);
      throw error;
    }
  };
}
