import {boundedJson,HttpError} from "./account-http.mjs";
import {DocumentError} from "./document-store.mjs";

export const WEBHOOK_BODY_LIMIT=65536;
const webhookRoute=/^\/api\/billing\/webhooks\/([a-z][a-z0-9-]{1,30})$/;
const routes=/^\/api\/(?:entitlements(?:\/.*)?|workspaces\/[a-f0-9-]{36}\/entitlements|billing\/checkout)$/;
export const billingBodyLimit=path=>webhookRoute.test(path)?WEBHOOK_BODY_LIMIT:8192;
const noQuery=url=>{if(url.search)throw new HttpError(400,"INVALID_QUERY");};

/** Reads the exact bytes a provider signed, bounded before buffering. */
async function rawBody(request,maxBytes){
  if(Number(request.headers.get("content-length")??0)>maxBytes)throw new HttpError(413,"BODY_TOO_LARGE");
  const reader=request.body?.getReader(),chunks=[];let size=0;
  if(reader)try{
    for(;;){
      const {done,value}=await reader.read();
      if(done)break;
      size+=value.byteLength;
      if(size>maxBytes){await reader.cancel();throw new HttpError(413,"BODY_TOO_LARGE");}
      chunks.push(value);
    }
  }finally{reader.releaseLock();}
  if(!size)throw new HttpError(400,"WEBHOOK_EVENT_INVALID");
  return Buffer.concat(chunks);
}

/**
 * Entitlement, checkout and webhook routes inside the common account handler.
 * Webhooks are authenticated by provider signature only: they never call
 * write() because providers send no browser origin or CSRF token.
 */
export function createBillingRoutes({entitlements,billing}){
  return async({request,url,credentials,write,method})=>{
    try{
      const webhook=url.pathname.match(webhookRoute);
      if(webhook){
        method(["POST"]);
        return await billing.webhook(webhook[1],await rawBody(request,WEBHOOK_BODY_LIMIT),request.headers);
      }
      if(!routes.test(url.pathname))return null;
      noQuery(url);
      if(url.pathname==="/api/billing/checkout"){
        method(["GET","POST"]);
        if(request.method==="GET")return await billing.options(credentials);
        write();
        const body=await boundedJson(request,["provider","itemId","subject","tenantId","idempotencyKey"],["provider","itemId","subject","idempotencyKey"]);
        return await billing.checkout(credentials,body);
      }
      const workspace=url.pathname.match(/^\/api\/workspaces\/([a-f0-9-]{36})\/entitlements$/);
      if(workspace){method(["GET"]);return await entitlements.tenantStatus(credentials,workspace[1]);}
      if(url.pathname==="/api/entitlements"){method(["GET"]);return await entitlements.status(credentials);}
      method(["POST"]);
      write();
      if(url.pathname==="/api/entitlements/grants")
        return await entitlements.createGrant(credentials,await boundedJson(request,["subject","resource","quantity","period","effectiveAt","expiresAt","provenance","reason","idempotencyKey"],["subject","period","provenance","reason","idempotencyKey"]));
      const revoke=url.pathname.match(/^\/api\/entitlements\/grants\/([a-f0-9-]{36})\/revoke$/);
      if(revoke)return await entitlements.revokeGrant(credentials,revoke[1],await boundedJson(request,["reason"]));
      if(url.pathname==="/api/entitlements/refunds")return await entitlements.refundCreation(credentials,await boundedJson(request,["usageId","reason"]));
      if(url.pathname==="/api/entitlements/manual-payments")
        return await billing.recordManualPayment(credentials,await boundedJson(request,["checkoutId","invoiceReference","amountMinor","currency"]));
      if(url.pathname==="/api/entitlements/manual-refunds")
        return await billing.recordManualRefund(credentials,await boundedJson(request,["checkoutId","refundReference","refundedMinor"]));
      throw new HttpError(404,"NOT_FOUND");
    }catch(error){
      if(error instanceof DocumentError)throw new HttpError(error.status,error.code);
      throw error;
    }
  };
}
