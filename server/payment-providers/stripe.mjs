// Stripe adapter (DCE-030) against the documented REST API with an injected
// fetch. Only identifiers and integer amounts leave this module; card data,
// keys and raw webhook bodies are never logged or returned.
import {createHmac,timingSafeEqual} from "node:crypto";
import {DocumentError} from "../document-store.mjs";

const fail=(code,status=400)=>{throw new DocumentError(code,status);};
const REFERENCE=/^[A-Za-z0-9_]{1,200}$/;
const UUID=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const reference=value=>{const id=value&&typeof value==='object'?value.id:value;return typeof id==='string'&&REFERENCE.test(id)?id:null;};
const amount=value=>Number.isSafeInteger(value)&&value>=0?value:null;
const currency=value=>typeof value==='string'&&/^[a-z]{3}$/i.test(value)?value.toUpperCase():null;
const seconds=value=>Number.isSafeInteger(value)&&value>0?value*1000:null;
const checkoutReference=value=>typeof value==='string'&&UUID.test(value)?value:null;
function form(entries){
  const body=new URLSearchParams();
  for(const [name,value] of entries)if(value!==undefined&&value!==null)body.append(name,String(value));
  return body.toString();
}

/** Parses `t=…,v1=…[,v1=…]` and checks HMAC-SHA256 over `${t}.${rawBody}` in constant time. */
export function verifyStripeSignature({header,rawBody,secret,toleranceSeconds=300,now=Date.now()}){
  if(typeof header!=='string'||header.length>4096)fail('WEBHOOK_SIGNATURE_INVALID');
  let timestamp=null;const signatures=[];
  for(const part of header.split(',')){
    const at=part.indexOf('=');if(at<1)continue;
    const name=part.slice(0,at).trim(),value=part.slice(at+1).trim();
    if(name==='t'){if(timestamp!==null||!/^[0-9]{1,12}$/.test(value))fail('WEBHOOK_SIGNATURE_INVALID');timestamp=Number(value);}
    else if(name==='v1'&&/^[a-f0-9]{64}$/.test(value))signatures.push(Buffer.from(value,'hex'));
  }
  if(timestamp===null||!signatures.length)fail('WEBHOOK_SIGNATURE_INVALID');
  const expected=createHmac('sha256',secret).update(timestamp+'.').update(rawBody).digest();
  // Compare against every candidate so timing does not reveal which one matched.
  let valid=false;for(const candidate of signatures)valid=timingSafeEqual(candidate,expected)||valid;
  if(!valid)fail('WEBHOOK_SIGNATURE_INVALID');
  if(Math.abs(now-timestamp*1000)>toleranceSeconds*1000)fail('WEBHOOK_TIMESTAMP_STALE');
  return timestamp;
}

/** Maps a verified Stripe event onto the provider-independent event shape. */
export function normalizeStripeEvent(event){
  if(!event||typeof event!=='object'||typeof event.id!=='string'||!/^evt_[A-Za-z0-9_]{1,190}$/.test(event.id)||typeof event.type!=='string'||event.type.length>100||
    !Number.isSafeInteger(event.created)||typeof event.livemode!=='boolean'||!event.data?.object||typeof event.data.object!=='object')fail('WEBHOOK_EVENT_INVALID');
  const object=event.data.object,base={id:event.id,type:event.type,createdAt:event.created*1000,livemode:event.livemode};
  const subscriptionDetails=object.subscription_details??object.parent?.subscription_details;
  switch(event.type){
    case 'checkout.session.completed':
      return {...base,kind:'checkout-completed',checkoutId:checkoutReference(object.client_reference_id)??checkoutReference(object.metadata?.checkout_id),
        sessionReference:reference(object.id),paid:object.payment_status==='paid',amountMinor:amount(object.amount_total),currency:currency(object.currency),
        paymentReference:reference(object.payment_intent),subscriptionReference:reference(object.subscription)};
    case 'invoice.paid':{
      const period=object.lines?.data?.[0]?.period;
      return {...base,kind:'invoice-paid',checkoutId:checkoutReference(subscriptionDetails?.metadata?.checkout_id),invoiceReference:reference(object.id),
        subscriptionReference:reference(object.subscription)??reference(subscriptionDetails?.subscription),paymentReference:reference(object.payment_intent),
        amountMinor:amount(object.amount_paid),currency:currency(object.currency),periodStart:seconds(period?.start),periodEnd:seconds(period?.end)};
    }
    case 'customer.subscription.updated':case 'customer.subscription.deleted':
      return {...base,kind:event.type.endsWith('deleted')?'subscription-deleted':'subscription-updated',checkoutId:checkoutReference(object.metadata?.checkout_id),
        subscriptionReference:reference(object.id),status:typeof object.status==='string'&&/^[a-z_]{1,40}$/.test(object.status)?object.status:null,
        periodEnd:seconds(object.current_period_end??object.items?.data?.[0]?.current_period_end)};
    case 'charge.refunded':
      return {...base,kind:'charge-refunded',chargeReference:reference(object.id),paymentReference:reference(object.payment_intent),invoiceReference:reference(object.invoice),
        amountMinor:amount(object.amount),refundedMinor:amount(object.amount_refunded),currency:currency(object.currency)};
    case 'charge.dispute.created':
      return {...base,kind:'dispute-created',disputeReference:reference(object.id),chargeReference:reference(object.charge),paymentReference:reference(object.payment_intent),
        amountMinor:amount(object.amount),currency:currency(object.currency)};
    default:return {...base,kind:'ignored'};
  }
}

export function createStripeProvider({secretKey=null,webhookSecret=null,fetch=globalThis.fetch,apiBase='https://api.stripe.com',apiVersion=null,toleranceSeconds=300,clock=Date.now}={}){
  const configured=typeof secretKey==='string'&&/^(sk|rk)_(test|live)_[A-Za-z0-9]{8,}$/.test(secretKey)&&
    typeof webhookSecret==='string'&&/^whsec_[A-Za-z0-9+/=]{8,}$/.test(webhookSecret)&&typeof fetch==='function';
  if(!Number.isSafeInteger(toleranceSeconds)||toleranceSeconds<30||toleranceSeconds>900)throw Error('Invalid webhook tolerance');
  if(apiVersion!==null&&!/^[0-9]{4}-[0-9]{2}-[0-9]{2}(?:\.[a-z]+)?$/.test(apiVersion))throw Error('Invalid Stripe API version');
  const mode=configured?(secretKey.includes('_test_')?'test':'live'):null;
  const ready=()=>{if(!configured)fail('PROVIDER_UNAVAILABLE',503);};
  async function request(method,path,body,idempotencyKey){
    ready();
    let response;
    try{
      response=await fetch(apiBase+path,{method,headers:{authorization:'Bearer '+secretKey,
        ...(body?{'content-type':'application/x-www-form-urlencoded'}:{}),
        ...(idempotencyKey?{'idempotency-key':idempotencyKey}:{}),...(apiVersion?{'stripe-version':apiVersion}:{})},
        ...(body?{body}:{})});
    }catch{fail('PROVIDER_UNREACHABLE',502);}
    if(!response.ok)fail('PROVIDER_REQUEST_FAILED',502);
    try{return await response.json();}catch{fail('PROVIDER_RESPONSE_INVALID',502);}
  }
  const path=(prefix,id,suffix='')=>{if(typeof id!=='string'||!REFERENCE.test(id))fail('INVALID_PROVIDER_REFERENCE');return prefix+id+suffix;};
  return Object.freeze({
    id:'stripe',available:configured,mode,
    async createCheckout({checkoutId,item,successUrl,cancelUrl}){
      const subscription=item.kind==='subscription',prefix='line_items[0][price_data]';
      const session=await request('POST','/v1/checkout/sessions',form([
        ['mode',subscription?'subscription':'payment'],['client_reference_id',checkoutId],['success_url',successUrl],['cancel_url',cancelUrl],
        ['line_items[0][quantity]',1],[prefix+'[currency]',item.price.currency.toLowerCase()],[prefix+'[unit_amount]',item.price.amountMinor],
        [prefix+'[product_data][name]',item.label],[prefix+'[recurring][interval]',subscription?item.interval:null],
        ['metadata[checkout_id]',checkoutId],[(subscription?'subscription_data':'payment_intent_data')+'[metadata][checkout_id]',checkoutId],
      ]),'dge-checkout-'+checkoutId);
      const url=typeof session?.url==='string'&&session.url.length<=2048?new URL(session.url):null;
      if(!reference(session?.id)||url?.protocol!=='https:')fail('PROVIDER_RESPONSE_INVALID',502);
      return {providerSessionId:session.id,url:url.href,livemode:session.livemode===true,status:'open'};
    },
    verifyWebhook(rawBody,headers){
      ready();
      verifyStripeSignature({header:headers.get('stripe-signature'),rawBody,secret:webhookSecret,toleranceSeconds,now:clock()});
      let event;try{event=JSON.parse(Buffer.from(rawBody).toString('utf8'));}catch{fail('WEBHOOK_EVENT_INVALID');}
      return normalizeStripeEvent(event);
    },
    async fetchCheckout(sessionReference){
      const session=await request('GET',path('/v1/checkout/sessions/',sessionReference));
      return {paid:session.payment_status==='paid',amountMinor:amount(session.amount_total),currency:currency(session.currency),livemode:session.livemode===true,
        paymentReference:reference(session.payment_intent),subscriptionReference:reference(session.subscription)};
    },
    async fetchSubscription(subscriptionReference){
      const subscription=await request('GET',path('/v1/subscriptions/',subscriptionReference));
      return {status:typeof subscription.status==='string'?subscription.status:null,livemode:subscription.livemode===true};
    },
    async fetchPayment(paymentReference){
      const intent=await request('GET',path('/v1/payment_intents/',paymentReference,'?expand[]=latest_charge'));
      const charge=intent.latest_charge&&typeof intent.latest_charge==='object'?intent.latest_charge:null;
      return {refundedMinor:amount(charge?.amount_refunded)??0,disputed:charge?.disputed===true,livemode:intent.livemode===true};
    },
  });
}
export const stripeProviderFromEnvironment=(env=process.env,options={})=>createStripeProvider({
  secretKey:env.STRIPE_SECRET_KEY||null,webhookSecret:env.STRIPE_WEBHOOK_SECRET||null,apiVersion:env.STRIPE_API_VERSION||null,...options});
