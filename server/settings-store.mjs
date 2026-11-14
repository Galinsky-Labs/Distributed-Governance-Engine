// DCE-028 settings service: authorization, validation, simulation and the
// append-only version chain. Values and rules come from the pure registry.
import {digest} from "../src/integrity.mjs";
import {
  SETTINGS_REGISTRY,PRODUCTS,SettingsError,validateSettingsChange,applySettingsChanges,
  settingsDelta,resolveEffectiveSettings,diffEffectiveSettings,
} from "../src/settings-registry.mjs";
import {DocumentError} from "./document-store.mjs";

const UUID=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const check=(condition,code,status=400)=>{if(!condition)throw new DocumentError(code,status);};
const SETTINGS_ERROR_STATUS={SETTING_LOCKED_ACTIVE_VOTE:409,SETTING_SCOPE_NOT_ALLOWED:403};
const settingsFailure=error=>new DocumentError(error.code,error.code.startsWith('INVARIANT_')?403:SETTINGS_ERROR_STATUS[error.code]??400);
const reasonText=value=>{check(typeof value==='string'&&value===value.trim()&&value.length>=1&&value.length<=500&&!/[\u0000-\u001f\u007f]/.test(value),'INVALID_REASON');return value;};
const expected=value=>{check(Number.isSafeInteger(value)&&value>=0&&value<=1000000,'INVALID_EXPECTED_VERSION');return value;};
const TENANT_EDITORS=['owner','admin'],DOCUMENT_EDITORS=['owner','admin','editor'];

/**
 * Platform administrator authorization for requests without a workspace.
 * The session is checked by the identity service; the administrator row is
 * checked by the caller inside its own transaction with requirePlatformAdmin.
 */
export function createPlatformAccess({identity,clock=Date.now,reauthenticationSeconds=300}){
  check(Number.isSafeInteger(reauthenticationSeconds)&&reauthenticationSeconds>=60&&reauthenticationSeconds<=3600,'INVALID_PLATFORM_ACCESS_POLICY',503);
  return Object.freeze({
    async account(credentials,{write=false}={}){
      const info=await identity.sessionInfo(credentials?.sessionToken);
      if(write){
        check(info.authenticationMethod==='oidc','RECOVERY_SESSION_RESTRICTED',403);
        check(clock()-Date.parse(info.authenticatedAt)<=reauthenticationSeconds*1000,'REAUTHENTICATION_REQUIRED',403);
      }
      return info.accountId;
    },
    async isAdmin(db,accountId){
      await db.query("SELECT set_config('dge.account_id',$1,true)",[accountId]);
      return (await db.query("SELECT 1 FROM dge_settings.platform_admins WHERE account_id=$1 AND revoked_at IS NULL",[accountId])).rows.length===1;
    },
    async requireAdmin(db,accountId){check(await this.isAdmin(db,accountId),'PLATFORM_ADMIN_REQUIRED',403);},
  });
}

const targetKey=target=>target.scope==='platform'?'platform':target.scope==='product'?'product:'+target.product:
  target.scope==='tenant'?'tenant:'+target.tenantId:'document:'+target.tenantId+':'+target.documentId;
function parseTarget(target){
  check(target&&typeof target==='object','INVALID_SETTINGS_SCOPE');
  const {scope,product=null,tenantId=null,documentId=null}=target;
  const valid=scope==='platform'?product===null&&tenantId===null&&documentId===null:
    scope==='product'?PRODUCTS.includes(product)&&tenantId===null&&documentId===null:
    scope==='tenant'?UUID.test(tenantId??'')&&product===null&&documentId===null:
    scope==='document'?UUID.test(tenantId??'')&&UUID.test(documentId??'')&&product===null:false;
  check(valid,'INVALID_SETTINGS_SCOPE');
  return Object.freeze({scope,product,tenantId,documentId,key:targetKey({scope,product,tenantId,documentId})});
}
const versionDigest=(target,row)=>digest('settings-version-v1',{
  target,version:row.version,overrides:row.overrides,changes:row.changes,reason:row.reason,actorId:row.actor_id,
  createdAt:new Date(row.created_at).toISOString(),rollbackOf:row.rollback_of??null,previousDigest:row.previous_digest??null,
});
const historyItem=row=>({version:row.version,changes:row.changes,reason:row.reason,actorId:row.actor_id,createdAt:new Date(row.created_at).toISOString(),
  rollbackOf:row.rollback_of??null,digest:row.digest,previousDigest:row.previous_digest??null});

export function createSettingsStore({identity,transaction,product='civic',clock=Date.now,reauthenticationSeconds=300,platformAccess}){
  check(typeof transaction==='function'&&identity&&PRODUCTS.includes(product),'INVALID_SETTINGS_CONFIGURATION',503);
  const platform=platformAccess??createPlatformAccess({identity,clock,reauthenticationSeconds});
  const now=()=>{const value=clock();check(Number.isSafeInteger(value)&&value>=0,'CLOCK_UNAVAILABLE',503);return new Date(value);};

  async function latest(db,key){
    return (await db.query("SELECT * FROM dge_settings.versions WHERE target=$1 ORDER BY version DESC LIMIT 1",[key])).rows[0]??null;
  }
  /** Overrides by scope for the given workspace/document, read inside the caller's transaction. */
  async function layers(db,{product:productName=product,tenantId=null,documentId=null}={}){
    const keys={platform:'platform',product:'product:'+(productName??product)};
    if(tenantId)keys.tenant='tenant:'+tenantId;
    if(tenantId&&documentId)keys.document='document:'+tenantId+':'+documentId;
    const rows=(await db.query("SELECT DISTINCT ON (target) target,overrides FROM dge_settings.versions WHERE target=ANY($1::text[]) ORDER BY target,version DESC",[Object.values(keys)])).rows;
    const byTarget=new Map(rows.map(row=>[row.target,row.overrides]));
    return Object.fromEntries(Object.entries(keys).map(([scope,key])=>[scope,byTarget.get(key)??{}]));
  }
  async function documentContext(db,target){
    // Workspace-level anchoring applies to organization documents; public documents are always anchored.
    if(target.scope!=='document')return {visibility:'organization',activeVote:false};
    const document=(await db.query("SELECT visibility FROM dge_documents.documents WHERE tenant_id=$1 AND id=$2",[target.tenantId,target.documentId])).rows[0];
    check(document,'DOCUMENT_NOT_FOUND',404);
    const open=(await db.query("SELECT count(*)::int AS n FROM dge_decisions.decisions WHERE tenant_id=$1 AND document_id=$2 AND state='open'",[target.tenantId,target.documentId])).rows[0].n;
    return {visibility:document.visibility,activeVote:open>0,openDecisions:open};
  }
  const resolveTarget=(layerValues,target,context)=>resolveEffectiveSettings(layerValues,{product:target.scope==='product'?target.product:product,visibility:context.visibility});
  const replaceLayer=(layerValues,target,overrides)=>({...layerValues,[target.scope]:overrides});

  /** Runs `operation(db, actor)` after authorizing `mode` ('read' | 'manage' | 'write') for the target. */
  async function authorized(credentials,target,mode,operation){
    if(target.scope==='platform'||target.scope==='product'){
      const accountId=await platform.account(credentials,{write:mode==='write'});
      return transaction(async db=>{
        const admin=await platform.isAdmin(db,accountId);
        check(mode==='read'||admin,'PLATFORM_ADMIN_REQUIRED',403);
        return operation(db,{accountId,role:admin?'platform-admin':null,editable:admin});
      });
    }
    const editors=target.scope==='tenant'?TENANT_EDITORS:DOCUMENT_EDITORS;
    return identity.withTenant(credentials,target.tenantId,{write:mode==='write',recent:mode==='write',roles:mode==='read'?undefined:editors},async(db,actor)=>{
      await db.query("SELECT set_config('dge.account_id',$1,true)",[actor.accountId]);
      return operation(db,{accountId:actor.accountId,role:actor.role,editable:editors.includes(actor.role)});
    });
  }
  async function affected(db,target,context){
    if(target.scope==='document')return {scope:'document',documents:1,openDecisions:context.openDecisions};
    if(target.scope==='tenant'){
      const row=(await db.query("SELECT (SELECT count(*)::int FROM dge_documents.documents WHERE tenant_id=$1) AS documents,(SELECT count(*)::int FROM dge_decisions.decisions WHERE tenant_id=$1 AND state='open') AS open",[target.tenantId])).rows[0];
      return {scope:'tenant',documents:row.documents,openDecisions:row.open};
    }
    const row=(await db.query("SELECT tenants::int,documents::int,open_decisions::int FROM dge_settings.platform_impact()")).rows[0];
    check(row,'PLATFORM_ADMIN_REQUIRED',403);
    return {scope:'deployment',tenants:row.tenants,documents:row.documents,openDecisions:row.open_decisions};
  }
  function validated(target,changes,context){
    let result;
    try{result=validateSettingsChange({scope:target.scope,changes,context});}
    catch(error){if(error instanceof SettingsError)throw settingsFailure(error);throw error;}
    return result;
  }
  async function preview(db,target,overrides,normalized,context){
    const layerValues=await layers(db,target);
    const next=applySettingsChanges(overrides,normalized);
    const before=resolveTarget(layerValues,target,context).values,after=resolveTarget(replaceLayer(layerValues,target,next),target,context).values;
    return {next,diff:diffEffectiveSettings(before,after)};
  }
  async function commit(db,target,actor,current,next,reason,rollbackOf=null){
    const changes=settingsDelta(current?.overrides??{},next);
    check(Object.keys(changes).length>0,'NO_SETTINGS_CHANGE');
    const row={version:(current?.version??0)+1,overrides:next,changes,reason,actor_id:actor.accountId,created_at:now(),rollback_of:rollbackOf,previous_digest:current?.digest??null};
    row.digest=versionDigest(target.key,row);
    try{
      await db.query(`INSERT INTO dge_settings.versions(target,version,scope,product,tenant_id,document_id,overrides,changes,reason,rollback_of,actor_id,created_at,digest,previous_digest)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [target.key,row.version,target.scope,target.product,target.tenantId,target.documentId,next,changes,reason,rollbackOf,actor.accountId,row.created_at,row.digest,row.previous_digest]);
    }catch(error){
      if(error.code==='23505')throw new DocumentError('SETTINGS_VERSION_CONFLICT',409);
      throw error;
    }
    return historyItem(row);
  }
  async function lockTarget(db,target){await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",['dge-settings:'+target.key]);}

  return Object.freeze({
    registry:()=>SETTINGS_REGISTRY,
    /** Effective settings for another store's transaction (tenant context already set by withTenant). */
    async resolveWithin(db,{tenantId=null,documentId=null,visibility='public'}={}){
      return resolveEffectiveSettings(await layers(db,{tenantId,documentId}),{product,visibility}).values;
    },
    async read(credentials,targetInput){
      const target=parseTarget(targetInput);
      return authorized(credentials,target,'read',async(db,actor)=>{
        const context=await documentContext(db,target),current=await latest(db,target.key);
        const {values,ignored}=resolveTarget(await layers(db,target),target,context);
        const editable=SETTINGS_REGISTRY.filter(d=>actor.editable&&d.mutability!=='invariant'&&d.scopes.includes(target.scope)&&
          !(target.scope==='document'&&context.activeVote&&d.mutability==='locked-while-vote-active')).map(d=>d.key);
        return {target:{scope:target.scope,product:target.product,tenantId:target.tenantId,documentId:target.documentId},
          version:current?.version??0,overrides:current?.overrides??{},effective:values,ignoredOverrides:ignored,
          editableKeys:editable,role:actor.role,activeVote:context.activeVote};
      });
    },
    async simulate(credentials,targetInput,{changes,expectedVersion}){
      const target=parseTarget(targetInput);expected(expectedVersion);
      return authorized(credentials,target,'manage',async(db)=>{
        const context=await documentContext(db,target),current=await latest(db,target.key),currentVersion=current?.version??0;
        const {valid,errors,normalized}=validated(target,changes,context);
        const result={valid,errors,currentVersion,stale:currentVersion!==expectedVersion,diff:[],affected:await affected(db,target,context)};
        if(!valid)return result;
        const {diff}=await preview(db,target,current?.overrides??{},normalized,context);
        const voteRulesChanged=diff.some(item=>item.key.startsWith('votes.')||item.key==='trust.tiersAllowed');
        return {...result,diff,frozenDecisionNotice:voteRulesChanged&&result.affected.openDecisions>0?
          'Open decisions keep the frozen policy they opened with; only decisions opened later use the new rules.':null};
      });
    },
    async change(credentials,targetInput,{changes,expectedVersion,reason}){
      const target=parseTarget(targetInput);expected(expectedVersion);reasonText(reason);
      return authorized(credentials,target,'write',async(db,actor)=>{
        await lockTarget(db,target);
        const context=await documentContext(db,target),current=await latest(db,target.key);
        check((current?.version??0)===expectedVersion,'SETTINGS_VERSION_CONFLICT',409);
        const {valid,errors,normalized}=validated(target,changes,context);
        if(!valid)throw settingsFailure(errors[0]);
        const {next,diff}=await preview(db,target,current?.overrides??{},normalized,context);
        return {...await commit(db,target,actor,current,next,reason),diff};
      });
    },
    async rollback(credentials,targetInput,{toVersion,expectedVersion,reason}){
      const target=parseTarget(targetInput);expected(expectedVersion);reasonText(reason);
      check(Number.isSafeInteger(toVersion)&&toVersion>=1,'INVALID_VERSION');
      return authorized(credentials,target,'write',async(db,actor)=>{
        await lockTarget(db,target);
        const context=await documentContext(db,target),current=await latest(db,target.key);
        check((current?.version??0)===expectedVersion,'SETTINGS_VERSION_CONFLICT',409);
        const source=(await db.query("SELECT overrides FROM dge_settings.versions WHERE target=$1 AND version=$2",[target.key,toVersion])).rows[0];
        check(source&&toVersion<current.version,'SETTINGS_VERSION_NOT_FOUND',404);
        const delta=settingsDelta(current.overrides,source.overrides);
        check(Object.keys(delta).length>0,'NO_SETTINGS_CHANGE');
        const {valid,errors,normalized}=validated(target,delta,context);
        if(!valid)throw settingsFailure(errors[0]);
        const {next,diff}=await preview(db,target,current.overrides,normalized,context);
        return {...await commit(db,target,actor,current,next,reason,toVersion),diff};
      });
    },
    /** Newest first. `verified` reports whether every digest and link in the returned page recomputes. */
    async history(credentials,targetInput,{before=null,limit=50}={}){
      const target=parseTarget(targetInput);
      check((before===null||(Number.isSafeInteger(before)&&before>=1))&&Number.isSafeInteger(limit)&&limit>=1&&limit<=100,'INVALID_PAGE');
      return authorized(credentials,target,'manage',async(db)=>{
        const rows=(await db.query("SELECT * FROM dge_settings.versions WHERE target=$1 AND ($2::int IS NULL OR version<$2) ORDER BY version DESC LIMIT $3",[target.key,before,limit+1])).rows;
        const page=rows.slice(0,limit);
        const verified=page.every((row,index)=>row.digest===versionDigest(target.key,row)&&
          (index+1<rows.length?row.previous_digest===rows[index+1].digest&&row.version===rows[index+1].version+1:row.version===1&&row.previous_digest===null));
        return {items:page.map(historyItem),verified,nextBefore:rows.length>limit?page.at(-1).version:null};
      });
    },
  });
}
