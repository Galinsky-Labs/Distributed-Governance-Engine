// DCE-029 entitlements: grants independent of payment providers, an
// append-only credit ledger and transactional document-creation reservations.
// Reading, discussing and voting never consult this store.
import {randomUUID} from "node:crypto";
import {periodWindow} from "../src/settings-registry.mjs";
import {DocumentError} from "./document-store.mjs";
import {createPlatformAccess} from "./settings-store.mjs";

const UUID=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
// Postgres timestamps end at year 294276; use the last representable day we accept.
const OPEN_ENDED=Date.UTC(9999,11,31,23,59,59);
const KEY=/^[A-Za-z0-9][A-Za-z0-9_.:-]{7,99}$/;
const check=(condition,code,status=400)=>{if(!condition)throw new DocumentError(code,status);};
const ADMIN_PROVENANCE=['administrator','verified-official','enterprise-license'];
const CREDIT_PROVENANCE=['credit-pack','single-document'];
const text=(value,code)=>{check(typeof value==='string'&&value===value.trim()&&value.length>=1&&value.length<=500&&!/[\u0000-\u001f\u007f]/.test(value),code);return value;};
const iso=value=>value===null||value===undefined?null:new Date(value).toISOString();

export const subjectOf=({tenantId=null,accountId=null})=>{
  check((tenantId===null)!==(accountId===null)&&UUID.test(tenantId??accountId),'INVALID_SUBJECT');
  return Object.freeze({tenantId,accountId,key:tenantId?'tenant:'+tenantId:'account:'+accountId});
};
const publicGrant=(row,at)=>({id:row.id,subject:row.tenant_id?{kind:'tenant',id:row.tenant_id}:{kind:'account',id:row.account_id},
  resource:row.resource,quantity:row.quantity,unlimited:row.quantity===null,period:row.period,provenance:row.provenance,
  effectiveAt:iso(row.effective_at),expiresAt:iso(row.expires_at),revokedAt:iso(row.revoked_at),reason:row.reason??null,
  state:row.revoked_at?'revoked':row.expires_at&&new Date(row.expires_at)<=at?'expired':new Date(row.effective_at)>at?'scheduled':'active'});

export function createEntitlementStore({identity,transaction,settings,clock=Date.now,platformAccess,reauthenticationSeconds=300}){
  check(typeof transaction==='function'&&identity&&typeof settings?.resolveWithin==='function','INVALID_ENTITLEMENT_CONFIGURATION',503);
  const platform=platformAccess??createPlatformAccess({identity,clock,reauthenticationSeconds});
  const now=()=>{const value=clock();check(Number.isSafeInteger(value)&&value>=0,'CLOCK_UNAVAILABLE',503);return new Date(value);};
  const setting=(db,name,value)=>db.query("SELECT set_config($1,$2,true)",[name,value]);

  /** Locks and returns the subject's balance row; every credit change goes through this lock. */
  async function lockBalance(db,subject,at){
    await db.query("INSERT INTO dge_billing.balances(subject,tenant_id,account_id,credits,updated_at) VALUES($1,$2,$3,0,$4) ON CONFLICT DO NOTHING",[subject.key,subject.tenantId,subject.accountId,at]);
    return (await db.query("SELECT credits FROM dge_billing.balances WHERE subject=$1 FOR UPDATE",[subject.key])).rows[0].credits;
  }
  async function ledgerEntry(db,subject,{kind,delta,grantId=null,idempotencyKey,reason=null,at}){
    const balance=await lockBalance(db,subject,at);
    const prior=(await db.query("SELECT * FROM dge_billing.credit_ledger WHERE idempotency_key=$1",[idempotencyKey])).rows[0];
    if(prior){
      check(prior.kind===kind&&prior.delta===delta&&prior.tenant_id===subject.tenantId&&prior.account_id===subject.accountId&&(prior.grant_id??null)===grantId,'IDEMPOTENCY_KEY_REUSED',409);
      return {entry:prior,replayed:true};
    }
    const balanceAfter=balance+delta;
    check(balanceAfter>=0,'INSUFFICIENT_CREDITS',402);
    const entry={id:randomUUID(),tenant_id:subject.tenantId,account_id:subject.accountId,grant_id:grantId,kind,delta,balance_after:balanceAfter,idempotency_key:idempotencyKey,reason,created_at:at};
    await db.query("UPDATE dge_billing.balances SET credits=$2,updated_at=$3 WHERE subject=$1",[subject.key,balanceAfter,at]);
    await db.query("INSERT INTO dge_billing.credit_ledger(id,tenant_id,account_id,grant_id,kind,delta,balance_after,idempotency_key,reason,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
      [entry.id,entry.tenant_id,entry.account_id,grantId,kind,delta,balanceAfter,idempotencyKey,reason,at]);
    return {entry,replayed:false};
  }
  async function insertGrant(db,subject,{resource,quantity,period,effectiveAt,expiresAt=null,provenance,provenanceRef=null,reason=null,idempotencyKey,createdBy=null,at}){
    const row={id:randomUUID(),tenant_id:subject.tenantId,account_id:subject.accountId,resource,quantity,period,effective_at:effectiveAt,expires_at:expiresAt,
      provenance,provenance_ref:provenanceRef,reason,idempotency_key:idempotencyKey,created_by:createdBy,created_at:at,revoked_at:null};
    const inserted=(await db.query(`INSERT INTO dge_billing.grants(id,tenant_id,account_id,resource,quantity,period,effective_at,expires_at,provenance,provenance_ref,reason,idempotency_key,created_by,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
      [row.id,row.tenant_id,row.account_id,resource,quantity,period,effectiveAt,expiresAt,provenance,provenanceRef,reason,idempotencyKey,createdBy,at])).rows[0];
    if(inserted)return {grant:row,replayed:false};
    const prior=(await db.query("SELECT * FROM dge_billing.grants WHERE idempotency_key=$1",[idempotencyKey])).rows[0];
    check(prior&&prior.tenant_id===subject.tenantId&&prior.account_id===subject.accountId&&prior.resource===resource&&prior.quantity===quantity&&
      prior.period===period&&prior.provenance===provenance&&iso(prior.expires_at)===iso(expiresAt),'IDEMPOTENCY_KEY_REUSED',409);
    return {grant:prior,replayed:true};
  }
  const usedBetween=async(db,filter,value,start,end)=>(await db.query(`SELECT count(*)::int AS n FROM dge_billing.usage u WHERE ${filter}=$1 AND u.reserved_at>=$2 AND u.reserved_at<$3
    AND NOT EXISTS (SELECT 1 FROM dge_billing.usage_refunds r WHERE r.usage_id=u.id)`,[value,new Date(start),new Date(end)])).rows[0].n;
  async function activeGrants(db,subjects,at){
    return (await db.query(`SELECT * FROM dge_billing.grants WHERE resource='document-create' AND revoked_at IS NULL AND effective_at<=$3
      AND (expires_at IS NULL OR expires_at>$3) AND provenance<>ALL($4::text[]) AND (account_id=$1 OR tenant_id=$2)
      ORDER BY (account_id IS NULL), expires_at NULLS LAST, created_at, id`,[subjects.account?.accountId??null,subjects.tenant?.tenantId??null,at,CREDIT_PROVENANCE])).rows;
  }
  /** Remaining document creations on one grant in the current period, null when unlimited. */
  async function grantRemaining(db,grant,policy,at){
    const official=grant.provenance==='verified-official';
    const capped=official&&policy.officials.mode==='monthly-cap';
    const period=capped?'month':grant.period;
    const window=period==='none'?{start:new Date(grant.effective_at).getTime(),end:grant.expires_at?new Date(grant.expires_at).getTime():OPEN_ENDED}:periodWindow(at.getTime(),period,policy.timeZone);
    const limit=capped?Math.min(grant.quantity??Infinity,policy.officials.monthlyCap):grant.quantity;
    const used=await usedBetween(db,'u.grant_id',grant.id,window.start,window.end);
    return {used,limit,remaining:limit===null||limit===Infinity?null:Math.max(0,limit-used),window};
  }
  const policyFrom=values=>({
    weeklyFree:values['quotas.weeklyFreeDocuments'].value,timeZone:values['quotas.weekTimeZone'].value,
    order:values['entitlements.consumptionOrder'].value,officials:values['officials.grantPolicy'].value,
    heavyUse:values['officials.heavyUseMonthlyThreshold'].value,
  });
  async function allowance(db,accountId,policy,at){
    const window=periodWindow(at.getTime(),'week',policy.timeZone);
    const used=policy.weeklyFree>0?await usedBetween(db,"u.source='weekly-allowance' AND u.account_id",accountId,window.start,window.end):0;
    return {limit:policy.weeklyFree,used,remaining:Math.max(0,policy.weeklyFree-used),resetsAt:new Date(window.end).toISOString(),periodStart:new Date(window.start).toISOString(),timeZone:policy.timeZone};
  }
  async function officialUse(db,grants,policy,at){
    const month=periodWindow(at.getTime(),'month',policy.timeZone);
    let used=0;
    for(const grant of grants.filter(g=>g.provenance==='verified-official'))used+=await usedBetween(db,'u.grant_id',grant.id,month.start,month.end);
    return used;
  }
  async function asPlatformAdmin(credentials,operation){
    const accountId=await platform.account(credentials,{write:true});
    return transaction(async db=>{
      await platform.requireAdmin(db,accountId);
      await setting(db,'dge.worker','billing');
      return operation(db,accountId);
    });
  }

  const store={
    /**
     * Document-creation hook, called by the document store inside its creation
     * transaction after the document row is inserted. Throws
     * ENTITLEMENT_REQUIRED (402) when no source covers the creation; the whole
     * transaction, including any reservation, then rolls back.
     */
    async reserveDocumentCreation(db,{tenantId,accountId,documentId,commandId}){
      check(UUID.test(tenantId)&&UUID.test(accountId)&&UUID.test(documentId)&&UUID.test(commandId),'INVALID_RESERVATION');
      await setting(db,'dge.account_id',accountId);
      const at=now(),policy=policyFrom(await settings.resolveWithin(db,{tenantId}));
      const subjects={account:subjectOf({accountId}),tenant:subjectOf({tenantId})};
      const credits={account:await lockBalance(db,subjects.account,at),tenant:await lockBalance(db,subjects.tenant,at)};
      const record=async(source,{grantId=null,creditEntryId=null}={})=>{
        const usage={id:randomUUID(),source,grantId,creditEntryId};
        await db.query("INSERT INTO dge_billing.usage(id,tenant_id,account_id,document_id,command_id,source,grant_id,credit_entry_id,reserved_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
          [usage.id,tenantId,accountId,documentId,commandId,source,grantId,creditEntryId,at]);
        return Object.freeze({usageId:usage.id,source,grantId});
      };
      for(const source of policy.order){
        if(source==='weekly-allowance'&&(await allowance(db,accountId,policy,at)).remaining>0)return record(source);
        if(source==='grants')for(const grant of await activeGrants(db,subjects,at)){
          const {remaining}=await grantRemaining(db,grant,policy,at);
          if(remaining===null||remaining>0)return record(source,{grantId:grant.id});
        }
        if(source==='credits')for(const kind of ['account','tenant'])if(credits[kind]>0){
          const {entry}=await ledgerEntry(db,subjects[kind],{kind:'reserve',delta:-1,idempotencyKey:'reserve:'+tenantId+':'+commandId,reason:'document-create',at});
          return record(source,{creditEntryId:entry.id});
        }
      }
      throw new DocumentError('ENTITLEMENT_REQUIRED',402);
    },
    /** The signed-in account's own entitlements. */
    async status(credentials){
      const accountId=await platform.account(credentials);
      return transaction(async db=>{
        await setting(db,'dge.account_id',accountId);
        const at=now(),policy=policyFrom(await settings.resolveWithin(db));
        const rows=(await db.query("SELECT * FROM dge_billing.grants WHERE account_id=$1 ORDER BY created_at DESC,id LIMIT 200",[accountId])).rows;
        const active=await activeGrants(db,{account:subjectOf({accountId})},at);
        const remaining=new Map();
        for(const grant of active)remaining.set(grant.id,await grantRemaining(db,grant,policy,at));
        const credits=(await db.query("SELECT credits FROM dge_billing.balances WHERE subject=$1",['account:'+accountId])).rows[0]?.credits??0;
        const week=await allowance(db,accountId,policy,at),officialUsed=await officialUse(db,active,policy,at);
        const official=active.some(g=>g.provenance==='verified-official');
        const capReached=official&&policy.officials.mode==='monthly-cap'&&officialUsed>=policy.officials.monthlyCap;
        const covered=week.remaining>0||credits>0||[...remaining.values()].some(r=>r.remaining===null||r.remaining>0);
        const paidOffer=capReached?'official-monthly-cap-reached':official&&officialUsed>=policy.heavyUse?'official-heavy-use':covered?null:'no-entitlement';
        return {accountId,allowance:week,credits,consumptionOrder:policy.order,
          grants:rows.map(row=>{const current=remaining.get(row.id);return {...publicGrant(row,at),current:current?{used:current.used,remaining:current.remaining}:null};}),
          official:official?{policy:policy.officials,usedThisMonth:officialUsed,heavyUseThreshold:policy.heavyUse}:null,
          // An offer is information only: nothing here starts a payment.
          paidOffer:paidOffer?{reason:paidOffer,automaticCharge:false}:null,
          participation:'Reading, discussing and voting never require an entitlement.'};
      });
    },
    /** Workspace credits, grants and recent reservations; owners and administrators only. */
    async tenantStatus(credentials,tenantId){
      check(UUID.test(tenantId??''),'INVALID_WORKSPACE');
      return identity.withTenant(credentials,tenantId,{roles:['owner','admin']},async(db,actor)=>{
        await setting(db,'dge.account_id',actor.accountId);
        const at=now();
        const credits=(await db.query("SELECT credits FROM dge_billing.balances WHERE subject=$1",['tenant:'+tenantId])).rows[0]?.credits??0;
        const grants=(await db.query("SELECT * FROM dge_billing.grants WHERE tenant_id=$1 ORDER BY created_at DESC,id LIMIT 200",[tenantId])).rows;
        const usage=(await db.query(`SELECT u.id,u.account_id,u.document_id,u.source,u.grant_id,u.reserved_at,r.refunded_at FROM dge_billing.usage u
          LEFT JOIN dge_billing.usage_refunds r ON r.usage_id=u.id WHERE u.tenant_id=$1 ORDER BY u.reserved_at DESC,u.id LIMIT 50`,[tenantId])).rows;
        return {tenantId,credits,grants:grants.map(row=>publicGrant(row,at)),
          usage:usage.map(u=>({id:u.id,accountId:u.account_id,documentId:u.document_id,source:u.source,grantId:u.grant_id,reservedAt:iso(u.reserved_at),refundedAt:iso(u.refunded_at)}))};
      });
    },
    /** Platform administrators grant administrator, verified-official or enterprise-license entitlements. */
    async createGrant(credentials,input){
      check(input&&typeof input==='object','INVALID_GRANT');
      const {subject:subjectInput,resource='document-create',quantity=null,period,effectiveAt=null,expiresAt=null,provenance,reason,idempotencyKey}=input;
      check(subjectInput&&['account','tenant'].includes(subjectInput.kind),'INVALID_SUBJECT');
      const subject=subjectOf(subjectInput.kind==='tenant'?{tenantId:subjectInput.id}:{accountId:subjectInput.id});
      check(ADMIN_PROVENANCE.includes(provenance),'INVALID_PROVENANCE');
      check(['document-create','storage-bytes','seats'].includes(resource),'INVALID_RESOURCE');
      check(quantity===null||(Number.isSafeInteger(quantity)&&quantity>=0&&quantity<=1000000000),'INVALID_QUANTITY');
      check(['none','week','month','year'].includes(period),'INVALID_PERIOD');
      check(provenance!=='verified-official'||(resource==='document-create'&&period==='month'&&expiresAt!==null),'OFFICIAL_GRANT_REQUIRES_MONTHLY_TERM');
      check(typeof idempotencyKey==='string'&&KEY.test(idempotencyKey),'INVALID_IDEMPOTENCY_KEY');
      text(reason,'INVALID_REASON');
      const parse=(value,code)=>{if(value===null)return null;check(typeof value==='string'&&!Number.isNaN(Date.parse(value)),code);return new Date(value);};
      const effective=parse(effectiveAt,'INVALID_EFFECTIVE_AT'),expires=parse(expiresAt,'INVALID_EXPIRES_AT');
      return asPlatformAdmin(credentials,async(db,actorId)=>{
        const at=now(),start=effective??at;
        check(expires===null||expires>start,'INVALID_EXPIRES_AT');
        const {grant,replayed}=await insertGrant(db,subject,{resource,quantity,period,effectiveAt:start,expiresAt:expires,provenance,reason,idempotencyKey:'admin:'+idempotencyKey,createdBy:actorId,at});
        return {grant:publicGrant(grant,at),replayed};
      });
    },
    async revokeGrant(credentials,grantId,{reason}){
      check(UUID.test(grantId??''),'INVALID_GRANT');text(reason,'INVALID_REASON');
      return asPlatformAdmin(credentials,async db=>{
        const at=now();
        const row=(await db.query("UPDATE dge_billing.grants SET revoked_at=$2,revoked_reason=$3 WHERE id=$1 AND revoked_at IS NULL AND provenance=ANY($4::text[]) RETURNING *",[grantId,at,reason,ADMIN_PROVENANCE])).rows[0];
        check(row,'GRANT_NOT_REVOCABLE',409);
        return {grant:publicGrant(row,at)};
      });
    },
    /**
     * Returns one reservation of a committed creation that an administrator
     * classifies as failed. At most once per reservation, also under races.
     */
    async refundCreation(credentials,{usageId,reason}){
      check(UUID.test(usageId??''),'INVALID_USAGE');text(reason,'INVALID_REASON');
      return asPlatformAdmin(credentials,async(db,actorId)=>{
        await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",['dge-refund:'+usageId]);
        const usage=(await db.query("SELECT u.*,l.tenant_id AS credit_tenant,l.account_id AS credit_account FROM dge_billing.usage u LEFT JOIN dge_billing.credit_ledger l ON l.id=u.credit_entry_id WHERE u.id=$1",[usageId])).rows[0];
        check(usage,'USAGE_NOT_FOUND',404);
        if((await db.query("SELECT 1 FROM dge_billing.usage_refunds WHERE usage_id=$1",[usageId])).rows.length)return {refunded:false,alreadyRefunded:true,source:usage.source};
        const at=now();
        let creditEntryId=null;
        if(usage.source==='credits')creditEntryId=(await ledgerEntry(db,subjectOf({tenantId:usage.credit_tenant,accountId:usage.credit_account}),
          {kind:'refund',delta:1,idempotencyKey:'refund:'+usageId,reason:'failed-creation',at})).entry.id;
        await db.query("INSERT INTO dge_billing.usage_refunds(usage_id,tenant_id,account_id,reason,actor_id,credit_entry_id,refunded_at) VALUES($1,$2,$3,$4,$5,$6,$7)",
          [usageId,usage.tenant_id,usage.account_id,reason,actorId,creditEntryId,at]);
        return {refunded:true,alreadyRefunded:false,source:usage.source};
      });
    },
    // Provider-independent operations for the billing service, run inside its
    // verified-provider transaction (dge.worker='billing').
    within:Object.freeze({
      async purchaseCredits(db,subject,{quantity,provenance,provenanceRef,idempotencyKey,at}){
        check(CREDIT_PROVENANCE.includes(provenance)&&Number.isSafeInteger(quantity)&&quantity>=1,'INVALID_PURCHASE');
        const {grant}=await insertGrant(db,subject,{resource:'document-create',quantity,period:'none',effectiveAt:at,provenance,provenanceRef,idempotencyKey,at});
        await ledgerEntry(db,subject,{kind:'purchase',delta:quantity,grantId:grant.id,idempotencyKey:'purchase:'+idempotencyKey,reason:provenance,at});
        return grant;
      },
      async grantPeriod(db,subject,{quantity,effectiveAt,expiresAt,provenanceRef,idempotencyKey,at}){
        return (await insertGrant(db,subject,{resource:'document-create',quantity,period:'none',effectiveAt,expiresAt,provenance:'subscription',provenanceRef,idempotencyKey,at})).grant;
      },
      /** Revokes unused purchased credits up to `target` in total for the grant; never below zero. */
      async revokeCredits(db,subject,{grantId,target,idempotencyKey,reason,at}){
        const balance=await lockBalance(db,subject,at);
        const already=(await db.query("SELECT coalesce(-sum(delta),0)::int AS n FROM dge_billing.credit_ledger WHERE grant_id=$1 AND kind='revoke'",[grantId])).rows[0].n;
        const wanted=Math.max(0,target-already),revoked=Math.min(wanted,balance);
        if(revoked>0)await ledgerEntry(db,subject,{kind:'revoke',delta:-revoked,grantId,idempotencyKey,reason,at});
        return {revoked,unrecoverable:wanted-revoked};
      },
      async endGrants(db,{provenanceRef,reason,at}){
        return (await db.query("UPDATE dge_billing.grants SET revoked_at=$2,revoked_reason=$3 WHERE provenance_ref=$1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>$2) RETURNING id",[provenanceRef,at,reason])).rows.length;
      },
    }),
  };
  return Object.freeze(store);
}
