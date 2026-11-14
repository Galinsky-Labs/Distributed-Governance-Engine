import {boundedJson,HttpError} from "./account-http.mjs";
import {DocumentError} from "./document-store.mjs";

const route=/^\/api\/(?:settings|workspaces\/([a-f0-9-]{36})(?:\/documents\/([a-f0-9-]{36}))?\/settings)(?:\/(simulate|history|rollback))?$/;
export const SETTINGS_BODY_LIMIT=65536;
export const settingsBodyLimit=path=>route.test(path)?SETTINGS_BODY_LIMIT:8192;
const query=(url,allowed)=>{
  for(const key of url.searchParams.keys())
    if(!allowed.includes(key)||url.searchParams.getAll(key).length!==1)throw new HttpError(400,"INVALID_QUERY");
};
const number=(url,key,fallback)=>url.searchParams.has(key)?Number(url.searchParams.get(key)):fallback;

/** Settings routes inside the common account handler (cookie, origin, budget and CSRF boundary). */
export function createSettingsRoutes({settings}){
  return async({request,url,credentials,write,method})=>{
    const match=url.pathname.match(route);
    if(!match)return null;
    const [,tenantId,documentId,action]=match;
    const platformRoute=!tenantId;
    const target=source=>platformRoute?{scope:source.scope??"platform",product:source.product??null}:
      documentId?{scope:"document",tenantId,documentId}:{scope:"tenant",tenantId};
    const scopeFields=platformRoute?["scope","product"]:[];
    try{
      if(action==="history"){
        method(["GET"]);
        query(url,[...scopeFields,"before","limit"]);
        return await settings.history(credentials,target(Object.fromEntries(url.searchParams)),{before:number(url,"before",null),limit:number(url,"limit",50)});
      }
      if(!action){
        method(["GET","POST"]);
        if(request.method==="GET"){
          query(url,scopeFields);
          return await settings.read(credentials,target(Object.fromEntries(url.searchParams)));
        }
        write();
        const body=await boundedJson(request,[...scopeFields,"changes","expectedVersion","reason"],[...(platformRoute?["scope"]:[]),"changes","expectedVersion","reason"],SETTINGS_BODY_LIMIT);
        return await settings.change(credentials,target(body),body);
      }
      method(["POST"]);
      write();
      if(action==="simulate"){
        const body=await boundedJson(request,[...scopeFields,"changes","expectedVersion"],[...(platformRoute?["scope"]:[]),"changes","expectedVersion"],SETTINGS_BODY_LIMIT);
        return await settings.simulate(credentials,target(body),body);
      }
      const body=await boundedJson(request,[...scopeFields,"toVersion","expectedVersion","reason"],[...(platformRoute?["scope"]:[]),"toVersion","expectedVersion","reason"]);
      return await settings.rollback(credentials,target(body),body);
    }catch(error){
      if(error instanceof DocumentError)throw new HttpError(error.status,error.code);
      throw error;
    }
  };
}
