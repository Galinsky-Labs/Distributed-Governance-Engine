// DCE-030 billing service: checkout creation, verified provider events mapped
// onto idempotent entitlement ledger entries, and read-only reconciliation.
// Providers are replaceable adapters; eligibility and governance never depend
// on them. Purchases only add document-creation entitlements; refunds and
// disputes remove unused purchased credits and never touch participation.
import {randomUUID} from "node:crypto";
import {digest} from "../src/integrity.mjs";
import {DocumentError} from "./document-store.mjs";
import {createPlatformAccess} from "./settings-store.mjs";
import {subjectOf} from "./entitlement-store.mjs";

const UUID=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const KEY=/^[A-Za-z0-9][A-Za-z0-9_.:-]{7,99}$/;
const check=(condition,code,status=400)=>{if(!condition)throw new DocumentError(code,status);};
const TERMINAL_SUBSCRIPTION=['canceled','incomplete_expired','unpaid'];
// Normalized fields kept for retrying out-of-order events: identifiers, integer amounts and status only.
const REF_FIELDS=['checkoutId','sessionReference','paid','amountMinor','currency','paymentReference','subscriptionReference','invoiceReference',
  'chargeReference','disputeReference','status','periodStart','periodEnd','refundedMinor','livemode'];
const refsOf=event=>Object.fromEntries(REF_FIELDS.filter(name=>event[name]!==undefined&&event[name]!==null).map(name=>[name,event[name]]));
const subjectRow=row=>subjectOf(row.tenant_id?{tenantId:row.tenant_id}:{accountId:row.account_id});
const publicCheckout=row=>({checkoutId:row.id,provider:row.provider,status:row.status,url:row.checkout_url??null,itemId:row.item.id,
  subject:row.tenant_id?{kind:'tenant',id:row.tenant_id}:{kind:'account',id:row.account_id}});
const worker=db=>db.query("SELECT set_config('dge.worker','billing',true)");

/** Read-only comparison of provider state with the local ledger. Never changes either side. */
export async function reconcilePayments({transaction,provider,limit=200,clock=Date.now}){
  check(Number.isSafeInteger(limit)&&limit>=1&&limit<=1000,'INVALID_LIMIT');
  const report={provider:provider.id,mode:provider.mode,available:provider.available,generatedAt:new Date(clock()).toISOString(),checked:0,differences:[],pendingEvents:0};
  if(!provider.available)return report;
  const snapshot=await transaction(async db=>{
    await worker(db);
    const checkouts=(await db.query(`SELECT c.*,s.status AS subscription_status,
        (SELECT coalesce(sum(delta),0)::int FROM dge_billing.credit_ledger l JOIN dge_billing.grants g ON g.id=l.grant_id WHERE g.idempotency_key='checkout:'||c.id AND l.kind='purchase') AS purchased,
        (SELECT coalesce(-sum(delta),0)::int FROM dge_billing.credit_ledger l JOIN dge_billing.grants g ON g.id=l.grant_id WHERE g.idempotency_key='checkout:'||c.id AND l.kind='revoke') AS revoked
      FROM dge_billing.checkouts c LEFT JOIN dge_billing.subscriptions s ON s.provider=c.provider AND s.reference=c.subscription_reference
      WHERE c.provider=$1 ORDER BY c.created_at DESC,c.id LIMIT $2`,[provider.id,limit])).rows;
    const pending=(await db.query("SELECT count(*)::int AS n FROM dge_billing.webhook_events WHERE provider=$1 AND outcome='pending-link'",[provider.id])).rows[0].n;
    return {checkouts,pending};
  });
  report.pendingEvents=snapshot.pending;
  const differ=(kind,row,detail={})=>report.differences.push({kind,checkoutId:row.id,...detail});
  for(const row of snapshot.checkouts){
    report.checked++;
    const oneTime=row.item.kind!=='subscription',quantity=row.item.kind==='single-document'?1:row.item.quantity??0;
    if(oneTime&&row.status==='completed'&&row.purchased!==quantity)differ('credit-purchase-mismatch',row,{expected:quantity,recorded:row.purchased});
    const owed=oneTime?Number((BigInt(quantity)*BigInt(row.disputed_at?row.amount_minor:row.refunded_minor))/BigInt(row.amount_minor)):0;
    if(owed>row.revoked)differ('unrecoverable-credits',row,{expected:owed,revoked:row.revoked});
    if(!provider.fetchCheckout||!row.provider_session_id)continue;
    try{
      const remote=await provider.fetchCheckout(row.provider_session_id);
      if(provider.mode&&remote.livemode!==(provider.mode==='live'))differ('mode-mismatch',row,{providerLivemode:remote.livemode});
      if(remote.paid&&row.status!=='completed')differ('paid-not-fulfilled',row,{status:row.status});
      if(!remote.paid&&row.status==='completed')differ('fulfilled-not-paid',row);
      if(remote.amountMinor!==Number(row.amount_minor)||remote.currency!==row.currency)differ('amount-mismatch',row,{provider:{amountMinor:remote.amountMinor,currency:remote.currency},recorded:{amountMinor:Number(row.amount_minor),currency:row.currency}});
      if(row.subscription_reference&&provider.fetchSubscription){
        const subscription=await provider.fetchSubscription(row.subscription_reference);
        if(subscription.status!==row.subscription_status)differ('subscription-status-mismatch',row,{provider:subscription.status,recorded:row.subscription_status});
      }
      if(row.payment_reference&&provider.fetchPayment){
        const payment=await provider.fetchPayment(row.payment_reference);
        if(payment.refundedMinor!==Number(row.refunded_minor))differ('refund-mismatch',row,{provider:payment.refundedMinor,recorded:Number(row.refunded_minor)});
        if(payment.disputed&&!row.disputed_at)differ('dispute-not-applied',row);
      }
    }catch(error){
      if(!(error instanceof DocumentError))throw error;
      differ('provider-unreachable',row,{code:error.code});
    }
  }
  return report;
}

export function createBillingStore({identity,transaction,settings,entitlements,providers=[],origin,clock=Date.now,platformAccess,reauthenticationSeconds=300}){
  check(typeof transaction==='function'&&identity&&settings&&entitlements?.within&&typeof origin==='string'&&new URL(origin).origin===origin&&origin.startsWith('https://'),'INVALID_BILLING_CONFIGURATION',503);
  const registry=new Map(providers.map(provider=>[provider.id,provider]));
  check(registry.size===providers.length,'INVALID_BILLING_CONFIGURATION',503);
  const platform=platformAccess??createPlatformAccess({identity,clock,reauthenticationSeconds});
  const now=()=>{const value=clock();check(Number.isSafeInteger(value)&&value>=0,'CLOCK_UNAVAILABLE',503);return new Date(value);};
  const provider=id=>{const found=typeof id==='string'?registry.get(id):null;check(found,'UNKNOWN_PROVIDER',404);return found;};
  const catalogOf=async db=>(await settings.resolveWithin(db))['billing.catalog'].value;

  const resolve=async(db,providerId,event)=>{
    if(event.checkoutId)return (await db.query("SELECT * FROM dge_billing.checkouts WHERE id=$1 AND provider=$2",[event.checkoutId,providerId])).rows[0]??null;
    for(const ref of [event.subscriptionReference,event.paymentReference,event.invoiceReference,event.chargeReference].filter(Boolean)){
      const row=(await db.query("SELECT c.* FROM dge_billing.provider_links l JOIN dge_billing.checkouts c ON c.id=l.checkout_id WHERE l.provider=$1 AND l.reference=$2",[providerId,ref])).rows[0];
      if(row)return row;
    }
    return null;
  };
  const link=(db,providerId,checkout,refs)=>Promise.all(refs.filter(Boolean).map(ref=>db.query(
    "INSERT INTO dge_billing.provider_links(provider,reference,checkout_id,tenant_id,account_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
    [providerId,ref,checkout.id,checkout.tenant_id,checkout.account_id])));
  const creditGrant=async(db,checkout)=>(await db.query("SELECT id FROM dge_billing.grants WHERE idempotency_key=$1",['checkout:'+checkout.id])).rows[0]?.id??null;
  async function removePurchase(db,providerId,checkout,event,target){
    const grantId=await creditGrant(db,checkout);
    if(grantId)await entitlements.within.revokeCredits(db,subjectRow(checkout),{grantId,target,idempotencyKey:providerId+':'+event.id,reason:event.kind,at:now()});
  }

  const handlers={
    async 'checkout-completed'(db,providerId,event,checkout){
      if(!checkout||!event.paid)return 'ignored';
      if(checkout.provider_session_id&&event.sessionReference!==checkout.provider_session_id)return 'mismatch';
      if(checkout.status==='completed')return 'processed';
      if(event.amountMinor!==Number(checkout.amount_minor)||event.currency!==checkout.currency){
        await db.query("UPDATE dge_billing.checkouts SET status='mismatch' WHERE id=$1",[checkout.id]);
        return 'mismatch';
      }
      const at=now(),item=checkout.item;
      await db.query("UPDATE dge_billing.checkouts SET status='completed',completed_at=$2,payment_reference=$3,subscription_reference=$4,livemode=$5 WHERE id=$1",
        [checkout.id,at,event.paymentReference??null,event.subscriptionReference??null,event.livemode??null]);
      await link(db,providerId,checkout,[event.paymentReference,event.subscriptionReference]);
      if(item.kind==='subscription'){
        check(event.subscriptionReference,'WEBHOOK_EVENT_INVALID');
        await db.query(`INSERT INTO dge_billing.subscriptions(provider,reference,checkout_id,tenant_id,account_id,status,status_event_at)
          VALUES($1,$2,$3,$4,$5,'active',$6) ON CONFLICT DO NOTHING`,[providerId,event.subscriptionReference,checkout.id,checkout.tenant_id,checkout.account_id,new Date(event.createdAt)]);
      }else await entitlements.within.purchaseCredits(db,subjectRow(checkout),{quantity:item.kind==='single-document'?1:item.quantity,provenance:item.kind,
        provenanceRef:providerId+':'+checkout.id,idempotencyKey:'checkout:'+checkout.id,at});
      return 'processed';
    },
    async 'invoice-paid'(db,providerId,event,checkout){
      if(!checkout||checkout.status!=='completed')return 'pending-link';
      const subscription=(await db.query("SELECT * FROM dge_billing.subscriptions WHERE provider=$1 AND reference=$2",[providerId,event.subscriptionReference??checkout.subscription_reference])).rows[0];
      if(!subscription)return 'pending-link';
      if(subscription.status==='canceled')return 'stale';
      check(event.invoiceReference&&event.periodStart&&event.periodEnd>event.periodStart,'WEBHOOK_EVENT_INVALID');
      await link(db,providerId,checkout,[event.invoiceReference,event.paymentReference]);
      await entitlements.within.grantPeriod(db,subjectRow(checkout),{quantity:checkout.item.unlimited?null:checkout.item.quantity,
        effectiveAt:new Date(event.periodStart),expiresAt:new Date(event.periodEnd),provenanceRef:providerId+':'+subscription.reference,
        idempotencyKey:providerId+':invoice:'+event.invoiceReference,at:now()});
      return 'processed';
    },
    async 'subscription-updated'(db,providerId,event){
      const row=(await db.query("SELECT * FROM dge_billing.subscriptions WHERE provider=$1 AND reference=$2",[providerId,event.subscriptionReference])).rows[0];
      if(!row)return 'pending-link';
      if(row.status==='canceled'||event.createdAt<new Date(row.status_event_at).getTime())return 'stale';
      check(event.status,'WEBHOOK_EVENT_INVALID');
      if(TERMINAL_SUBSCRIPTION.includes(event.status))return handlers['subscription-deleted'](db,providerId,event);
      await db.query("UPDATE dge_billing.subscriptions SET status=$3,current_period_end=$4,status_event_at=$5 WHERE provider=$1 AND reference=$2",
        [providerId,row.reference,event.status,event.periodEnd?new Date(event.periodEnd):row.current_period_end,new Date(event.createdAt)]);
      return 'processed';
    },
    async 'subscription-deleted'(db,providerId,event){
      const row=(await db.query("SELECT * FROM dge_billing.subscriptions WHERE provider=$1 AND reference=$2",[providerId,event.subscriptionReference])).rows[0];
      if(!row)return 'pending-link';
      if(row.status==='canceled')return 'processed';
      const at=now(),eventAt=new Date(Math.max(event.createdAt,new Date(row.status_event_at).getTime()));
      await db.query("UPDATE dge_billing.subscriptions SET status='canceled',canceled_at=$3,status_event_at=$3 WHERE provider=$1 AND reference=$2",[providerId,row.reference,eventAt]);
      await entitlements.within.endGrants(db,{provenanceRef:providerId+':'+row.reference,reason:'subscription-canceled',at});
      return 'processed';
    },
    async 'charge-refunded'(db,providerId,event,checkout){
      if(!checkout||checkout.status!=='completed')return 'pending-link';
      check(Number.isSafeInteger(event.refundedMinor),'WEBHOOK_EVENT_INVALID');
      if(checkout.item.kind==='subscription'){
        if(event.refundedMinor>=(event.amountMinor??Number(checkout.amount_minor)))
          await entitlements.within.endGrants(db,{provenanceRef:providerId+':'+checkout.subscription_reference,reason:'payment-refunded',at:now()});
        return 'processed';
      }
      const refunded=Math.min(Number(checkout.amount_minor),Math.max(Number(checkout.refunded_minor),event.refundedMinor));
      const quantity=checkout.item.kind==='single-document'?1:checkout.item.quantity;
      await removePurchase(db,providerId,checkout,event,Number(BigInt(quantity)*BigInt(refunded)/BigInt(checkout.amount_minor)));
      await db.query("UPDATE dge_billing.checkouts SET refunded_minor=$2 WHERE id=$1",[checkout.id,refunded]);
      return 'processed';
    },
    async 'dispute-created'(db,providerId,event,checkout){
      if(!checkout||checkout.status!=='completed')return 'pending-link';
      await db.query("UPDATE dge_billing.checkouts SET disputed_at=coalesce(disputed_at,$2) WHERE id=$1",[checkout.id,now()]);
      if(checkout.item.kind==='subscription')await entitlements.within.endGrants(db,{provenanceRef:providerId+':'+checkout.subscription_reference,reason:'payment-disputed',at:now()});
      else await removePurchase(db,providerId,checkout,event,checkout.item.kind==='single-document'?1:checkout.item.quantity);
      return 'processed';
    },
  };
  const handle=async(db,providerId,event)=>handlers[event.kind]?handlers[event.kind](db,providerId,event,await resolve(db,providerId,event)):'ignored';
  /** Stores the event once by provider event ID, applies it, then retries events that were waiting for a link. */
  async function processEvent(db,providerId,event){
    await worker(db);
    const inserted=(await db.query(`INSERT INTO dge_billing.webhook_events(provider,event_id,event_type,event_created,received_at,outcome,refs)
      VALUES($1,$2,$3,$4,$5,'pending-link',$6) ON CONFLICT DO NOTHING RETURNING event_id`,
      [providerId,event.id,event.type,new Date(event.createdAt),now(),{kind:event.kind,...refsOf(event)}])).rows.length;
    if(!inserted)return {received:true,duplicate:true};
    const settle=async(id,outcome)=>{if(outcome!=='pending-link')await db.query("UPDATE dge_billing.webhook_events SET outcome=$3,processed_at=$4 WHERE provider=$1 AND event_id=$2",[providerId,id,outcome,now()]);};
    const outcome=await handle(db,providerId,event);
    await settle(event.id,outcome);
    if(outcome==='processed'&&['checkout-completed','invoice-paid'].includes(event.kind)){
      const waiting=(await db.query("SELECT event_id,event_type,event_created,refs FROM dge_billing.webhook_events WHERE provider=$1 AND outcome='pending-link' ORDER BY event_created,event_id LIMIT 100",[providerId])).rows;
      for(const row of waiting){
        const retried={...row.refs,id:row.event_id,type:row.event_type,createdAt:new Date(row.event_created).getTime()};
        await settle(row.event_id,await handle(db,providerId,retried));
      }
    }
    return {received:true,duplicate:false,outcome};
  }
  async function requireManualCheckout(db,checkoutId){
    await worker(db);
    check((await db.query("SELECT 1 FROM dge_billing.checkouts WHERE id=$1 AND provider='manual'",[checkoutId])).rows.length,'CHECKOUT_NOT_FOUND',404);
  }
  async function asPlatformAdmin(credentials,operation){
    const accountId=await platform.account(credentials,{write:true});
    return transaction(async db=>{await platform.requireAdmin(db,accountId);return operation(db,accountId);});
  }

  return Object.freeze({
    /** Catalog and provider availability. Purchase controls are shown only for available providers. */
    async options(credentials){
      const accountId=await platform.account(credentials);
      const catalog=await transaction(async db=>{await db.query("SELECT set_config('dge.account_id',$1,true)",[accountId]);return catalogOf(db);});
      const available=providers.filter(p=>p.available).map(p=>({id:p.id,mode:p.mode}));
      return {providers:available,catalog,purchasesEnabled:available.length>0&&catalog.length>0};
    },
    async checkout(credentials,{provider:providerId,itemId,subject,tenantId=null,idempotencyKey}){
      const adapter=provider(providerId);
      check(adapter.available,'PROVIDER_UNAVAILABLE',503);
      check(typeof itemId==='string'&&itemId.length<=40&&['account','tenant'].includes(subject)&&(subject==='tenant'?UUID.test(tenantId??''):tenantId===null),'INVALID_CHECKOUT');
      check(typeof idempotencyKey==='string'&&KEY.test(idempotencyKey),'INVALID_IDEMPOTENCY_KEY');
      const requestDigest=digest('billing-checkout-v1',{provider:adapter.id,itemId,subject,tenantId});
      const reserve=async(db,accountId)=>{
        await db.query("SELECT set_config('dge.account_id',$1,true)",[accountId]);
        const prior=(await db.query("SELECT * FROM dge_billing.checkouts WHERE created_by=$1 AND idempotency_key=$2",[accountId,idempotencyKey])).rows[0];
        if(prior){check(prior.request_digest===requestDigest,'IDEMPOTENCY_KEY_REUSED',409);return prior;}
        const item=(await catalogOf(db)).find(entry=>entry.id===itemId);
        check(item,'CATALOG_ITEM_NOT_FOUND',404);
        check([subject,'either'].includes(item.subject??'either'),'CATALOG_ITEM_SUBJECT');
        const row={id:randomUUID(),provider:adapter.id,tenant_id:subject==='tenant'?tenantId:null,account_id:subject==='account'?accountId:null,item,status:'creating',checkout_url:null};
        try{
          await db.query(`INSERT INTO dge_billing.checkouts(id,provider,tenant_id,account_id,created_by,idempotency_key,request_digest,item,amount_minor,currency,status,created_at)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'creating',$11)`,[row.id,adapter.id,row.tenant_id,row.account_id,accountId,idempotencyKey,requestDigest,item,item.price.amountMinor,item.price.currency,now()]);
        }catch(error){if(error.code==='23505')throw new DocumentError('IDEMPOTENCY_KEY_REUSED',409);throw error;}
        return row;
      };
      const row=subject==='tenant'
        ?await identity.withTenant(credentials,tenantId,{write:true,roles:['owner','admin']},(db,actor)=>reserve(db,actor.accountId))
        :await (async()=>{const accountId=await platform.account(credentials,{write:true,recent:false});return transaction(db=>reserve(db,accountId));})();
      if(row.status!=='creating')return publicCheckout(row);
      // The provider call happens outside any database transaction; its
      // idempotency key is the checkout ID, so a retry returns the same session.
      const session=await adapter.createCheckout({checkoutId:row.id,item:row.item,successUrl:origin+'/account?billing=success',cancelUrl:origin+'/account?billing=cancelled'});
      return transaction(async db=>{
        await db.query("SELECT set_config('dge.tenant_id',$1,true),set_config('dge.account_id',$2,true)",[row.tenant_id??'',row.account_id??'']);
        await db.query("UPDATE dge_billing.checkouts SET status=$2,provider_session_id=$3,checkout_url=$4,livemode=$5 WHERE id=$1 AND status='creating'",
          [row.id,session.status,session.providerSessionId,session.url,session.livemode]);
        return publicCheckout((await db.query("SELECT * FROM dge_billing.checkouts WHERE id=$1",[row.id])).rows[0]);
      });
    },
    /** Signature-authenticated provider callback; never a browser session request. */
    async webhook(providerId,rawBody,headers){
      const adapter=provider(providerId);
      check(adapter.available,'PROVIDER_UNAVAILABLE',503);
      const event=adapter.verifyWebhook(rawBody,headers);
      return transaction(db=>processEvent(db,adapter.id,event));
    },
    /** A platform administrator records an invoiced payment; it is processed exactly like a provider event. */
    async recordManualPayment(credentials,{checkoutId,invoiceReference,amountMinor,currency}){
      const event=provider('manual').paymentEvent({checkoutId,invoiceReference,amountMinor,currency,at:clock()});
      return asPlatformAdmin(credentials,async db=>{await requireManualCheckout(db,checkoutId);return processEvent(db,'manual',event);});
    },
    /** `refundedMinor` is the cumulative refunded amount, as providers report it. */
    async recordManualRefund(credentials,{checkoutId,refundReference,refundedMinor}){
      const event=provider('manual').refundEvent({checkoutId,refundReference,refundedMinor,at:clock()});
      return asPlatformAdmin(credentials,async db=>{await requireManualCheckout(db,checkoutId);return processEvent(db,'manual',event);});
    },
    reconcile:({provider:providerId,limit=200}={})=>reconcilePayments({transaction,provider:provider(providerId),limit,clock}),
  });
}
