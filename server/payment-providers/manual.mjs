// Manual provider for invoiced customers (DCE-030). A checkout records an
// invoice request; a platform administrator later records the payment or
// refund, which flows through the same idempotent event processing as a
// webhook. There is no webhook and nothing is ever marked paid automatically.
import {DocumentError} from "../document-store.mjs";

const fail=(code,status=400)=>{throw new DocumentError(code,status);};
const REFERENCE=/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/;
const UUID=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const minor=value=>Number.isSafeInteger(value)&&value>=0;

export function createManualProvider({enabled=false}={}){
  const ready=()=>{if(!enabled)fail('PROVIDER_UNAVAILABLE',503);};
  return Object.freeze({
    id:'manual',available:enabled===true,mode:enabled?'invoice':null,
    async createCheckout(){ready();return {providerSessionId:null,url:null,livemode:null,status:'invoice-requested'};},
    verifyWebhook(){fail('WEBHOOK_UNSUPPORTED',404);},
    paymentEvent({checkoutId,invoiceReference,amountMinor,currency,at}){
      ready();
      if(!UUID.test(checkoutId??'')||!REFERENCE.test(invoiceReference??'')||!minor(amountMinor)||typeof currency!=='string'||!/^[A-Z]{3}$/.test(currency))fail('INVALID_MANUAL_PAYMENT');
      return {id:'manual:payment:'+invoiceReference,type:'manual.payment',kind:'checkout-completed',createdAt:at,livemode:null,checkoutId,
        sessionReference:null,paid:true,amountMinor,currency,paymentReference:'manual:'+invoiceReference,subscriptionReference:null};
    },
    refundEvent({checkoutId,refundReference,refundedMinor,at}){
      ready();
      if(!UUID.test(checkoutId??'')||!REFERENCE.test(refundReference??'')||!minor(refundedMinor)||refundedMinor<1)fail('INVALID_MANUAL_REFUND');
      return {id:'manual:refund:'+refundReference,type:'manual.refund',kind:'charge-refunded',createdAt:at,livemode:null,checkoutId,
        chargeReference:null,paymentReference:null,invoiceReference:null,amountMinor:null,refundedMinor,currency:null};
    },
  });
}
export const manualProviderFromEnvironment=(env=process.env)=>createManualProvider({enabled:env.BILLING_MANUAL_INVOICING==='enabled'});
