import {randomUUID,randomBytes,createHmac} from "node:crypto";
import {digest} from "../src/integrity.mjs";
import {CLASS_PATTERN,DEFAULT_CLASS} from "../src/weighted-governance.mjs";
import {DocumentError} from "./document-store.mjs";

const UUID=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const uuid=value=>typeof value==="string"&&UUID.test(value);
const check=(condition,code,status=400)=>{if(!condition)throw new DocumentError(code,status);};
const managers=["owner","admin"];
const voters=["owner","admin","editor","participant"];
export const ROSTER_KINDS=["membership-derived","unit-register","verified-person-cohort"];
const UNITS=/^(0|[1-9][0-9]{0,77})$/;
const EVIDENCE=/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,199}$/;
const MAX_PROXY_DAYS=400;
const iso=value=>new Date(value).toISOString();
const timeOf=(value,code)=>{
  check(typeof value==="string"&&value.length<=40,code);
  const ms=Date.parse(value);
  check(Number.isSafeInteger(ms)&&ms>=0&&iso(ms)===value,code);
  return ms;
};
const plainObject=value=>value!==null&&typeof value==="object"&&!Array.isArray(value)&&
  [Object.prototype,null].includes(Object.getPrototypeOf(value));

/** Allocation is null (whole holding) or a class->positive-units map. */
export function normalizeAllocation(value){
  if(value===null||value===undefined)return null;
  check(plainObject(value),"INVALID_PROXY_ALLOCATION");
  const entries=Object.entries(value);
  check(entries.length>0&&entries.length<=64,"INVALID_PROXY_ALLOCATION");
  const result={};
  for(const [name,amount] of entries.sort(([a],[b])=>a<b?-1:a>b?1:0)){
    check(CLASS_PATTERN.test(name)&&typeof amount==="string"&&UNITS.test(amount)&&amount!=="0","INVALID_PROXY_ALLOCATION");
    result[name]=amount;
  }
  return result;
}
/** Sum of allocations per class; null means the whole holding. */
export function allocationFits(holding,allocations){
  const used={};
  for(const allocation of allocations){
    if(allocation===null){if(allocations.length!==1)return false;continue;}
    for(const [name,amount] of Object.entries(allocation)){
      if(!Object.hasOwn(holding,name))return false;
      used[name]=(used[name]??0n)+BigInt(amount);
      if(used[name]>BigInt(holding[name]))return false;
    }
  }
  return true;
}

/** Latest version of every (principal,class) recorded at or before `at`. */
async function latestEntries(db,tenantId,rosterIds,at){
  return (await db.query(
    `SELECT DISTINCT ON (roster_id,principal_id,class) roster_id,principal_id,class,version,units::text AS units,
       person_key_digest,valid_from,valid_to,evidence_ref,recorded_at
     FROM dge_electorates.roster_entries
     WHERE tenant_id=$1 AND roster_id IN (SELECT jsonb_array_elements_text($2::jsonb)::uuid) AND recorded_at<=$3
     ORDER BY roster_id,principal_id,class,version DESC`,
    [tenantId,JSON.stringify(rosterIds),at])).rows;
}
const effectiveAt=(row,at)=>row.units!=="0"&&new Date(row.valid_from)<=at&&(row.valid_to===null||new Date(row.valid_to)>at);

/** Current holdings (class->units) per principal, used by grants and section rights. */
export async function currentHoldings(db,tenantId,rosterIds,at){
  const holdings=new Map();
  for(const row of await latestEntries(db,tenantId,rosterIds,at)){
    if(!effectiveAt(row,at))continue;
    const key=row.roster_id+":"+row.principal_id;
    const value=holdings.get(key)??{};
    value[row.class]=row.units;
    holdings.set(key,value);
  }
  return holdings;
}

/**
 * Deterministic record-date snapshot. Only versions recorded at or before
 * the record date are considered, so the result is reproducible forever
 * from append-only rows. Duplicate person keys in a verified-person cohort
 * keep the earliest-recorded principal (ties by account ID) and exclude the
 * rest with a counted reason; no excluded identity is reported.
 */
function computeSnapshot(roster,rows,recordDate){
  const exclusions={};
  const exclude=(reason,n=1)=>{exclusions[reason]=(exclusions[reason]??0)+n;};
  const included=[];
  for(const row of rows){
    if(row.units==="0")exclude("zero-units");
    else if(new Date(row.valid_from)>recordDate)exclude("not-yet-eligible");
    else if(row.valid_to!==null&&new Date(row.valid_to)<=recordDate)exclude("eligibility-expired");
    else if(roster.kind==="verified-person-cohort"&&!row.person_key_digest)exclude("missing-person-key");
    else included.push(row);
  }
  let kept=included;
  if(roster.kind==="verified-person-cohort"){
    const firstSeen=new Map();
    for(const row of included){
      const at=new Date(row.recorded_at).getTime();
      const prior=firstSeen.get(row.principal_id);
      if(prior===undefined||at<prior)firstSeen.set(row.principal_id,at);
    }
    const winner=new Map();
    for(const row of included){
      const current=winner.get(row.person_key_digest);
      const better=current===undefined||firstSeen.get(row.principal_id)<firstSeen.get(current)||
        (firstSeen.get(row.principal_id)===firstSeen.get(current)&&row.principal_id<current);
      if(better)winner.set(row.person_key_digest,row.principal_id);
    }
    const losers=new Set(included.filter(r=>winner.get(r.person_key_digest)!==r.principal_id).map(r=>r.principal_id));
    kept=included.filter(r=>!losers.has(r.principal_id));
    if(included.length!==kept.length)exclude("duplicate-person-key",included.length-kept.length);
  }
  const members=new Map(),classTotals={};
  let totalUnits=0n;
  for(const row of kept){
    const classes=members.get(row.principal_id)??{};
    classes[row.class]=row.units;members.set(row.principal_id,classes);
    classTotals[row.class]=((BigInt(classTotals[row.class]??"0"))+BigInt(row.units)).toString();
    totalUnits+=BigInt(row.units);
  }
  const sortedMembers=[...members.keys()].sort().map(principalId=>({principalId,
    classes:Object.fromEntries(Object.entries(members.get(principalId)).sort(([a],[b])=>a<b?-1:1))}));
  const sortedTotals=Object.fromEntries(Object.entries(classTotals).sort(([a],[b])=>a<b?-1:1));
  const summary={
    entriesConsidered:rows.length,entriesIncluded:kept.length,
    exclusions:Object.fromEntries(Object.entries(exclusions).sort(([a],[b])=>a<b?-1:1)),
    principals:sortedMembers.length,classTotals:sortedTotals,totalUnits:totalUnits.toString(),
  };
  return {members:sortedMembers,summary};
}
const snapshotDigestOf=(tenantId,roster,recordDate,members,summary)=>digest("electorate-roster-snapshot-v1",{
  tenantId,rosterId:roster.id,rosterKind:roster.kind,recordDate:iso(recordDate),members,summary});

/**
 * Freeze (or reuse) the snapshot of a roster at an explicit record date.
 * Concurrent callers converge on one row: the unique (roster, record date)
 * key plus a deterministic computation give every caller the same digest.
 */
export async function freezeRosterSnapshot(db,{tenantId,rosterId,recordDate,actorId,at}){
  check(recordDate.getTime()<at.getTime(),"RECORD_DATE_NOT_PAST",409);
  await db.query("SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))",[rosterLockKey(tenantId,rosterId)]);
  const roster=(await db.query("SELECT id,kind FROM dge_electorates.rosters WHERE tenant_id=$1 AND id=$2",[tenantId,rosterId])).rows[0];
  check(roster,"ROSTER_NOT_FOUND",404);
  const existing=async()=>(await db.query("SELECT * FROM dge_electorates.snapshots WHERE tenant_id=$1 AND roster_id=$2 AND record_date=$3",[tenantId,rosterId,recordDate])).rows[0];
  let row=await existing();
  if(!row){
    const {members,summary}=computeSnapshot(roster,await latestEntries(db,tenantId,[rosterId],recordDate),recordDate);
    await db.query(
      "INSERT INTO dge_electorates.snapshots(tenant_id,id,roster_id,record_date,members,summary,snapshot_digest,created_by,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (tenant_id,roster_id,record_date) DO NOTHING",
      [tenantId,randomUUID(),rosterId,recordDate,JSON.stringify(members),summary,snapshotDigestOf(tenantId,roster,recordDate,members,summary),actorId,at]);
    row=await existing();
  }
  check(snapshotDigestOf(tenantId,roster,recordDate,row.members,row.summary)===row.snapshot_digest,"SNAPSHOT_INTEGRITY_ERROR",503);
  return {id:row.id,rosterId,rosterKind:roster.kind,recordDate,members:row.members,summary:row.summary,snapshotDigest:row.snapshot_digest};
}
const rosterLockKey=(tenantId,rosterId)=>"roster:"+tenantId+":"+rosterId;
const publicSnapshot=s=>({id:s.id,rosterId:s.rosterId,rosterKind:s.rosterKind,recordDate:iso(s.recordDate),
  snapshotDigest:s.snapshotDigest,...s.summary});

async function recordEvent(db,{tenantId,actorId,kind,commandId,requestDigest,result,at}){
  const id=randomUUID();
  const eventDigest=digest("electorate-event-v1",{id,tenantId,kind,commandId,requestDigest,result,at:iso(at)});
  await db.query("INSERT INTO dge_electorates.events(tenant_id,id,actor_id,kind,command_id,request_digest,result,event_digest,occurred_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
    [tenantId,id,actorId,kind,commandId,requestDigest,result,eventDigest,at]);
}
async function replay(db,tenantId,actorId,commandId,requestDigest){
  const prior=(await db.query("SELECT request_digest,result FROM dge_electorates.events WHERE tenant_id=$1 AND actor_id=$2 AND command_id=$3",
    [tenantId,actorId,commandId])).rows[0];
  if(!prior)return undefined;
  check(prior.request_digest===requestDigest,"COMMAND_REUSED",409);
  return prior.result;
}

/** Electorate rosters, record-date snapshots and proxy powers. */
export function createElectorateStore({identity,clock=Date.now,personKeySecret,maxRosters=100,
  maxRosterEntries=100000,maxEntryVersions=1000,maxActiveGrants=20}={}){
  check(identity&&typeof identity.withTenant==="function"&&typeof clock==="function","ELECTORATE_STORE_CONFIG");
  for(const n of [maxRosters,maxRosterEntries,maxEntryVersions,maxActiveGrants])
    check(Number.isSafeInteger(n)&&n>0&&n<=1000000,"ELECTORATE_STORE_CONFIG");
  check(maxEntryVersions<=1000,"ELECTORATE_STORE_CONFIG");
  check(personKeySecret===undefined||(Buffer.isBuffer(personKeySecret)&&personKeySecret.length>=32),"ELECTORATE_STORE_CONFIG");
  const now=()=>{const ms=clock();check(Number.isSafeInteger(ms)&&ms>=0,"CLOCK_UNAVAILABLE",503);return new Date(ms);};
  const scoped=(credentials,tenantId,options,fn)=>{check(uuid(tenantId),"INVALID_WORKSPACE");return identity.withTenant(credentials,tenantId,options,fn);};
  async function roster(db,tenantId,rosterId,exclusive=false){
    check(uuid(rosterId),"INVALID_ROSTER_ID");
    if(exclusive)await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[rosterLockKey(tenantId,rosterId)]);
    const row=(await db.query("SELECT * FROM dge_electorates.rosters WHERE tenant_id=$1 AND id=$2",[tenantId,rosterId])).rows[0];
    check(row,"ROSTER_NOT_FOUND",404);
    return row;
  }
  const personKeyDigest=(tenantId,salt,raw)=>{
    check(personKeySecret,"PERSON_KEY_UNAVAILABLE",503);
    check(typeof raw==="string"&&raw.length>=8&&raw.length<=512&&!/[\u0000-\u001f]/.test(raw),"INVALID_PERSON_KEY");
    return createHmac("sha256",personKeySecret).update("dge-person-key-v1\0"+tenantId+"\0"+salt+"\0"+raw).digest("hex");
  };
  const entryView=(row,{manager})=>({principalId:row.principal_id,class:row.class,version:row.version,units:row.units,
    validFrom:iso(row.valid_from),validTo:row.valid_to===null?null:iso(row.valid_to),
    personKeyRecorded:row.person_key_digest!==null,recordedAt:iso(row.recorded_at),
    ...(manager?{evidenceRef:row.evidence_ref}:{})});
  async function activeGrants(db,tenantId,grantorId,at,{rosterId=null,decisionId=null}){
    return (await db.query(
      `SELECT id,allocation FROM dge_electorates.proxy_grants WHERE tenant_id=$1 AND grantor_id=$2 AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at>$3) AND (roster_id=$4::uuid OR decision_id=$5::uuid)`,
      [tenantId,grantorId,at,rosterId,decisionId])).rows;
  }
  return Object.freeze({
    async createRoster(credentials,tenantId,{kind,name,commandId}){
      check(uuid(commandId)&&ROSTER_KINDS.includes(kind)&&typeof name==="string"&&name.trim()===name&&
        name.length>=1&&name.length<=200&&!/[\u0000-\u001f]/.test(name),"INVALID_ROSTER");
      return scoped(credentials,tenantId,{write:true,recent:true,roles:managers},async(db,actor)=>{
        const requestDigest=digest("roster-create-command-v1",{tenantId,kind,name});
        const prior=await replay(db,tenantId,actor.accountId,commandId,requestDigest);
        if(prior)return prior;
        const count=(await db.query("SELECT count(*)::int AS n FROM dge_electorates.rosters WHERE tenant_id=$1",[tenantId])).rows[0].n;
        check(count<maxRosters,"ROSTER_LIMIT_REACHED",429);
        const at=now(),id=randomUUID();
        await db.query("INSERT INTO dge_electorates.rosters(tenant_id,id,kind,name,person_key_salt,created_by,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)",
          [tenantId,id,kind,name,randomBytes(32).toString("hex"),actor.accountId,at]);
        const result={id,kind,name,createdAt:iso(at)};
        await recordEvent(db,{tenantId,actorId:actor.accountId,kind:"roster-created",commandId,requestDigest,result,at});
        return result;
      });
    },
    async listRosters(credentials,tenantId){
      return scoped(credentials,tenantId,{},async db=>({items:(await db.query(
        "SELECT id,kind,name,created_at FROM dge_electorates.rosters WHERE tenant_id=$1 ORDER BY created_at,id",[tenantId])).rows
        .map(r=>({id:r.id,kind:r.kind,name:r.name,createdAt:iso(r.created_at)}))}));
    },
    /** Managers see current entries; other members see only their own. */
    async readRoster(credentials,tenantId,rosterId){
      return scoped(credentials,tenantId,{},async(db,actor)=>{
        const row=await roster(db,tenantId,rosterId);
        const manager=managers.includes(actor.role);
        const entries=(await latestEntries(db,tenantId,[rosterId],now()))
          .filter(e=>manager||e.principal_id===actor.accountId).map(e=>entryView(e,{manager}));
        const snapshots=(await db.query("SELECT id,record_date,snapshot_digest FROM dge_electorates.snapshots WHERE tenant_id=$1 AND roster_id=$2 ORDER BY record_date DESC LIMIT 50",[tenantId,rosterId])).rows
          .map(s=>({id:s.id,recordDate:iso(s.record_date),snapshotDigest:s.snapshot_digest}));
        return {id:row.id,kind:row.kind,name:row.name,createdAt:iso(row.created_at),entries,snapshots,
          scope:manager?"all-entries":"own-entries"};
      });
    },
    async recordEntry(credentials,tenantId,rosterId,{principalId,units,class:votingClass=DEFAULT_CLASS,personKey,
      validFrom,validTo=null,evidenceRef=null,expectedVersion,commandId}){
      check(uuid(commandId)&&uuid(principalId)&&typeof units==="string"&&UNITS.test(units)&&
        typeof votingClass==="string"&&CLASS_PATTERN.test(votingClass)&&
        Number.isSafeInteger(expectedVersion)&&expectedVersion>=0&&expectedVersion<maxEntryVersions&&
        (evidenceRef===null||(typeof evidenceRef==="string"&&EVIDENCE.test(evidenceRef))),"INVALID_ROSTER_ENTRY");
      const from=timeOf(validFrom,"INVALID_ROSTER_ENTRY"),to=validTo===null?null:timeOf(validTo,"INVALID_ROSTER_ENTRY");
      check(to===null||to>from,"INVALID_ROSTER_ENTRY");
      return scoped(credentials,tenantId,{write:true,recent:true,roles:managers},async(db,actor)=>{
        // The exclusive roster lock is taken before the clock is read: a
        // concurrent snapshot either sees this entry or precedes its time.
        const row=await roster(db,tenantId,rosterId,true);
        check(row.kind!=="membership-derived","ROSTER_IS_MEMBERSHIP_DERIVED",409);
        let keyDigest=null;
        if(row.kind==="verified-person-cohort"){
          check(units==="0"||units==="1","COHORT_UNITS_MUST_BE_ONE");
          keyDigest=personKeyDigest(tenantId,row.person_key_salt,personKey);
        }else if(personKey!==undefined&&personKey!==null)keyDigest=personKeyDigest(tenantId,row.person_key_salt,personKey);
        // The raw key never enters the idempotency digest or any stored row.
        const requestDigest=digest("roster-entry-command-v1",{tenantId,rosterId,principalId,units,class:votingClass,
          personKeyDigest:keyDigest,validFrom,validTo,evidenceRef,expectedVersion});
        const prior=await replay(db,tenantId,actor.accountId,commandId,requestDigest);
        if(prior)return prior;
        check((await db.query("SELECT 1 FROM dge_identity.memberships WHERE tenant_id=$1 AND account_id=$2 AND active=true",[tenantId,principalId])).rows.length,
          "PRINCIPAL_NOT_IN_WORKSPACE",409);
        const current=(await db.query("SELECT max(version)::int AS v FROM dge_electorates.roster_entries WHERE tenant_id=$1 AND roster_id=$2 AND principal_id=$3 AND class=$4",
          [tenantId,rosterId,principalId,votingClass])).rows[0].v??0;
        check(current===expectedVersion,"ROSTER_ENTRY_VERSION_CONFLICT",409);
        if(current===0){
          const keys=(await db.query("SELECT count(*)::int AS n FROM (SELECT DISTINCT principal_id,class FROM dge_electorates.roster_entries WHERE tenant_id=$1 AND roster_id=$2) k",[tenantId,rosterId])).rows[0].n;
          check(keys<maxRosterEntries,"ROSTER_LIMIT_REACHED",429);
        }
        const at=now();
        await db.query("INSERT INTO dge_electorates.roster_entries(tenant_id,roster_id,principal_id,class,version,units,person_key_digest,valid_from,valid_to,evidence_ref,recorded_by,recorded_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",
          [tenantId,rosterId,principalId,votingClass,current+1,units,keyDigest,new Date(from),to===null?null:new Date(to),evidenceRef,actor.accountId,at]);
        const result={rosterId,principalId,class:votingClass,version:current+1,units,validFrom,validTo,recordedAt:iso(at)};
        await recordEvent(db,{tenantId,actorId:actor.accountId,kind:"entry-recorded",commandId,requestDigest,result,at});
        return result;
      });
    },
    /** Mirror active voting memberships into a membership-derived roster. */
    async syncMembership(credentials,tenantId,rosterId,{commandId}){
      check(uuid(commandId),"INVALID_ROSTER_COMMAND");
      return scoped(credentials,tenantId,{write:true,recent:true,roles:managers},async(db,actor)=>{
        const row=await roster(db,tenantId,rosterId,true);
        check(row.kind==="membership-derived","ROSTER_NOT_MEMBERSHIP_DERIVED",409);
        const requestDigest=digest("roster-sync-command-v1",{tenantId,rosterId});
        const prior=await replay(db,tenantId,actor.accountId,commandId,requestDigest);
        if(prior)return prior;
        const at=now();
        const active=new Set((await db.query("SELECT account_id FROM dge_identity.memberships WHERE tenant_id=$1 AND active=true AND role IN ('owner','admin','editor','participant')",[tenantId])).rows.map(r=>r.account_id));
        const latest=new Map((await latestEntries(db,tenantId,[rosterId],at)).filter(r=>r.class===DEFAULT_CLASS).map(r=>[r.principal_id,r]));
        check(active.size<=maxRosterEntries,"ROSTER_LIMIT_REACHED",429);
        let added=0,removed=0;
        const write=(principalId,version,unitsValue)=>db.query("INSERT INTO dge_electorates.roster_entries(tenant_id,roster_id,principal_id,class,version,units,valid_from,recorded_by,recorded_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
          [tenantId,rosterId,principalId,DEFAULT_CLASS,version,unitsValue,at,actor.accountId,at]);
        for(const principalId of [...active].sort()){
          const entry=latest.get(principalId);
          if(entry&&effectiveAt(entry,at))continue;
          check((entry?.version??0)<maxEntryVersions,"ROSTER_LIMIT_REACHED",429);
          await write(principalId,(entry?.version??0)+1,"1");added++;
        }
        for(const [principalId,entry] of [...latest].sort(([a],[b])=>a<b?-1:1)){
          if(active.has(principalId)||!effectiveAt(entry,at))continue;
          check(entry.version<maxEntryVersions,"ROSTER_LIMIT_REACHED",429);
          await write(principalId,entry.version+1,"0");removed++;
        }
        const result={rosterId,added,removed,syncedAt:iso(at)};
        await recordEvent(db,{tenantId,actorId:actor.accountId,kind:"membership-synced",commandId,requestDigest,result,at});
        return result;
      });
    },
    async createSnapshot(credentials,tenantId,rosterId,{recordDate,commandId}){
      check(uuid(commandId)&&uuid(rosterId),"INVALID_SNAPSHOT");
      const date=new Date(timeOf(recordDate,"INVALID_RECORD_DATE"));
      return scoped(credentials,tenantId,{write:true,roles:managers},async(db,actor)=>{
        const requestDigest=digest("roster-snapshot-command-v1",{tenantId,rosterId,recordDate});
        const prior=await replay(db,tenantId,actor.accountId,commandId,requestDigest);
        if(prior)return prior;
        const at=now();
        const result=publicSnapshot(await freezeRosterSnapshot(db,{tenantId,rosterId,recordDate:date,actorId:actor.accountId,at}));
        await recordEvent(db,{tenantId,actorId:actor.accountId,kind:"snapshot-created",commandId,requestDigest,result,at});
        return result;
      });
    },
    /** Aggregate counts and digest only: no principal, key or evidence. */
    async readSnapshot(credentials,tenantId,rosterId,snapshotId){
      check(uuid(snapshotId),"INVALID_SNAPSHOT");
      return scoped(credentials,tenantId,{},async db=>{
        const r=await roster(db,tenantId,rosterId);
        const row=(await db.query("SELECT * FROM dge_electorates.snapshots WHERE tenant_id=$1 AND roster_id=$2 AND id=$3",[tenantId,rosterId,snapshotId])).rows[0];
        check(row,"SNAPSHOT_NOT_FOUND",404);
        check(snapshotDigestOf(tenantId,r,new Date(row.record_date),row.members,row.summary)===row.snapshot_digest,"SNAPSHOT_INTEGRITY_ERROR",503);
        return publicSnapshot({id:row.id,rosterId,rosterKind:r.kind,recordDate:row.record_date,snapshotDigest:row.snapshot_digest,summary:row.summary});
      });
    },
    /**
     * The authenticated principal grants its own voting power to another
     * member for a roster or one decision. Grants are not transitive: a
     * proxy can only ever vote the grantor's own units.
     */
    async grantProxy(credentials,tenantId,{granteeId,rosterId=null,decisionId=null,allocation=null,expiresAt=null,commandId}){
      check(uuid(commandId)&&uuid(granteeId)&&((rosterId===null)!==(decisionId===null))&&
        (rosterId===null||uuid(rosterId))&&(decisionId===null||uuid(decisionId)),"INVALID_PROXY_GRANT");
      const fixed=normalizeAllocation(allocation);
      const expires=expiresAt===null?null:timeOf(expiresAt,"INVALID_PROXY_GRANT");
      return scoped(credentials,tenantId,{write:true,recent:true,roles:voters},async(db,actor)=>{
        check(granteeId!==actor.accountId,"PROXY_SELF_GRANT",409);
        const requestDigest=digest("proxy-grant-command-v1",{tenantId,granteeId,rosterId,decisionId,allocation:fixed,expiresAt});
        const prior=await replay(db,tenantId,actor.accountId,commandId,requestDigest);
        if(prior)return prior;
        const at=now();
        check(expires===null||(expires>at.getTime()&&expires<=at.getTime()+MAX_PROXY_DAYS*86400000),"INVALID_PROXY_EXPIRY");
        check((await db.query("SELECT 1 FROM dge_identity.memberships WHERE tenant_id=$1 AND account_id=$2 AND active=true AND role IN ('owner','admin','editor','participant')",[tenantId,granteeId])).rows.length,
          "PROXY_GRANTEE_NOT_ELIGIBLE",409);
        // Serialize all grant changes of one grantor before reading totals.
        await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",["proxy-grants:"+tenantId+":"+actor.accountId]);
        let holding;
        if(rosterId){
          await roster(db,tenantId,rosterId);
          holding=(await currentHoldings(db,tenantId,[rosterId],at)).get(rosterId+":"+actor.accountId);
        }else{
          const decision=(await db.query("SELECT state,snapshot FROM dge_decisions.decisions WHERE tenant_id=$1 AND id=$2",[tenantId,decisionId])).rows[0];
          check(decision,"DECISION_NOT_FOUND",404);
          check(decision.state==="open"&&decision.snapshot.schemaVersion===2,"PROXY_DECISION_NOT_OPEN",409);
          holding=decision.snapshot.electorate.members.find(m=>m.principalId===actor.accountId)?.classes;
        }
        check(holding,"GRANTOR_HAS_NO_VOTING_UNITS",409);
        const reciprocal=(await db.query(
          "SELECT 1 FROM dge_electorates.proxy_grants WHERE tenant_id=$1 AND grantor_id=$2 AND grantee_id=$3 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>$4)",
          [tenantId,granteeId,actor.accountId,at])).rows.length;
        check(!reciprocal,"PROXY_CYCLE",409);
        const existing=await activeGrants(db,tenantId,actor.accountId,at,{rosterId,decisionId});
        check(existing.length<maxActiveGrants,"PROXY_LIMIT_REACHED",429);
        check(allocationFits(holding,[...existing.map(g=>g.allocation),fixed]),"PROXY_OVER_ALLOCATION",409);
        const id=randomUUID();
        await db.query("INSERT INTO dge_electorates.proxy_grants(tenant_id,id,grantor_id,grantee_id,roster_id,decision_id,allocation,expires_at,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
          [tenantId,id,actor.accountId,granteeId,rosterId,decisionId,fixed,expires===null?null:new Date(expires),at]);
        const result={id,granteeId,rosterId,decisionId,allocation:fixed,expiresAt,createdAt:iso(at)};
        await recordEvent(db,{tenantId,actorId:actor.accountId,kind:"proxy-granted",commandId,requestDigest,result,at});
        return result;
      });
    },
    async revokeProxy(credentials,tenantId,grantId,{commandId}){
      check(uuid(grantId)&&uuid(commandId),"INVALID_PROXY_REVOCATION");
      return scoped(credentials,tenantId,{write:true,roles:["owner","admin","editor","participant","viewer"]},async(db,actor)=>{
        const requestDigest=digest("proxy-revoke-command-v1",{tenantId,grantId});
        const prior=await replay(db,tenantId,actor.accountId,commandId,requestDigest);
        if(prior)return prior;
        const grant=(await db.query("SELECT grantor_id,revoked_at FROM dge_electorates.proxy_grants WHERE tenant_id=$1 AND id=$2 FOR UPDATE",[tenantId,grantId])).rows[0];
        check(grant,"PROXY_GRANT_NOT_FOUND",404);
        check(grant.grantor_id===actor.accountId||managers.includes(actor.role),"ACCESS_DENIED",403);
        check(grant.revoked_at===null,"PROXY_ALREADY_REVOKED",409);
        const at=now();
        await db.query("UPDATE dge_electorates.proxy_grants SET revoked_at=$3,revoked_by=$4 WHERE tenant_id=$1 AND id=$2",[tenantId,grantId,at,actor.accountId]);
        const result={id:grantId,revokedAt:iso(at)};
        await recordEvent(db,{tenantId,actorId:actor.accountId,kind:"proxy-revoked",commandId,requestDigest,result,at});
        return result;
      });
    },
    /** Grants the caller gave or received; nobody else's. */
    async listProxies(credentials,tenantId){
      return scoped(credentials,tenantId,{},async(db,actor)=>{
        const at=now();
        const rows=(await db.query("SELECT * FROM dge_electorates.proxy_grants WHERE tenant_id=$1 AND (grantor_id=$2 OR grantee_id=$2) ORDER BY created_at DESC,id LIMIT 200",[tenantId,actor.accountId])).rows;
        const view=g=>({id:g.id,grantorId:g.grantor_id,granteeId:g.grantee_id,rosterId:g.roster_id,decisionId:g.decision_id,
          allocation:g.allocation,expiresAt:g.expires_at===null?null:iso(g.expires_at),createdAt:iso(g.created_at),
          revokedAt:g.revoked_at===null?null:iso(g.revoked_at),
          active:g.revoked_at===null&&(g.expires_at===null||new Date(g.expires_at)>at)});
        return {given:rows.filter(g=>g.grantor_id===actor.accountId).map(view),
          received:rows.filter(g=>g.grantee_id===actor.accountId).map(view)};
      });
    },
  });
}
