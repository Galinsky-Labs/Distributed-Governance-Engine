import {boundedJson,HttpError} from "./account-http.mjs";
import {DocumentError} from "./document-store.mjs";

const ID="([a-f0-9-]{36})";
const grants=new RegExp(`^/api/workspaces/${ID}/documents/${ID}/section-grants(?:/(access)|/${ID}/(revoke))?$`);
export const sectionGrantBodyLimit=()=>8192;

/** Clause-level grant administration and each member's effective rights. */
export function createSectionGrantRoutes({sectionGrants}){
  return async({request,url,credentials,write,method})=>{
    const parts=url.pathname.match(grants);
    if(!parts)return null;
    if(url.search)throw new HttpError(400,"INVALID_QUERY");
    const [,tenantId,documentId,access,grantId]=parts;
    try{
      if(access){
        method(["POST"]);write();
        return await sectionGrants.setRestricted(credentials,tenantId,documentId,await boundedJson(request,["restricted","expectedVersion","commandId"]));
      }
      if(grantId){
        method(["POST"]);write();
        return await sectionGrants.revoke(credentials,tenantId,documentId,grantId,await boundedJson(request,["commandId"]));
      }
      method(["GET","POST"]);
      if(request.method==="GET")return await sectionGrants.list(credentials,tenantId,documentId);
      write();
      return await sectionGrants.grant(credentials,tenantId,documentId,await boundedJson(request,
        ["sectionId","grantee","rights","effect","expiresAt","commandId"],["sectionId","grantee","rights","commandId"]));
    }catch(error){
      if(error instanceof DocumentError)throw new HttpError(error.status,error.code);
      throw error;
    }
  };
}
