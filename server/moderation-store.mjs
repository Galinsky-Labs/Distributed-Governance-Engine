import {randomUUID} from "node:crypto";
import {digest} from "../src/integrity.mjs";
import {DocumentError} from "./document-store.mjs";
import {appendLedgerEvent} from "./ledger.mjs";

const UUID=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const uuid=value=>typeof value==="string"&&UUID.test(value);
const check=(condition,code,status=400)=>{if(!condition)throw new DocumentError(code,status);};
const managers=["owner","admin"];
const members=["owner","admin","editor","participant","viewer"];
export const REPORT_CATEGORIES=Object.freeze(["spam","harassment","off-topic","private-information","illegal-content","impersonation","other"]);
export const RESTORE_CATEGORIES=Object.freeze(["review-reversed","appeal-granted"]);
export const REMOVED_PLACEHOLDER="Removed by moderator";
const TARGETS=["proposal","point"];
const iso=value=>new Date(value).toISOString();
const text=(value,max)=>typeof value==="string"&&value.trim().length>=1&&value.length<=max&&
  !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value);

/** Public projection of a hidden item: placeholder plus its reason category. */
export function removedView(reasonCategory,replace){
  return {...replace(REMOVED_PLACEHOLDER),
    moderation:{state:"removed",placeholder:REMOVED_PLACEHOLDER,reasonCategory}};
}

/**
 * Reports, moderator actions and author appeals (DCE-017). Moderation only
 * changes public visibility; it never deletes content and never touches
 * ballots, decisions or point scores. The coordinated-flagging signal is
 * advisory and never acts on its own.
 */
export function createModerationStore({identity,transaction,clock=Date.now,maxReportsPerHour=10,maxReportsPerDay=50,
  flagWindowMs=3600000,newAccountMs=7*86400000,coordinatedThreshold=3}={}){
  check(identity&&typeof identity.withTenant==="function"&&typeof clock==="function","MODERATION_STORE_CONFIG");
  for(const n of [maxReportsPerHour,maxReportsPerDay,flagWindowMs,newAccountMs,coordinatedThreshold])
    check(Number.isSafeInteger(n)&&n>0&&n<=100*86400000,"MODERATION_STORE_CONFIG");
  check(maxReportsPerHour<=maxReportsPerDay,"MODERATION_STORE_CONFIG");
  const now=()=>{const ms=clock();check(Number.isSafeInteger(ms)&&ms>=0,"CLOCK_UNAVAILABLE",503);return new Date(ms);};
  const scoped=(credentials,tenantId,options,fn)=>{check(uuid(tenantId),"INVALID_WORKSPACE");return identity.withTenant(credentials,tenantId,options,fn);};
  async function target(db,tenantId,targetKind,targetId){
    check(TARGETS.includes(targetKind)&&uuid(targetId),"INVALID_MODERATION_TARGET");
    const row=targetKind==="proposal"?
      (await db.query("SELECT document_id,id AS proposal_id,actor_id FROM dge_proposals.proposals WHERE tenant_id=$1 AND id=$2",[tenantId,targetId])).rows[0]:
      (await db.query("SELECT document_id,proposal_id,actor_id FROM dge_discussion.points WHERE tenant_id=$1 AND id=$2",[tenantId,targetId])).rows[0];
    check(row,"MODERATION_TARGET_NOT_FOUND",404);
    return {documentId:row.document_id,proposalId:row.proposal_id,authorId:row.actor_id};
  }
  async function audit(db,{tenantId,kind,subjectId,actorId,at,value}){
    const id=randomUUID();
    await db.query("INSERT INTO dge_moderation.events(tenant_id,id,kind,subject_id,actor_id,event_digest,occurred_at) VALUES($1,$2,$3,$4,$5,$6,$7)",
      [tenantId,id,kind,subjectId,actorId,digest("moderation-audit-event-v1",{id,kind,subjectId,value,at:iso(at)}),at]);
  }
  /** Visibility change, append-only action record, audit and transparency log. */
  async function applyAction(db,{tenantId,targetKind,targetId,place,action,reasonCategory,actorId,commandId,requestDigest,appealId=null,expectedVersion,at}){
    const state=(await db.query("SELECT hidden,version FROM dge_moderation.visibility WHERE tenant_id=$1 AND target_kind=$2 AND target_id=$3 FOR UPDATE",
      [tenantId,targetKind,targetId])).rows[0];
    const version=state?.version??0;
    if(expectedVersion!==undefined)check(version===expectedVersion,"MODERATION_VERSION_CONFLICT",409);
    check(action==="hide"?!state?.hidden:Boolean(state?.hidden),action==="hide"?"ALREADY_HIDDEN":"NOT_HIDDEN",409);
    if(state)await db.query("UPDATE dge_moderation.visibility SET hidden=$4,reason_category=$5,version=version+1,updated_at=$6 WHERE tenant_id=$1 AND target_kind=$2 AND target_id=$3",
      [tenantId,targetKind,targetId,action==="hide",reasonCategory,at]);
    else await db.query("INSERT INTO dge_moderation.visibility(tenant_id,target_kind,target_id,document_id,proposal_id,hidden,reason_category,version,updated_at) VALUES($1,$2,$3,$4,$5,true,$6,1,$7)",
      [tenantId,targetKind,targetId,place.documentId,place.proposalId,reasonCategory,at]);
    const id=randomUUID();
    // The public event names the target, action and category, never the moderator.
    const eventDigest=digest("moderation-action-v1",{id,documentId:place.documentId,targetKind,targetId,action,reasonCategory,at:iso(at)});
    await db.query("INSERT INTO dge_moderation.actions(tenant_id,id,target_kind,target_id,document_id,proposal_id,action,reason_category,moderator_id,appeal_id,command_id,request_digest,event_digest,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)",
      [tenantId,id,targetKind,targetId,place.documentId,place.proposalId,action,reasonCategory,actorId,appealId,commandId,requestDigest,eventDigest,at]);
    await audit(db,{tenantId,kind:action==="hide"?"hidden":"restored",subjectId:id,actorId,at,value:{targetKind,targetId,reasonCategory}});
    await appendLedgerEvent(db,{tenantId,kind:"moderation-action",subjectId:targetId,eventDigest,at});
    // Public point listings key their cursors on the content epoch.
    await db.query("UPDATE dge_discussion.activity SET epoch=epoch+1,content_epoch=content_epoch+1 WHERE tenant_id=$1 AND document_id=$2 AND proposal_id=$3",
      [tenantId,place.documentId,place.proposalId]);
    return {actionId:id,targetKind,targetId,action,reasonCategory,version:version+1,createdAt:iso(at)};
  }
  async function priorAction(db,tenantId,actorId,commandId,requestDigest){
    const row=(await db.query("SELECT * FROM dge_moderation.actions WHERE tenant_id=$1 AND moderator_id=$2 AND command_id=$3",[tenantId,actorId,commandId])).rows[0];
    if(!row)return undefined;
    check(row.request_digest===requestDigest,"COMMAND_REUSED",409);
    const version=(await db.query("SELECT count(*)::int AS n FROM dge_moderation.actions WHERE tenant_id=$1 AND target_kind=$2 AND target_id=$3 AND created_at<=$4",
      [tenantId,row.target_kind,row.target_id,row.created_at])).rows[0].n;
    return {actionId:row.id,targetKind:row.target_kind,targetId:row.target_id,action:row.action,reasonCategory:row.reason_category,version,createdAt:iso(row.created_at)};
  }
  return Object.freeze({
    async report(credentials,tenantId,{targetKind,targetId,reasonCategory,note=null,commandId}){
      check(uuid(commandId)&&REPORT_CATEGORIES.includes(reasonCategory)&&(note===null||text(note,1000)),"INVALID_REPORT");
      return scoped(credentials,tenantId,{write:true,roles:members},async(db,actor)=>{
        const requestDigest=digest("moderation-report-command-v1",{targetKind,targetId,reasonCategory,note});
        const prior=(await db.query("SELECT * FROM dge_moderation.reports WHERE tenant_id=$1 AND reporter_id=$2 AND command_id=$3",[tenantId,actor.accountId,commandId])).rows[0];
        if(prior){
          check(prior.request_digest===requestDigest,"COMMAND_REUSED",409);
          return {id:prior.id,targetKind:prior.target_kind,targetId:prior.target_id,reasonCategory:prior.reason_category,createdAt:iso(prior.created_at)};
        }
        // Serialize one reporter's budget check and insert.
        await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",["moderation-report:"+tenantId+":"+actor.accountId]);
        const at=now();
        const used=(await db.query("SELECT count(*) FILTER (WHERE created_at>$3)::int AS hour,count(*)::int AS day FROM dge_moderation.reports WHERE tenant_id=$1 AND reporter_id=$2 AND created_at>$4",
          [tenantId,actor.accountId,new Date(at.getTime()-3600000),new Date(at.getTime()-86400000)])).rows[0];
        check(used.hour<maxReportsPerHour&&used.day<maxReportsPerDay,"REPORT_RATE_LIMITED",429);
        const place=await target(db,tenantId,targetKind,targetId);
        check(!(await db.query("SELECT 1 FROM dge_moderation.reports WHERE tenant_id=$1 AND reporter_id=$2 AND target_kind=$3 AND target_id=$4",
          [tenantId,actor.accountId,targetKind,targetId])).rows.length,"ALREADY_REPORTED",409);
        const id=randomUUID();
        await db.query("INSERT INTO dge_moderation.reports(tenant_id,id,target_kind,target_id,document_id,proposal_id,reporter_id,reason_category,note,created_at,command_id,request_digest) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",
          [tenantId,id,targetKind,targetId,place.documentId,place.proposalId,actor.accountId,reasonCategory,note,at,commandId,requestDigest]);
        await audit(db,{tenantId,kind:"reported",subjectId:id,actorId:actor.accountId,at,value:{targetKind,targetId,reasonCategory}});
        return {id,targetKind,targetId,reasonCategory,createdAt:iso(at)};
      });
    },
    /**
     * Moderator queue. Reporter identities are never listed. The
     * coordinated-flagging signal counts reports inside the window that
     * ends at the latest report, made by accounts that joined the workspace
     * shortly before reporting.
     */
    async queue(credentials,tenantId){
      return scoped(credentials,tenantId,{roles:managers},async db=>{
        const reports=(await db.query(
          `SELECT r.target_kind,r.target_id,r.document_id,r.proposal_id,r.reason_category,r.note,r.created_at,
             COALESCE((SELECT min(e.occurred_at) FROM dge_identity.events e WHERE e.tenant_id=r.tenant_id
               AND e.subject_id=r.reporter_id AND e.kind IN ('joined','tenant-created')),
               (SELECT m.updated_at FROM dge_identity.memberships m WHERE m.tenant_id=r.tenant_id AND m.account_id=r.reporter_id)) AS joined_at
           FROM dge_moderation.reports r WHERE r.tenant_id=$1 ORDER BY r.created_at,r.id LIMIT 5000`,[tenantId])).rows;
        const actions=(await db.query(
          "SELECT DISTINCT ON (target_kind,target_id) target_kind,target_id,id,action,reason_category,created_at FROM dge_moderation.actions WHERE tenant_id=$1 ORDER BY target_kind,target_id,created_at DESC,id",
          [tenantId])).rows;
        const lastAction=new Map(actions.map(a=>[a.target_kind+":"+a.target_id,a]));
        const groups=new Map();
        for(const r of reports){
          const key=r.target_kind+":"+r.target_id;
          if(!groups.has(key))groups.set(key,{targetKind:r.target_kind,targetId:r.target_id,documentId:r.document_id,proposalId:r.proposal_id,reports:[]});
          groups.get(key).reports.push(r);
        }
        const items=[...groups.entries()].map(([key,g])=>{
          const last=lastAction.get(key);
          const open=g.reports.filter(r=>!last||new Date(r.created_at)>new Date(last.created_at));
          const latest=new Date(g.reports.at(-1).created_at).getTime();
          const inWindow=g.reports.filter(r=>new Date(r.created_at).getTime()>latest-flagWindowMs);
          const recentAccounts=inWindow.filter(r=>r.joined_at&&new Date(r.created_at).getTime()-new Date(r.joined_at).getTime()<=newAccountMs).length;
          const categories={};
          for(const r of g.reports)categories[r.reason_category]=(categories[r.reason_category]??0)+1;
          return {targetKind:g.targetKind,targetId:g.targetId,documentId:g.documentId,proposalId:g.proposalId,
            totalReports:g.reports.length,openReports:open.length,categories,latestReportAt:iso(latest),
            hidden:last?.action==="hide",lastAction:last?{id:last.id,action:last.action,reasonCategory:last.reason_category,createdAt:iso(last.created_at)}:null,
            notes:open.filter(r=>r.note!==null).map(r=>({reasonCategory:r.reason_category,note:r.note,createdAt:iso(r.created_at)})),
            coordinatedFlagging:{flagged:recentAccounts>=coordinatedThreshold&&recentAccounts*2>=inWindow.length,
              recentAccountReports:recentAccounts,reportsInWindow:inWindow.length,
              windowMinutes:flagWindowMs/60000,newAccountDays:newAccountMs/86400000,automaticAction:false}};
        }).sort((a,b)=>b.openReports-a.openReports||(a.latestReportAt<b.latestReportAt?1:-1));
        const appeals=(await db.query(
          `SELECT ap.id,ap.statement,ap.created_at,a.id AS action_id,a.target_kind,a.target_id,a.reason_category
           FROM dge_moderation.appeals ap JOIN dge_moderation.actions a ON a.tenant_id=ap.tenant_id AND a.id=ap.action_id
           WHERE ap.tenant_id=$1 AND ap.status='pending' ORDER BY ap.created_at,ap.id`,[tenantId])).rows
          .map(a=>({id:a.id,actionId:a.action_id,targetKind:a.target_kind,targetId:a.target_id,reasonCategory:a.reason_category,
            statement:a.statement,createdAt:iso(a.created_at)}));
        return {items,appeals};
      });
    },
    async act(credentials,tenantId,{targetKind,targetId,action,reasonCategory,expectedVersion,commandId}){
      check(uuid(commandId)&&["hide","restore"].includes(action)&&Number.isSafeInteger(expectedVersion)&&expectedVersion>=0&&
        (action==="hide"?REPORT_CATEGORIES.includes(reasonCategory):reasonCategory==="review-reversed"),"INVALID_MODERATION_ACTION");
      return scoped(credentials,tenantId,{write:true,recent:true,roles:managers},async(db,actor)=>{
        const requestDigest=digest("moderation-action-command-v1",{targetKind,targetId,action,reasonCategory,expectedVersion});
        const prior=await priorAction(db,tenantId,actor.accountId,commandId,requestDigest);
        if(prior)return prior;
        const place=await target(db,tenantId,targetKind,targetId);
        return applyAction(db,{tenantId,targetKind,targetId,place,action,reasonCategory,actorId:actor.accountId,commandId,requestDigest,expectedVersion,at:now()});
      });
    },
    /** The author of hidden content may appeal the latest hide action once. */
    async appeal(credentials,tenantId,{actionId,statement,commandId}){
      check(uuid(actionId)&&uuid(commandId)&&text(statement,2000),"INVALID_APPEAL");
      return scoped(credentials,tenantId,{write:true,roles:members},async(db,actor)=>{
        const requestDigest=digest("moderation-appeal-command-v1",{actionId,statement});
        const prior=(await db.query("SELECT * FROM dge_moderation.appeals WHERE tenant_id=$1 AND appellant_id=$2 AND command_id=$3",[tenantId,actor.accountId,commandId])).rows[0];
        if(prior){
          check(prior.request_digest===requestDigest,"COMMAND_REUSED",409);
          return {id:prior.id,actionId:prior.action_id,status:prior.status,createdAt:iso(prior.created_at)};
        }
        const action=(await db.query("SELECT * FROM dge_moderation.actions WHERE tenant_id=$1 AND id=$2",[tenantId,actionId])).rows[0];
        check(action&&action.action==="hide","MODERATION_ACTION_NOT_FOUND",404);
        const place=await target(db,tenantId,action.target_kind,action.target_id);
        check(place.authorId===actor.accountId,"ONLY_AUTHOR_MAY_APPEAL",403);
        const latest=(await db.query("SELECT id FROM dge_moderation.actions WHERE tenant_id=$1 AND target_kind=$2 AND target_id=$3 ORDER BY created_at DESC,id LIMIT 1",
          [tenantId,action.target_kind,action.target_id])).rows[0];
        check(latest.id===actionId,"ACTION_SUPERSEDED",409);
        check(!(await db.query("SELECT 1 FROM dge_moderation.appeals WHERE tenant_id=$1 AND action_id=$2",[tenantId,actionId])).rows.length,"APPEAL_EXISTS",409);
        const at=now(),id=randomUUID();
        await db.query("INSERT INTO dge_moderation.appeals(tenant_id,id,action_id,appellant_id,statement,created_at,command_id,request_digest) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
          [tenantId,id,actionId,actor.accountId,statement,at,commandId,requestDigest]);
        await audit(db,{tenantId,kind:"appealed",subjectId:id,actorId:actor.accountId,at,value:{actionId}});
        return {id,actionId,status:"pending",createdAt:iso(at)};
      });
    },
    /**
     * Grant restores the content; deny keeps it hidden. Where another
     * manager exists, the moderator who hid the content cannot decide the
     * appeal against it.
     */
    async resolveAppeal(credentials,tenantId,appealId,{decision,note=null,commandId}){
      check(uuid(appealId)&&uuid(commandId)&&["grant","deny"].includes(decision)&&(note===null||text(note,1000)),"INVALID_APPEAL_RESOLUTION");
      return scoped(credentials,tenantId,{write:true,recent:true,roles:managers},async(db,actor)=>{
        const appeal=(await db.query("SELECT * FROM dge_moderation.appeals WHERE tenant_id=$1 AND id=$2 FOR UPDATE",[tenantId,appealId])).rows[0];
        check(appeal,"APPEAL_NOT_FOUND",404);
        const status=decision==="grant"?"granted":"denied";
        if(appeal.status!=="pending"){
          check(appeal.status===status,"APPEAL_ALREADY_RESOLVED",409);
          return {appealId,status,resolvedAt:iso(appeal.resolved_at)};
        }
        const action=(await db.query("SELECT * FROM dge_moderation.actions WHERE tenant_id=$1 AND id=$2",[tenantId,appeal.action_id])).rows[0];
        if(action.moderator_id===actor.accountId){
          const others=(await db.query("SELECT count(*)::int AS n FROM dge_identity.memberships WHERE tenant_id=$1 AND active=true AND role IN ('owner','admin') AND account_id<>$2",
            [tenantId,actor.accountId])).rows[0].n;
          check(others===0,"APPEAL_REVIEWER_CONFLICT",403);
        }
        check(appeal.appellant_id!==actor.accountId,"APPEAL_REVIEWER_CONFLICT",403);
        const at=now();
        await db.query("UPDATE dge_moderation.appeals SET status=$3,resolved_by=$4,resolved_at=$5,resolution_note=$6 WHERE tenant_id=$1 AND id=$2",
          [tenantId,appealId,status,actor.accountId,at,note]);
        await audit(db,{tenantId,kind:decision==="grant"?"appeal-granted":"appeal-denied",subjectId:appealId,actorId:actor.accountId,at,value:{status}});
        let restored=null;
        if(decision==="grant"){
          const place=await target(db,tenantId,action.target_kind,action.target_id);
          restored=await applyAction(db,{tenantId,targetKind:action.target_kind,targetId:action.target_id,place,action:"restore",
            reasonCategory:"appeal-granted",actorId:actor.accountId,commandId,appealId,at,
            requestDigest:digest("moderation-appeal-resolution-v1",{appealId,decision,note})});
        }
        return {appealId,status,resolvedAt:iso(at),restoredBy:restored?.actionId??null};
      });
    },
    /** Removal notices for the caller's own proposals and points. */
    async mine(credentials,tenantId){
      return scoped(credentials,tenantId,{},async(db,actor)=>({items:(await db.query(
        `SELECT a.id,a.target_kind,a.target_id,a.document_id,a.proposal_id,a.action,a.reason_category,a.created_at,ap.status AS appeal_status,ap.id AS appeal_id
         FROM dge_moderation.actions a LEFT JOIN dge_moderation.appeals ap ON ap.tenant_id=a.tenant_id AND ap.action_id=a.id
         WHERE a.tenant_id=$1 AND ((a.target_kind='proposal' AND EXISTS (SELECT 1 FROM dge_proposals.proposals p WHERE p.tenant_id=a.tenant_id AND p.id=a.target_id AND p.actor_id=$2))
           OR (a.target_kind='point' AND EXISTS (SELECT 1 FROM dge_discussion.points p WHERE p.tenant_id=a.tenant_id AND p.id=a.target_id AND p.actor_id=$2)))
         ORDER BY a.created_at DESC,a.id LIMIT 200`,[tenantId,actor.accountId])).rows.map(a=>({actionId:a.id,targetKind:a.target_kind,
          targetId:a.target_id,documentId:a.document_id,proposalId:a.proposal_id,action:a.action,reasonCategory:a.reason_category,
          createdAt:iso(a.created_at),appeal:a.appeal_id?{id:a.appeal_id,status:a.appeal_status}:null}))}));
    },
    /** Public moderation log of a public document, without moderator identity. */
    async publicLog(documentId){
      check(uuid(documentId),"INVALID_DOCUMENT_ID");
      check(typeof transaction==="function","MODERATION_SERVICE_UNAVAILABLE",503);
      return transaction(async db=>{
        await db.query("SELECT set_config('dge.public_document_id',$1,true)",[documentId]);
        return {items:(await db.query("SELECT target_kind,target_id,action,reason_category,event_digest,created_at FROM dge_moderation.actions WHERE document_id=$1 ORDER BY created_at,id LIMIT 500",
          [documentId])).rows.map(a=>({targetKind:a.target_kind,targetId:a.target_id,action:a.action,reasonCategory:a.reason_category,
          eventDigest:a.event_digest,createdAt:iso(a.created_at)}))};
      });
    },
  });
}
