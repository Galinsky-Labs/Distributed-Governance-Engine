import {boundedJson,HttpError} from "./account-http.mjs";
import {DocumentError} from "./document-store.mjs";

const ID="([a-f0-9-]{36})";
const rosters=new RegExp(`^/api/workspaces/${ID}/rosters(?:/${ID}(?:/(entries|sync-membership|snapshots)(?:/${ID})?)?)?$`);
const proxies=new RegExp(`^/api/workspaces/${ID}/proxies(?:/${ID}/(revoke))?$`);
export const electorateBodyLimit=()=>8192;

/** Routes for rosters, record-date snapshots and proxy grants. */
export function createElectorateRoutes({electorates}){
  return async({request,url,credentials,write,method})=>{
    const roster=url.pathname.match(rosters),proxy=url.pathname.match(proxies);
    if(!roster&&!proxy)return null;
    if(url.search)throw new HttpError(400,"INVALID_QUERY");
    try{
      if(proxy){
        const [,tenantId,grantId]=proxy;
        method(grantId?["POST"]:["GET","POST"]);
        if(request.method==="GET")return await electorates.listProxies(credentials,tenantId);
        write();
        if(grantId)return await electorates.revokeProxy(credentials,tenantId,grantId,await boundedJson(request,["commandId"]));
        return await electorates.grantProxy(credentials,tenantId,await boundedJson(request,
          ["granteeId","rosterId","decisionId","allocation","expiresAt","commandId"],["granteeId","commandId"]));
      }
      const [,tenantId,rosterId,operation,snapshotId]=roster;
      if(!rosterId){
        method(["GET","POST"]);
        if(request.method==="GET")return await electorates.listRosters(credentials,tenantId);
        write();
        return await electorates.createRoster(credentials,tenantId,await boundedJson(request,["kind","name","commandId"]));
      }
      if(!operation){
        method(["GET"]);
        return await electorates.readRoster(credentials,tenantId,rosterId);
      }
      if(snapshotId){
        if(operation!=="snapshots")throw new HttpError(404,"NOT_FOUND");
        method(["GET"]);
        return await electorates.readSnapshot(credentials,tenantId,rosterId,snapshotId);
      }
      method(["POST"]);
      write();
      if(operation==="entries")return await electorates.recordEntry(credentials,tenantId,rosterId,await boundedJson(request,
        ["principalId","units","class","personKey","validFrom","validTo","evidenceRef","expectedVersion","commandId"],
        ["principalId","units","validFrom","expectedVersion","commandId"]));
      if(operation==="sync-membership")return await electorates.syncMembership(credentials,tenantId,rosterId,await boundedJson(request,["commandId"]));
      return await electorates.createSnapshot(credentials,tenantId,rosterId,await boundedJson(request,["recordDate","commandId"]));
    }catch(error){
      if(error instanceof DocumentError)throw new HttpError(error.status,error.code);
      throw error;
    }
  };
}
