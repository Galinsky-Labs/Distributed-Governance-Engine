import {randomUUID,randomBytes} from "node:crypto";
import {normalizeVotePolicySettings,describeVotePolicy} from "../src/vote-policy-settings.mjs";
import {digest} from "../src/integrity.mjs";
import {
  createGovernanceSnapshot, validateGovernanceSnapshot,
  evaluateGovernanceSnapshot,
} from "../src/governance-snapshots.mjs";
import {
  normalizeWeightedPolicySettings, createWeightedSnapshot, validateWeightedSnapshot,
  evaluateWeightedDecision, describeWeightedPolicy, certificateDigest as weightedCertificateDigest,
} from "../src/weighted-governance.mjs";
import {textProposalDigest,applyTextProposal} from "../src/legal-proposals.mjs";
import {applyProposalBundle} from "../src/proposal-bundles.mjs";
import {legalDocumentDigest} from "../src/legal-schema.mjs";
import {DocumentError} from "./document-store.mjs";
import {freezeRosterSnapshot,allocationFits} from "./electorate-store.mjs";
import {sectionAccess,targetPath} from "./section-grants.mjs";
import {appendLedgerEvent} from "./ledger.mjs";
import {deadlineInstant} from "../src/policy-lifecycle.mjs";

const uuid = value => typeof value === "string" &&
  /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
const check = (condition, code, status=400) => {
  if (!condition) throw new DocumentError(code,status);
};
const votingRoles=["owner","admin","editor","participant"];
const managerialRoles=["owner","admin"];
const allRoles=["owner","admin","editor","participant","viewer"];
const choices=["yes","no","abstain"];
export const CHALLENGE_CATEGORIES=Object.freeze(["eligibility","ballot-irregularity","procedure","conflict-of-interest","other"]);
const WEIGHTED_OPTIONS=["electorate","weighting","challengeWindowHours","bundle","deadline"];
const iso=value=>new Date(value).toISOString();
const isWeighted=row=>row.snapshot?.schemaVersion===2;
// Closed decisions created before finality existed carry NULL, which is final.
const finalityOf=row=>row.state==="closed"?(row.finality??"final"):null;
const rowsFor = async(db,tenantId,decisionId) =>
  (await db.query("SELECT account_id,choice,cast_at,version FROM dge_decisions.ballots WHERE tenant_id=$1 AND decision_id=$2 ORDER BY account_id",
    [tenantId,decisionId])).rows;
const proxyRowsFor = async(db,tenantId,decisionId) =>
  (await db.query(
    `SELECT b.grant_id,b.proxy_id,b.principal_id,b.choice,b.version,b.allocation,b.cast_at,g.revoked_at
     FROM dge_electorates.proxy_ballots b JOIN dge_electorates.proxy_grants g ON g.tenant_id=b.tenant_id AND g.id=b.grant_id
     WHERE b.tenant_id=$1 AND b.decision_id=$2 ORDER BY b.grant_id`,[tenantId,decisionId])).rows;
/** Binds stored ballots to a snapshot validated once by the caller. Calling
 * ballotForGovernanceSnapshot per row re-validated and re-hashed the whole
 * frozen electorate for every ballot, which made each tally quadratic. The
 * evaluator still rejects any ballot outside the electorate or window. */
const ballotsFor = (snapshot, rows) => {
  const fixed=validateGovernanceSnapshot(snapshot);
  return rows.map(row => Object.freeze({
    principalId:row.account_id,choice:row.choice,castAt:new Date(row.cast_at).getTime(),
    proposalDigest:fixed.proposalDigest,electorateId:fixed.electorate.id,electorateDigest:fixed.electorateDigest,
    policyId:fixed.policy.id,policyDigest:fixed.policyDigest,
  }));
};
/** Weighted ballots as the evaluator sees them. A proxy ballot whose grant
 * was revoked at or before `at` no longer counts. */
const weightedBallots=(direct,proxies,at)=>[
  ...direct.map(r=>({principalId:r.account_id,choice:r.choice})),
  ...proxies.filter(r=>r.revoked_at===null||new Date(r.revoked_at)>at)
    .map(r=>({principalId:r.principal_id,proxyId:r.proxy_id,grantId:r.grant_id,choice:r.choice,allocation:r.allocation??"all"})),
];
const publicState = (row,ballots,clock,own) => {
  const snapshot=validateGovernanceSnapshot(row.snapshot);
  check(snapshot.snapshotDigest===row.snapshot_digest,"DECISION_INTEGRITY_ERROR",503);
  const result=evaluateGovernanceSnapshot(snapshot,ballotsFor(snapshot,ballots),clock);
  const my=own ? ballots.find(v=>v.account_id===own) : null;
  return {
    id:row.id,documentId:row.document_id,proposalId:row.proposal_id,baseVersion:row.base_version,
    mode:snapshot.mode,snapshotDigest:snapshot.snapshotDigest,proposalDigest:snapshot.proposalDigest,
    eligibleCount:snapshot.electorate.members.length,weighting:"equal",
    opensAt:new Date(snapshot.policy.opensAt).toISOString(),
    closesAt:new Date(snapshot.policy.closesAt).toISOString(),
    rule:describeVotePolicy(snapshot.policy),
    policyId:snapshot.policy.id,policyDigest:snapshot.policyDigest,
    state:row.state,
    outcome:{
      status:row.state==="closed" ? result.status : clock<snapshot.policy.opensAt ? "not-open" : clock>=snapshot.policy.closesAt ? "awaiting-closure" : "open",
      yes:result.weights.yes,no:result.weights.no,abstain:result.weights.abstain,
      participating:result.counts.participating,eligible:result.counts.eligible,
      quorumMet:row.state==="closed" ? result.quorumMet : null,
      approvalMet:row.state==="closed" ? result.approvalMet : null,
      // Decision receipt is separate from legally effective adoption.
      executed:false,canAdopt:false,
    },
    mine:my ? {choice:my.choice,version:my.version} : {choice:null,version:0},
    certificateDigest:row.certificate_digest ?? null,
    anchorStatus:"pending",
  };
};

function weightedOptions(proposalId,{electorate,weighting,challengeWindowHours,bundle,policySettings,deadline}){
  const source=electorate??{source:"membership"};
  check(source&&typeof source==="object"&&!Array.isArray(source),"INVALID_ELECTORATE");
  let spec;
  if(source.source==="membership"){
    check(Object.keys(source).length===1,"INVALID_ELECTORATE");
    spec={source:"membership"};
  }else{
    check(source.source==="roster"&&Object.keys(source).sort().join(",")==="recordDate,rosterId,source"&&
      uuid(source.rosterId)&&typeof source.recordDate==="string","INVALID_ELECTORATE");
    const ms=Date.parse(source.recordDate);
    check(Number.isSafeInteger(ms)&&ms>=0&&iso(ms)===source.recordDate,"INVALID_ELECTORATE");
    spec={source:"roster",rosterId:source.rosterId,recordDate:source.recordDate};
  }
  const weight=weighting??"equal";
  check(["equal","units"].includes(weight)&&(weight==="equal"||spec.source==="roster"),"INVALID_WEIGHTING");
  const window=challengeWindowHours??0;
  check(Number.isSafeInteger(window)&&window>=0&&window<=720,"INVALID_CHALLENGE_WINDOW");
  const list=bundle??[proposalId];
  check(Array.isArray(list)&&list.length>=1&&list.length<=20&&list[0]===proposalId&&list.every(uuid)&&
    new Set(list).size===list.length,"INVALID_BUNDLE");
  let settings;
  try{settings=normalizeWeightedPolicySettings(policySettings,{weighting:weight});}
  catch{throw new DocumentError("INVALID_VOTE_POLICY",400);}
  check(settings.classRequirements.length===0||spec.source==="roster","INVALID_VOTE_POLICY");
  // DCE-010: a published local deadline in a named time zone resolves to one
  // exact instant; nonexistent and ambiguous local times are refused.
  let deadlineSpec=null;
  if(deadline!==undefined){
    check(deadline&&typeof deadline==="object"&&!Array.isArray(deadline)&&Object.keys(deadline).sort().join(",")==="date,time,timeZone","INVALID_DEADLINE");
    let at;try{at=deadlineInstant(deadline);}catch{throw new DocumentError("INVALID_DEADLINE",400);}
    deadlineSpec={date:deadline.date,time:deadline.time,timeZone:deadline.timeZone,at};
  }
  return {electorate:spec,weighting:weight,challengeWindowHours:window,bundle:list,settings,deadline:deadlineSpec};
}

/** Scoped governance ledger: exact-version votes with frozen electorates.
 * Version 1 decisions use the frozen workspace membership with one vote per
 * account. Version 2 decisions add roster snapshots at a record date,
 * unit weighting, class requirements, proxies, bundles and challenge
 * windows. This is not a statutory signature, an enacted law or an
 * executed resolution.
 */
export function createDecisionStore({
  identity,transaction,clock=Date.now,maxElectors=1000,maxVoteVersions=50,maxChallengesPerVoter=3,maxChallenges=100,
}={}) {
  check(identity && typeof identity.withTenant==="function" && typeof clock==="function",
    "DECISION_STORE_CONFIG");
  check(Number.isSafeInteger(maxElectors)&&maxElectors>0&&maxElectors<=100000 &&
    Number.isSafeInteger(maxVoteVersions)&&maxVoteVersions>0&&maxVoteVersions<=100 &&
    Number.isSafeInteger(maxChallengesPerVoter)&&maxChallengesPerVoter>0&&maxChallengesPerVoter<=100 &&
    Number.isSafeInteger(maxChallenges)&&maxChallenges>0&&maxChallenges<=10000,"DECISION_STORE_CONFIG");
  const now=()=>{
    const ms=clock();
    check(Number.isSafeInteger(ms)&&ms>=0,"CLOCK_UNAVAILABLE",503);
    return ms;
  };
  const ids=(tenantId,documentId,proposalId) =>
    check(uuid(tenantId)&&uuid(documentId)&&uuid(proposalId),"INVALID_DECISION_CONTEXT");
  // A proposal may have void decisions behind its current one; the current
  // (non-void, then newest) decision is the one every operation addresses.
  async function decision(db,tenantId,documentId,proposalId,lock=false) {
    const row=(await db.query(
      "SELECT * FROM dge_decisions.decisions WHERE tenant_id=$1 AND document_id=$2 AND proposal_id=$3 ORDER BY finality IS NOT DISTINCT FROM 'void',created_at DESC,id LIMIT 1" +
      (lock?" FOR UPDATE":""),
      [tenantId,documentId,proposalId])).rows[0];
    check(row,"DECISION_NOT_FOUND",404);
    return row;
  }
  const snapshotOf=row=>{
    const snap=validateGovernanceSnapshot(row.snapshot);
    check(snap.snapshotDigest===row.snapshot_digest,"DECISION_INTEGRITY_ERROR",503);
    return snap;
  };
  const weightedSnapshotOf=row=>{
    let snap;
    try{snap=validateWeightedSnapshot(row.snapshot);}catch{throw new DocumentError("DECISION_INTEGRITY_ERROR",503);}
    check(snap.snapshotDigest===row.snapshot_digest,"DECISION_INTEGRITY_ERROR",503);
    return snap;
  };
  const scoped=(credentials,tenantId,roles,write,fn)=>
    identity.withTenant(credentials,tenantId,{write,roles},fn);
  async function activity(db,tenantId,row,actorId,commandId,requestDigest,result,eventType,at) {
    const eventId=randomUUID();
    const eventDigest=digest("decision-ledger-event-v1",{
      eventId,tenantId,decisionId:row.id,actorId,commandId,requestDigest,eventType,at:at.toISOString(),result
    });
    await db.query(
      "INSERT INTO dge_decisions.events(tenant_id,id,decision_id,actor_id,command_id,request_digest,result,event_digest,occurred_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [tenantId,eventId,row.id,actorId,commandId,requestDigest,result,eventDigest,at]
    );
    await db.query(
      "INSERT INTO dge_decisions.anchor_outbox(tenant_id,event_id,decision_id,event_digest,created_at) VALUES($1,$2,$3,$4,$5)",
      [tenantId,eventId,row.id,eventDigest,at]
    );
    return eventDigest;
  }
  async function priorEvent(db,tenantId,actorId,commandId,requestDigest){
    const prior=(await db.query(
      "SELECT result,request_digest FROM dge_decisions.events WHERE tenant_id=$1 AND actor_id=$2 AND command_id=$3",
      [tenantId,actorId,commandId])).rows[0];
    if(!prior)return undefined;
    check(prior.request_digest===requestDigest,"COMMAND_REUSED",409);
    return prior.result;
  }
  /** Proposals already bound to a live (non-void) decision, directly or in a bundle. */
  async function proposalsInUse(db,tenantId,documentId,proposalIds){
    return (await db.query(
      `SELECT 1 FROM dge_decisions.decisions WHERE tenant_id=$1 AND document_id=$2 AND finality IS DISTINCT FROM 'void'
         AND proposal_id IN (SELECT jsonb_array_elements_text($3::jsonb)::uuid)
       UNION ALL SELECT 1 FROM dge_electorates.bundle_members b JOIN dge_decisions.decisions d ON d.tenant_id=b.tenant_id AND d.id=b.decision_id
       WHERE b.tenant_id=$1 AND b.document_id=$2 AND d.finality IS DISTINCT FROM 'void'
         AND b.proposal_id IN (SELECT jsonb_array_elements_text($3::jsonb)::uuid) LIMIT 1`,
      [tenantId,documentId,JSON.stringify(proposalIds)])).rows.length>0;
  }
  /**
   * When a document has clause permissions, only principals holding `vote`
   * on every targeted section stay in the frozen electorate.
   */
  async function sectionVoters(db,{tenantId,documentId,baseVersion,blockIds,members,at}){
    const access=await sectionAccess(db,{tenantId,documentId,at});
    if(!access.restricted)return {members,excluded:0};
    const base=(await db.query("SELECT document,digest FROM dge_documents.versions WHERE tenant_id=$1 AND document_id=$2 AND version=$3",
      [tenantId,documentId,baseVersion])).rows[0];
    check(base&&legalDocumentDigest(base.document)===base.digest,"DOCUMENT_INTEGRITY_ERROR",503);
    const paths=blockIds.map(id=>targetPath(base.document,id));
    check(paths.every(Boolean),"PROPOSAL_INTEGRITY_ERROR",503);
    const roles=new Map((await db.query("SELECT account_id,role FROM dge_identity.memberships WHERE tenant_id=$1 AND active=true",[tenantId])).rows
      .map(r=>[r.account_id,r.role]));
    const kept=members.filter(m=>paths.every(path=>access.holds({accountId:m.principalId,role:roles.get(m.principalId)??null},path,"vote")));
    return {members:kept,excluded:members.length-kept.length};
  }
  /** Applies passed wording as exactly one new public draft revision. */
  async function applyToDraft(db,{tenantId,documentId,decisionId,source,proposals,actorId,at,requestDigest,amend}){
    check(source.version<1000000,"VERSION_LIMIT_REACHED",429);
    const amended=amend(source.current,proposals);
    const newDigest=legalDocumentDigest(amended),nextVersion=source.version+1;
    const bytes=Buffer.byteLength(JSON.stringify(amended));
    check((await db.query(
      "UPDATE dge_documents.usage SET stored_bytes=stored_bytes+$2 WHERE tenant_id=$1 AND stored_bytes+$2<=$3 RETURNING stored_bytes",
      [tenantId,bytes,30000000]
    )).rows.length,"STORAGE_LIMIT_REACHED",429);
    const eventDigest=digest("public-document-version-v1",{
      tenantId,documentId,version:nextVersion,digest:newDigest,
      previousDigest:source.digest,createdAt:at.toISOString()
    });
    await db.query(
      "UPDATE dge_documents.documents SET current=$3,version=$4,digest=$5 WHERE tenant_id=$1 AND id=$2",
      [tenantId,documentId,amended,nextVersion,newDigest]
    );
    // command_id is the decision ID and is unique per tenant, so one
    // decision can never append a second revision.
    await db.query(
      "INSERT INTO dge_documents.versions(tenant_id,document_id,version,document,digest,previous_digest,event_digest,command_id,request_digest,actor_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
      [tenantId,documentId,nextVersion,amended,newDigest,source.digest,eventDigest,decisionId,requestDigest,actorId,at]
    );
    await db.query(
      "INSERT INTO dge_documents.anchor_outbox(tenant_id,document_id,version,event_digest,created_at) VALUES($1,$2,$3,$4,$5)",
      [tenantId,documentId,nextVersion,eventDigest,at]
    );
    return {appliedVersion:nextVersion,appliedDigest:newDigest};
  }
  async function recordCertificate(db,tenantId,row,finality,certificate,at){
    const certificateDigest=weightedCertificateDigest(certificate);
    const sequence=(await db.query("SELECT coalesce(max(sequence),0)::int+1 AS n FROM dge_electorates.certificates WHERE tenant_id=$1 AND decision_id=$2",
      [tenantId,row.id])).rows[0].n;
    await db.query("INSERT INTO dge_electorates.certificates(tenant_id,decision_id,sequence,finality,certificate,certificate_digest,recorded_at) VALUES($1,$2,$3,$4,$5,$6,$7)",
      [tenantId,row.id,sequence,finality,certificate,certificateDigest,at]);
    await appendLedgerEvent(db,{tenantId,kind:finality==="provisional"?"decision-provisional":finality==="void"?"decision-void":"decision-certificate",
      subjectId:row.id,eventDigest:certificateDigest,finalization:finality!=="provisional",at});
    return certificateDigest;
  }
  async function challengeSummary(db,tenantId,decisionId,windowEndsAt,outcome){
    const rows=(await db.query("SELECT reason_category,status FROM dge_electorates.challenges WHERE tenant_id=$1 AND decision_id=$2",[tenantId,decisionId])).rows;
    const categories={};
    for(const r of rows)categories[r.reason_category]=(categories[r.reason_category]??0)+1;
    return {windowEndsAt,filed:rows.length,
      categories:Object.fromEntries(Object.entries(categories).sort(([a],[b])=>a<b?-1:1)),outcome};
  }
  /**
   * The single place a weighted decision becomes final. It runs inside the
   * decision row lock, after which finality is immutable, so amendment text
   * is applied at most once and only for a final passed collaboration vote.
   */
  async function finalizeWeighted(db,{tenantId,row,snapshot,base,actorId,at,challengeOutcome}){
    const source=(await db.query(
      "SELECT version,current,digest FROM dge_documents.documents WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
      [tenantId,row.document_id])).rows[0];
    check(source,"DOCUMENT_NOT_FOUND",404);
    check(legalDocumentDigest(source.current)===source.digest,"DOCUMENT_INTEGRITY_ERROR",503);
    const sourceIsCurrent=row.base_version===source.version;
    let application="not-passed",appliedVersion=null,appliedDigest=null;
    if(snapshot.mode==="public-input")application="advisory";
    else if(base.outcome.passed){
      if(!sourceIsCurrent||source.current.mode!=="collaboration"||source.current.lifecycle!=="draft"){
        // Exact-base check failed: an overlapping proposal adopted first.
        application="stale-source";
      }else{
        const members=(await db.query("SELECT proposal_id FROM dge_electorates.bundle_members WHERE tenant_id=$1 AND decision_id=$2 ORDER BY position",
          [tenantId,row.id])).rows.map(r=>r.proposal_id);
        check(members.length===snapshot.proposals.length&&members.every((id,i)=>id===snapshot.proposals[i].proposalId),"DECISION_INTEGRITY_ERROR",503);
        const proposals=[];
        for(const entry of snapshot.proposals){
          const p=(await db.query("SELECT proposal,digest FROM dge_proposals.proposals WHERE tenant_id=$1 AND document_id=$2 AND id=$3",
            [tenantId,row.document_id,entry.proposalId])).rows[0];
          check(p&&p.digest===entry.proposalDigest&&textProposalDigest(p.proposal)===p.digest,"PROPOSAL_INTEGRITY_ERROR",503);
          proposals.push(p.proposal);
        }
        const requestDigest=digest("public-document-command-v1",{
          action:"adopt-final-weighted-decision",decisionId:row.id,sourceVersion:source.version,
          proposalDigests:snapshot.proposals.map(p=>p.proposalDigest)
        });
        let amend;
        try{
          const amended=proposals.length===1?applyTextProposal(source.current,proposals[0]):applyProposalBundle(source.current,proposals);
          amend=()=>amended;
        }catch{application="conflicted";}
        if(amend){
          ({appliedVersion,appliedDigest}=await applyToDraft(db,{tenantId,documentId:row.document_id,decisionId:row.id,
            source,proposals,actorId,at,requestDigest,amend}));
          application="applied-to-public-draft";
        }
      }
    }
    const certificate={...base,finality:"final",
      challenge:{...base.challenge,...await challengeSummary(db,tenantId,row.id,base.challenge.windowEndsAt,challengeOutcome)},
      application,appliedVersion,appliedDigest,sourceVersionAtFinalization:source.version,sourceIsCurrent,
      finalizedAt:at.toISOString(),previousCertificateDigest:row.state==="closed"?row.certificate_digest:null};
    const certificateDigest=await recordCertificate(db,tenantId,row,"final",certificate,at);
    return {certificate,certificateDigest};
  }
  async function castingVoteFor(db,tenantId,decisionId){
    const r=(await db.query("SELECT principal_id,choice FROM dge_decisions.casting_votes WHERE tenant_id=$1 AND decision_id=$2",[tenantId,decisionId])).rows[0];
    return r?{principalId:r.principal_id,choice:r.choice}:null;
  }
  async function weightedState(db,row,clock,actor){
    const snapshot=weightedSnapshotOf(row);
    const direct=await rowsFor(db,row.tenant_id,row.id),proxies=await proxyRowsFor(db,row.tenant_id,row.id);
    const policy=snapshot.policy,closed=row.state==="closed",finality=finalityOf(row);
    const castingVote=closed?null:await castingVoteFor(db,row.tenant_id,row.id);
    const evaluation=closed?row.certificate.outcome:evaluateWeightedDecision({mode:snapshot.mode,policy,
      electorate:snapshot.electorate,ballots:weightedBallots(direct,proxies,new Date(clock)),now:clock,castingVote});
    const member=snapshot.electorate.members.find(m=>m.principalId===actor.accountId);
    const my=direct.find(v=>v.account_id===actor.accountId);
    const held=(await db.query(
      `SELECT id,allocation FROM dge_electorates.proxy_grants WHERE tenant_id=$1 AND grantee_id=$2 AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at>$3) AND (decision_id=$4 OR roster_id=$5::uuid) ORDER BY id`,
      [row.tenant_id,actor.accountId,new Date(clock),row.id,snapshot.electorate.rosterId??null])).rows;
    const status=closed?(finality==="void"?"void":evaluation.status):
      clock<policy.opensAt?"not-open":clock>=policy.closesAt?"awaiting-closure":"open";
    return {
      id:row.id,schemaVersion:2,documentId:row.document_id,proposalId:row.proposal_id,baseVersion:row.base_version,
      bundle:snapshot.proposals,mode:snapshot.mode,snapshotDigest:snapshot.snapshotDigest,
      proposalDigest:snapshot.proposals[0].proposalDigest,
      eligibleCount:snapshot.electorate.members.length,eligibleWeight:evaluation.overall.eligibleWeight,
      weighting:policy.weighting,
      electorate:{source:snapshot.electorate.source,rosterKind:snapshot.electorate.rosterKind??null,
        recordDate:snapshot.electorate.recordDate===undefined?null:iso(snapshot.electorate.recordDate),
        exclusions:snapshot.electorate.exclusions},
      opensAt:iso(policy.opensAt),closesAt:iso(policy.closesAt),
      rule:describeWeightedPolicy(policy),policyId:policy.id,policyDigest:snapshot.policyDigest,
      state:row.state,finality,
      challengeClosesAt:row.challenge_closes_at?iso(row.challenge_closes_at):null,
      outcome:{status,yes:evaluation.overall.yes,no:evaluation.overall.no,abstain:evaluation.overall.abstain,
        participating:Number(evaluation.overall.participatingHeads),participatingWeight:evaluation.overall.participatingWeight,
        eligible:snapshot.electorate.members.length,
        quorumMet:closed?evaluation.overall.quorum?.met??null:null,approvalMet:closed?evaluation.overall.approval?.met??null:null,
        classes:closed?evaluation.classes:[],executed:false,canAdopt:false,
        tie:evaluation.tie??null,supportFloor:evaluation.supportFloor??null},
      castingPrincipal:policy.castingPrincipalId===actor.accountId,
      evaluation:closed?evaluation:null,
      mine:{choice:my?.choice??null,version:my?.version??0,eligible:Boolean(member),classes:member?.classes??null},
      proxies:held.map(g=>{
        const cast=proxies.find(p=>p.grant_id===g.id);
        return {grantId:g.id,allocation:g.allocation,choice:cast?.choice??null,version:cast?.version??0};
      }),
      application:row.certificate?.application??null,
      certificateDigest:row.certificate_digest??null,
      anchorStatus:"pending",
    };
  }
  async function openWeighted(db,actor,{tenantId,documentId,proposalId,hours,commandId,options}){
    const requestDigest=digest("decision-open-command-v2",{tenantId,documentId,proposalId,...(hours===undefined?{}:{hours}),actorId:actor.accountId,
      electorate:options.electorate,weighting:options.weighting,challengeWindowHours:options.challengeWindowHours,
      bundle:options.bundle,policySettings:options.settings,...(options.deadline?{deadline:options.deadline}:{})});
    const prior=(await db.query("SELECT * FROM dge_decisions.decisions WHERE tenant_id=$1 AND command_id=$2",[tenantId,commandId])).rows[0];
    if(prior){
      check(prior.request_digest===requestDigest,"COMMAND_REUSED",409);
      return weightedState(db,prior,now(),actor);
    }
    const source=(await db.query(
      "SELECT version,current,digest FROM dge_documents.documents WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
      [tenantId,documentId])).rows[0];
    check(source,"DOCUMENT_NOT_FOUND",404);
    const proposals=[];
    for(const id of options.bundle){
      const p=(await db.query("SELECT id,base_version,proposal,digest,created_at FROM dge_proposals.proposals WHERE tenant_id=$1 AND document_id=$2 AND id=$3",
        [tenantId,documentId,id])).rows[0];
      check(p,"PROPOSAL_NOT_FOUND",404);
      check(textProposalDigest(p.proposal)===p.digest,"PROPOSAL_INTEGRITY_ERROR",503);
      check(p.base_version===source.version,"STALE_SOURCE_VERSION",409);
      proposals.push(p);
    }
    check(!await proposalsInUse(db,tenantId,documentId,options.bundle),"DECISION_ALREADY_EXISTS",409);
    const at=new Date(now()),decisionId=randomUUID();
    let members,exclusions={},rosterFields={};
    if(options.electorate.source==="membership"){
      members=(await db.query(
        "SELECT account_id FROM dge_identity.memberships WHERE tenant_id=$1 AND active=true AND role IN ('owner','admin','editor','participant') ORDER BY account_id",
        [tenantId])).rows.map(r=>({principalId:r.account_id,classes:{default:"1"}}));
    }else{
      const frozen=await freezeRosterSnapshot(db,{tenantId,rosterId:options.electorate.rosterId,
        recordDate:new Date(options.electorate.recordDate),actorId:actor.accountId,at});
      members=frozen.members;exclusions={...frozen.summary.exclusions};
      rosterFields={rosterId:frozen.rosterId,rosterKind:frozen.rosterKind,recordDate:frozen.recordDate.getTime()};
    }
    const filtered=await sectionVoters(db,{tenantId,documentId,baseVersion:source.version,
      blockIds:proposals.map(p=>p.proposal.selection.blockId),members,at});
    if(filtered.excluded)exclusions["no-section-vote-right"]=filtered.excluded;
    members=[...filtered.members].sort((a,b)=>a.principalId<b.principalId?-1:1);
    check(members.length>0,"EMPTY_ELECTORATE",409);
    check(members.length<=maxElectors,"ELECTORATE_LIMIT_REACHED",429);
    const settings=options.settings;
    // DCE-010: tie rules decide adoption votes; support floors describe
    // advisory public input. Neither may be attached to the other mode.
    check(!settings.supportFloor||source.current.mode==="public-input","SUPPORT_FLOOR_REQUIRES_PUBLIC_INPUT",400);
    check(!settings.tieRule||source.current.mode==="collaboration","TIE_RULE_REQUIRES_COLLABORATION",400);
    if(settings.castingPrincipalId){
      check(uuid(settings.castingPrincipalId),"INVALID_VOTE_POLICY");
      const presiding=(await db.query("SELECT 1 FROM dge_identity.memberships WHERE tenant_id=$1 AND account_id=$2 AND active=true AND role IN ('owner','admin','editor','participant')",
        [tenantId,settings.castingPrincipalId])).rows[0];
      check(presiding,"CASTING_PRINCIPAL_NOT_A_MEMBER",400);
    }
    const eligibleWeight=options.weighting==="equal"?BigInt(members.length):
      members.reduce((sum,m)=>sum+Object.values(m.classes).reduce((s,v)=>s+BigInt(v),0n),0n);
    check(BigInt(settings.minYes)<=eligibleWeight&&
      (settings.quorum.kind!=="count"||BigInt(settings.quorum.minimum)<=BigInt(members.length))&&
      (settings.quorum.kind!=="weight"||BigInt(settings.quorum.minimum)<=eligibleWeight)&&
      settings.classRequirements.every(r=>members.some(m=>Object.hasOwn(m.classes,r.class))),"UNATTAINABLE_VOTE_POLICY",400);
    const publishedAt=Math.max(...proposals.map(p=>new Date(p.created_at).getTime()));
    check(Number.isSafeInteger(publishedAt)&&publishedAt>=0,"PROPOSAL_INTEGRITY_ERROR",503);
    const opensMs=Math.max(at.getTime(),publishedAt+settings.minimumDeliberationHours*3600000);
    const closeMs=options.deadline?options.deadline.at:opensMs+hours*3600000;
    check(Number.isSafeInteger(closeMs)&&closeMs>=opensMs+3600000&&closeMs<=opensMs+720*3600000,"INVALID_VOTE_WINDOW");
    let snapshot;
    try{
      snapshot=createWeightedSnapshot({id:decisionId,tenantId,documentId,mode:source.current.mode,createdAt:at.getTime(),
        proposals:proposals.map(p=>({proposalId:p.id,proposalDigest:p.digest})),
        electorate:{id:"electorate-"+decisionId,kind:"frozen",source:options.electorate.source,...rosterFields,members,exclusions},
        policy:{id:"policy-"+decisionId,weighting:options.weighting,opensAt:opensMs,closesAt:closeMs,
          minYes:settings.minYes,quorum:settings.quorum,approval:settings.approval,classRequirements:settings.classRequirements,
          challengeWindowMs:options.challengeWindowHours*3600000,
          minimumDeliberationHours:settings.minimumDeliberationHours,proposalPublishedAt:publishedAt,
          ...(settings.tieRule?{tieRule:settings.tieRule}:{}),...(settings.castingPrincipalId?{castingPrincipalId:settings.castingPrincipalId}:{}),
          ...(settings.supportFloor?{supportFloor:settings.supportFloor}:{})}});
    }catch{throw new DocumentError("UNATTAINABLE_VOTE_POLICY",400);}
    await db.query(
      "INSERT INTO dge_decisions.decisions(tenant_id,id,document_id,proposal_id,base_version,snapshot,snapshot_digest,created_by,created_at,closes_at,command_id,request_digest) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",
      [tenantId,decisionId,documentId,proposalId,source.version,snapshot,snapshot.snapshotDigest,actor.accountId,at,new Date(closeMs),commandId,requestDigest]
    );
    for(const [position,p] of proposals.entries())
      await db.query("INSERT INTO dge_electorates.bundle_members(tenant_id,decision_id,position,document_id,proposal_id) VALUES($1,$2,$3,$4,$5)",
        [tenantId,decisionId,position,documentId,p.id]);
    const row=(await db.query("SELECT * FROM dge_decisions.decisions WHERE tenant_id=$1 AND id=$2",[tenantId,decisionId])).rows[0];
    await activity(db,tenantId,row,actor.accountId,commandId,requestDigest,{snapshotDigest:snapshot.snapshotDigest},"opened",at);
    return weightedState(db,row,at.getTime(),actor);
  }
  async function castWeighted(db,actor,row,{choice,expectedVersion,commandId,onBehalfOf}){
    const tenantId=row.tenant_id;
    const requestDigest=onBehalfOf===undefined?digest("decision-ballot-command-v1",{
      actorId:actor.accountId,decisionId:row.id,choice,expectedVersion
    }):digest("decision-proxy-ballot-command-v1",{actorId:actor.accountId,decisionId:row.id,choice,expectedVersion,grantId:onBehalfOf});
    const prior=await priorEvent(db,tenantId,actor.accountId,commandId,requestDigest);
    if(prior)return prior;
    const snapshot=weightedSnapshotOf(row),at=new Date(now());
    check(row.state==="open","VOTE_CLOSED",409);
    check(at.getTime()>=snapshot.policy.opensAt&&at.getTime()<snapshot.policy.closesAt,"VOTE_WINDOW_CLOSED",409);
    let result;
    if(onBehalfOf===undefined){
      check(snapshot.electorate.members.some(m=>m.principalId===actor.accountId),"NOT_IN_FROZEN_ELECTORATE",403);
      const previous=(await db.query("SELECT version FROM dge_decisions.ballots WHERE tenant_id=$1 AND decision_id=$2 AND account_id=$3",
        [tenantId,row.id,actor.accountId])).rows[0];
      const version=previous?.version??0;
      check(version===expectedVersion,"BALLOT_VERSION_CONFLICT",409);
      check(version<maxVoteVersions,"BALLOT_CHANGE_LIMIT_REACHED",429);
      await db.query(
        "INSERT INTO dge_decisions.ballots(tenant_id,decision_id,account_id,choice,version,cast_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(tenant_id,decision_id,account_id) DO UPDATE SET choice=excluded.choice,version=excluded.version,cast_at=excluded.cast_at",
        [tenantId,row.id,actor.accountId,choice,version+1,at]);
      result={decisionId:row.id,choice,version:version+1,receiptDigest:digest("decision-ballot-receipt-v1",{
        decisionId:row.id,snapshotDigest:snapshot.snapshotDigest,actorId:actor.accountId,choice,version:version+1,castAt:at.toISOString()})};
    }else{
      const grant=(await db.query("SELECT * FROM dge_electorates.proxy_grants WHERE tenant_id=$1 AND id=$2",[tenantId,onBehalfOf])).rows[0];
      check(grant&&grant.grantee_id===actor.accountId,"PROXY_GRANT_NOT_FOUND",404);
      check(grant.revoked_at===null,"PROXY_REVOKED",409);
      check(grant.expires_at===null||new Date(grant.expires_at)>at,"PROXY_EXPIRED",409);
      const rosterId=snapshot.electorate.rosterId??null;
      check(grant.decision_id===row.id||(grant.roster_id!==null&&grant.roster_id===rosterId),"PROXY_SCOPE_MISMATCH",409);
      const member=snapshot.electorate.members.find(m=>m.principalId===grant.grantor_id);
      check(member,"NOT_IN_FROZEN_ELECTORATE",403);
      check(snapshot.policy.weighting==="units"||grant.allocation===null,"PROXY_SPLIT_NOT_ALLOWED",409);
      // Every live grant of this principal that reaches this decision must
      // fit the frozen holding together; weight never comes from the client.
      const live=(await db.query(
        `SELECT allocation FROM dge_electorates.proxy_grants WHERE tenant_id=$1 AND grantor_id=$2 AND revoked_at IS NULL
          AND (expires_at IS NULL OR expires_at>$3) AND (decision_id=$4 OR roster_id=$5::uuid)`,
        [tenantId,grant.grantor_id,at,row.id,rosterId])).rows.map(r=>r.allocation);
      check(allocationFits(member.classes,live),"PROXY_OVER_ALLOCATION",409);
      const previous=(await db.query("SELECT version FROM dge_electorates.proxy_ballots WHERE tenant_id=$1 AND decision_id=$2 AND grant_id=$3",
        [tenantId,row.id,grant.id])).rows[0];
      const version=previous?.version??0;
      check(version===expectedVersion,"BALLOT_VERSION_CONFLICT",409);
      check(version<maxVoteVersions,"BALLOT_CHANGE_LIMIT_REACHED",429);
      await db.query(
        "INSERT INTO dge_electorates.proxy_ballots(tenant_id,decision_id,grant_id,proxy_id,principal_id,choice,version,allocation,cast_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(tenant_id,decision_id,grant_id) DO UPDATE SET choice=excluded.choice,version=excluded.version,cast_at=excluded.cast_at",
        [tenantId,row.id,grant.id,actor.accountId,grant.grantor_id,choice,version+1,grant.allocation,at]);
      result={decisionId:row.id,choice,version:version+1,onBehalfOf:grant.id,receiptDigest:digest("decision-proxy-ballot-receipt-v1",{
        decisionId:row.id,snapshotDigest:snapshot.snapshotDigest,proxyId:actor.accountId,grantId:grant.id,choice,version:version+1,castAt:at.toISOString()})};
    }
    await activity(db,tenantId,row,actor.accountId,commandId,requestDigest,result,"ballot",at);
    return result;
  }
  async function closeWeighted(db,actor,row){
    const tenantId=row.tenant_id;
    if(row.state==="closed")return {certificate:row.certificate,certificateDigest:row.certificate_digest};
    const snapshot=weightedSnapshotOf(row),at=new Date(now());
    check(at.getTime()>=snapshot.policy.closesAt,"VOTE_STILL_OPEN",409);
    const direct=await rowsFor(db,tenantId,row.id),proxies=await proxyRowsFor(db,tenantId,row.id);
    const outcome=evaluateWeightedDecision({mode:snapshot.mode,policy:snapshot.policy,electorate:snapshot.electorate,
      ballots:weightedBallots(direct,proxies,at),now:at.getTime(),castingVote:await castingVoteFor(db,tenantId,row.id)});
    const revoked=proxies.filter(p=>p.revoked_at!==null&&new Date(p.revoked_at)<=at).length;
    const source=(await db.query("SELECT version FROM dge_documents.documents WHERE tenant_id=$1 AND id=$2",[tenantId,row.document_id])).rows[0];
    check(source,"DOCUMENT_NOT_FOUND",404);
    // As in version 1, the salt stays in a tenant-private closure event.
    const ballotSalt=randomBytes(32).toString("hex");
    const ballotsDigest=digest("weighted-decision-ballots-v1",{salt:ballotSalt,
      direct:direct.map(r=>({accountId:r.account_id,choice:r.choice,version:r.version,castAt:iso(r.cast_at)})),
      proxies:proxies.map(r=>({grantId:r.grant_id,proxyId:r.proxy_id,principalId:r.principal_id,choice:r.choice,
        version:r.version,allocation:r.allocation,castAt:iso(r.cast_at),revoked:r.revoked_at!==null&&new Date(r.revoked_at)<=at}))});
    const windowMs=snapshot.policy.challengeWindowMs;
    const windowEndsAt=windowMs>0?new Date(at.getTime()+windowMs):null;
    const e=snapshot.electorate;
    const base={
      schemaVersion:2,kind:"governance-decision-record-not-execution",tenantId,documentId:row.document_id,
      proposalId:row.proposal_id,decisionId:row.id,proposals:snapshot.proposals,
      snapshotDigest:snapshot.snapshotDigest,policyDigest:snapshot.policyDigest,electorateDigest:snapshot.electorateDigest,
      electorate:{source:e.source,rosterKind:e.rosterKind??null,recordDate:e.recordDate===undefined?null:iso(e.recordDate),
        eligibleHeads:outcome.overall.eligibleHeads,eligibleWeight:outcome.overall.eligibleWeight,exclusions:e.exclusions},
      ballotsDigest,ballotsDigestVersion:3,
      outcome:{...outcome,proxies:{...outcome.proxies,revokedBeforeClose:revoked}},
      challenge:{windowEndsAt:windowEndsAt?.toISOString()??null,filed:0,categories:{},outcome:windowMs>0?"pending":"none"},
      sourceVersionAtOpen:row.base_version,sourceVersionAtClose:source.version,
      closedAt:at.toISOString(),executed:false,canAdopt:false,
    };
    let certificate,certificateDigest,finality;
    if(windowEndsAt){
      finality="provisional";
      certificate={...base,finality,application:"pending-finality",appliedVersion:null,appliedDigest:null,
        finalizedAt:null,previousCertificateDigest:null};
      certificateDigest=await recordCertificate(db,tenantId,row,finality,certificate,at);
    }else{
      finality="final";
      ({certificate,certificateDigest}=await finalizeWeighted(db,{tenantId,row,snapshot,base,actorId:actor.accountId,at,challengeOutcome:"none"}));
    }
    await db.query(
      "UPDATE dge_decisions.decisions SET state='closed',closed_at=$3,certificate=$4,certificate_digest=$5,finality=$6,challenge_closes_at=$7 WHERE tenant_id=$1 AND id=$2",
      [tenantId,row.id,at,certificate,certificateDigest,finality,windowEndsAt]);
    await activity(db,tenantId,row,actor.accountId,randomUUID(),digest("decision-closure-v2",{decisionId:row.id,certificateDigest}),
      {certificateDigest,ballotSalt},"closed",at);
    return {certificate,certificateDigest};
  }
  const challengeView=(c,{full})=>({id:c.id,reasonCategory:c.reason_category,status:c.status,createdAt:iso(c.created_at),
    resolvedAt:c.resolved_at?iso(c.resolved_at):null,...(full?{statement:c.statement,resolutionNote:c.resolution_note}:{})});
  return Object.freeze({
    async open(credentials,tenantId,documentId,proposalId,{hours,commandId,policySettings,...extra}) {
      ids(tenantId,documentId,proposalId);
      check(uuid(commandId)&&(extra.deadline!==undefined?hours===undefined:Number.isSafeInteger(hours)&&hours>=1&&hours<=720),"INVALID_VOTE_WINDOW");
      check(Object.keys(extra).every(key=>WEIGHTED_OPTIONS.includes(key)),"INVALID_DECISION_OPTIONS");
      const weighted=WEIGHTED_OPTIONS.some(key=>extra[key]!==undefined)||["classRequirements","tieRule","supportFloor"].some(key=>policySettings?.[key]!==undefined);
      if(weighted){
        const options=weightedOptions(proposalId,{...extra,policySettings});
        return identity.withTenant(credentials,tenantId,{roles:managerialRoles,write:true,recent:true},(db,actor)=>
          openWeighted(db,actor,{tenantId,documentId,proposalId,hours,commandId,options}));
      }
      let settings;try{settings=normalizeVotePolicySettings(policySettings);}catch{throw new DocumentError("INVALID_VOTE_POLICY",400);}
      return identity.withTenant(credentials,tenantId,{roles:managerialRoles,write:true,recent:true},async(db,actor)=>{
        const requestDigest=digest("decision-open-command-v1",{tenantId,documentId,proposalId,hours,actorId:actor.accountId,...(policySettings===undefined?{}:{policySettings:settings})});
        const prior=(await db.query(
          "SELECT * FROM dge_decisions.decisions WHERE tenant_id=$1 AND command_id=$2",
          [tenantId,commandId])).rows[0];
        if(prior){
          check(prior.request_digest===requestDigest,"COMMAND_REUSED",409);
          const votes=await rowsFor(db,tenantId,prior.id);
          return publicState(prior,votes,now(),actor.accountId);
        }
        const source=(await db.query(
          "SELECT version,current,digest FROM dge_documents.documents WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
          [tenantId,documentId])).rows[0];
        check(source,"DOCUMENT_NOT_FOUND",404);
        const proposal=(await db.query(
          "SELECT base_version,proposal,digest,created_at FROM dge_proposals.proposals WHERE tenant_id=$1 AND document_id=$2 AND id=$3",
          [tenantId,documentId,proposalId])).rows[0];
        check(proposal,"PROPOSAL_NOT_FOUND",404);
        check(textProposalDigest(proposal.proposal)===proposal.digest,"PROPOSAL_INTEGRITY_ERROR",503);
        check(source.version===proposal.base_version,"STALE_SOURCE_VERSION",409);
        check(!await proposalsInUse(db,tenantId,documentId,[proposalId]),"DECISION_ALREADY_EXISTS",409);
        const at=new Date(now()),decisionId=randomUUID(),publishedAt=new Date(proposal.created_at).getTime();
        const voters=(await db.query(
          "SELECT account_id FROM dge_identity.memberships WHERE tenant_id=$1 AND active=true AND role IN ('owner','admin','editor','participant') ORDER BY account_id",
          [tenantId])).rows.map(m=>({principalId:m.account_id}));
        const members=(await sectionVoters(db,{tenantId,documentId,baseVersion:source.version,
          blockIds:[proposal.proposal.selection.blockId],members:voters,at})).members.map(m=>({account_id:m.principalId}));
        check(members.length>0&&members.length<=maxElectors,"ELECTORATE_LIMIT_REACHED",429);
        check(BigInt(settings.minYes)<=BigInt(members.length)&&(settings.quorum.kind!=="count"||BigInt(settings.quorum.minimum)<=BigInt(members.length)),"UNATTAINABLE_VOTE_POLICY",400);
        check(Number.isSafeInteger(publishedAt)&&publishedAt>=0,"PROPOSAL_INTEGRITY_ERROR",503);
        const opensMs=policySettings===undefined?at.getTime():Math.max(at.getTime(),publishedAt+settings.minimumDeliberationHours*3600000),closeMs=opensMs+hours*3600000;
        check(Number.isSafeInteger(opensMs)&&Number.isSafeInteger(closeMs),"INVALID_VOTE_WINDOW");
        const snapshot=createGovernanceSnapshot({
          id:decisionId,tenantId,documentId,mode:source.current.mode,proposalDigest:proposal.digest,
          createdAt:at.getTime(),
          electorate:{id:"electorate-"+decisionId,kind:"frozen",members:members.map(m=>({principalId:m.account_id,weight:"1"}))},
          policy:{id:"policy-"+decisionId,weighting:"equal",allowEarlyClose:false,
            opensAt:opensMs,closesAt:closeMs,minYes:settings.minYes,
            quorum:settings.quorum,approval:settings.approval,
            ...(policySettings===undefined?{}:{minimumDeliberationHours:settings.minimumDeliberationHours,proposalPublishedAt:publishedAt})}
        });
        await db.query(
          "INSERT INTO dge_decisions.decisions(tenant_id,id,document_id,proposal_id,base_version,snapshot,snapshot_digest,created_by,created_at,closes_at,command_id,request_digest) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",
          [tenantId,decisionId,documentId,proposalId,proposal.base_version,snapshot,snapshot.snapshotDigest,actor.accountId,at,new Date(closeMs),commandId,requestDigest]
        );
        const row=await decision(db,tenantId,documentId,proposalId);
        const result=publicState(row,[],at.getTime(),actor.accountId);
        await activity(db,tenantId,row,actor.accountId,commandId,requestDigest,
          {snapshotDigest:snapshot.snapshotDigest},"opened",at);
        return result;
      });
    },
    async read(credentials,tenantId,documentId,proposalId){
      ids(tenantId,documentId,proposalId);
      return scoped(credentials,tenantId,allRoles,false,async(db,actor)=>{
        const row=await decision(db,tenantId,documentId,proposalId);
        if(isWeighted(row))return weightedState(db,row,now(),actor);
        const ballots=await rowsFor(db,tenantId,row.id);
        return publicState(row,ballots,now(),actor.accountId);
      });
    },
    async publicReceipt(documentId,proposalId){
      check(uuid(documentId)&&uuid(proposalId),"INVALID_DECISION_CONTEXT");
      check(typeof transaction==="function","DECISION_SERVICE_UNAVAILABLE",503);
      return transaction(async db=>{
        await db.query("SELECT set_config('dge.public_document_id',$1,true)",[documentId]);
        // Public RLS policy grants closed decisions only; no roster or ballots
        // are serialized. No session token or tenant membership required.
        const row=(await db.query(
          "SELECT certificate,certificate_digest FROM dge_decisions.decisions WHERE document_id=$1 AND proposal_id=$2 AND state='closed' ORDER BY finality IS NOT DISTINCT FROM 'void',created_at DESC,id LIMIT 1",
          [documentId,proposalId])).rows[0];
        check(row,"DECISION_RECEIPT_NOT_FOUND",404);
        const version=row.certificate?.schemaVersion===2?2:1;
        check(row.certificate?.documentId===documentId&&row.certificate?.proposalId===proposalId &&
          (version===2?weightedCertificateDigest(row.certificate):digest("governance-decision-certificate-v1",row.certificate))===row.certificate_digest,
          "DECISION_RECEIPT_CORRUPT",503);
        return {
          schemaVersion:version,documentId,proposalId,certificate:row.certificate,
          certificateDigest:row.certificate_digest,
          verification:"content-digest-only",
          externalAnchorVerified:false,
          legallyExecuted:false
        };
      });
    },
    async cast(credentials,tenantId,documentId,proposalId,{choice,expectedVersion,commandId,onBehalfOf}){
      ids(tenantId,documentId,proposalId);
      check(uuid(commandId)&&choices.includes(choice)&&Number.isSafeInteger(expectedVersion)&&
        expectedVersion>=0&&expectedVersion<maxVoteVersions&&(onBehalfOf===undefined||uuid(onBehalfOf)),"INVALID_BALLOT");
      return scoped(credentials,tenantId,votingRoles,true,async(db,actor)=>{
        const row=await decision(db,tenantId,documentId,proposalId,true);
        if(isWeighted(row))return castWeighted(db,actor,row,{choice,expectedVersion,commandId,onBehalfOf});
        check(onBehalfOf===undefined,"INVALID_BALLOT");
        const requestDigest=digest("decision-ballot-command-v1",{
          actorId:actor.accountId,decisionId:row.id,choice,expectedVersion
        });
        const prior=await priorEvent(db,tenantId,actor.accountId,commandId,requestDigest);
        if(prior)return prior;
        const snapshot=snapshotOf(row),at=new Date(now());
        check(row.state==="open","VOTE_CLOSED",409);
        check(at.getTime()>=snapshot.policy.opensAt&&at.getTime()<snapshot.policy.closesAt,
          "VOTE_WINDOW_CLOSED",409);
        check(snapshot.electorate.members.some(m=>m.principalId===actor.accountId),
          "NOT_IN_FROZEN_ELECTORATE",403);
        const previous=(await db.query(
          "SELECT version FROM dge_decisions.ballots WHERE tenant_id=$1 AND decision_id=$2 AND account_id=$3",
          [tenantId,row.id,actor.accountId])).rows[0];
        const version=previous?.version??0;
        check(version===expectedVersion,"BALLOT_VERSION_CONFLICT",409);
        check(version<maxVoteVersions,"BALLOT_CHANGE_LIMIT_REACHED",429);
        // The decision row lock serializes two writes and a concurrent close.
        await db.query(
          "INSERT INTO dge_decisions.ballots(tenant_id,decision_id,account_id,choice,version,cast_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(tenant_id,decision_id,account_id) DO UPDATE SET choice=excluded.choice,version=excluded.version,cast_at=excluded.cast_at",
          [tenantId,row.id,actor.accountId,choice,version+1,at]
        );
        const result={
          decisionId:row.id,choice,version:version+1,
          receiptDigest:digest("decision-ballot-receipt-v1",{
            decisionId:row.id,snapshotDigest:snapshot.snapshotDigest,
            actorId:actor.accountId,choice,version:version+1,castAt:at.toISOString()
          })
        };
        await activity(db,tenantId,row,actor.accountId,commandId,requestDigest,result,"ballot",at);
        return result;
      });
    },
    /**
     * DCE-010: the presiding principal named in the frozen policy records one
     * casting vote, only after voting ends, only on an exact yes/no tie and
     * before closure. It is immutable once written.
     */
    async castingVote(credentials,tenantId,documentId,proposalId,{choice,commandId}){
      ids(tenantId,documentId,proposalId);
      check(uuid(commandId)&&["yes","no"].includes(choice),"INVALID_CASTING_VOTE");
      return scoped(credentials,tenantId,allRoles,true,async(db,actor)=>{
        const row=await decision(db,tenantId,documentId,proposalId,true);
        check(isWeighted(row),"NO_TIE_RULE",409);
        const snapshot=weightedSnapshotOf(row),policy=snapshot.policy,at=new Date(now());
        check(policy.tieRule==="casting-vote","NO_TIE_RULE",409);
        check(policy.castingPrincipalId===actor.accountId,"NOT_CASTING_PRINCIPAL",403);
        const prior=(await db.query("SELECT principal_id,choice,command_id FROM dge_decisions.casting_votes WHERE tenant_id=$1 AND decision_id=$2",[tenantId,row.id])).rows[0];
        if(prior){
          check(prior.command_id===commandId&&prior.choice===choice,"CASTING_VOTE_ALREADY_RECORDED",409);
          return {recorded:true,choice:prior.choice};
        }
        check(row.state==="open","VOTE_CLOSED",409);
        check(at.getTime()>=policy.closesAt,"VOTE_STILL_OPEN",409);
        const direct=await rowsFor(db,tenantId,row.id),proxies=await proxyRowsFor(db,tenantId,row.id);
        const tally=evaluateWeightedDecision({mode:snapshot.mode,policy,electorate:snapshot.electorate,ballots:weightedBallots(direct,proxies,at),now:at.getTime()});
        check(tally.tie?.reason==="casting-vote-missing","NOT_A_TIE",409);
        await db.query("INSERT INTO dge_decisions.casting_votes(tenant_id,decision_id,principal_id,choice,command_id,recorded_at) VALUES($1,$2,$3,$4,$5,$6)",
          [tenantId,row.id,actor.accountId,choice,commandId,at]);
        await activity(db,tenantId,row,actor.accountId,commandId,digest("decision-casting-vote-v1",{decisionId:row.id,choice}),{choice},"casting-vote",at);
        return {recorded:true,choice};
      });
    },
    async close(credentials,tenantId,documentId,proposalId) {
      ids(tenantId,documentId,proposalId);
      return scoped(credentials,tenantId,managerialRoles,true,async(db,actor)=>{
        const row=await decision(db,tenantId,documentId,proposalId,true);
        if(isWeighted(row))return closeWeighted(db,actor,row);
        if(row.state==="closed")return {certificate:row.certificate,certificateDigest:row.certificate_digest};
        const snapshot=snapshotOf(row),at=new Date(now());
        check(at.getTime()>=snapshot.policy.closesAt,"VOTE_STILL_OPEN",409);
        const records=await rowsFor(db,tenantId,row.id);
        const outcome=evaluateGovernanceSnapshot(snapshot,ballotsFor(snapshot,records),at.getTime());
        // This lock serializes two passed amendments against the exact
        // same source. The decision lock above fences late ballot writers.
        const source=(await db.query(
          "SELECT version,current,digest FROM dge_documents.documents WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
          [tenantId,documentId])).rows[0];
        check(source,"DOCUMENT_NOT_FOUND",404);
        check(legalDocumentDigest(source.current)===source.digest,"DOCUMENT_INTEGRITY_ERROR",503);
        const sourceIsCurrent=row.base_version===source.version;
        // Do not publish an unsalted hash of a small electorate: known
        // member IDs and a handful of possible votes make brute-force recovery
        // feasible. The 256-bit audit salt remains only in a tenant-private
        // immutable closure event, never inside the public certificate.
        const ballotSalt=randomBytes(32).toString("hex");
        const ballotsDigest=digest("frozen-decision-ballots-v2",{
          salt:ballotSalt,
          ballots:records.map(r=>({
            accountId:r.account_id,choice:r.choice,version:r.version,
            castAt:new Date(r.cast_at).toISOString()
          }))
        });
        let application="not-passed",appliedVersion=null,appliedDigest=null;
        if(snapshot.mode==="public-input")application="advisory";
        else if(outcome.status==="passed"){
          if(!sourceIsCurrent||source.current.mode!=="collaboration"||source.current.lifecycle!=="draft"){
            application="stale-source";
          }else{
            const proposal=(await db.query(
              "SELECT proposal,digest FROM dge_proposals.proposals WHERE tenant_id=$1 AND document_id=$2 AND id=$3",
              [tenantId,documentId,proposalId])).rows[0];
            check(proposal&&proposal.digest===snapshot.proposalDigest &&
              textProposalDigest(proposal.proposal)===proposal.digest,
              "PROPOSAL_INTEGRITY_ERROR",503);
            // The pure transformer checks the exact source digest, selected
            // text, quote and surrounding context. Never silently rebase.
            const requestDigest=digest("public-document-command-v1",{
              action:"auto-adopt-frozen-decision",decisionId:row.id,
              sourceVersion:source.version,proposalDigest:snapshot.proposalDigest
            });
            ({appliedVersion,appliedDigest}=await applyToDraft(db,{tenantId,documentId,decisionId:row.id,source,
              proposals:[proposal.proposal],actorId:actor.accountId,at,requestDigest,
              amend:(current,[text])=>{
                try{return applyTextProposal(current,text);}
                catch{throw new DocumentError("ADOPTION_CONFLICT",409);}
              }}));
            application="applied-to-public-draft";
          }
        }
        const certificate={
          schemaVersion:1,tenantId,documentId,proposalId,decisionId:row.id,snapshotDigest:snapshot.snapshotDigest,
          proposalDigest:snapshot.proposalDigest,ballotsDigest,ballotsDigestVersion:2,
          outcome:{status:outcome.status,quorumMet:outcome.quorumMet,approvalMet:outcome.approvalMet,
            counts:outcome.counts,weights:outcome.weights},
          sourceVersionAtOpen:row.base_version,sourceVersionAtClose:source.version,
          sourceIsCurrent,application,appliedVersion,appliedDigest,
          closedAt:at.toISOString(),executed:false,canAdopt:false,
          kind:"governance-decision-record-not-execution"
        };
        const certificateDigest=digest("governance-decision-certificate-v1",certificate);
        await db.query(
          "UPDATE dge_decisions.decisions SET state='closed',closed_at=$3,certificate=$4,certificate_digest=$5,finality='final' WHERE tenant_id=$1 AND id=$2",
          [tenantId,row.id,at,certificate,certificateDigest]
        );
        const requestDigest=digest("decision-closure-v1",{decisionId:row.id,certificateDigest});
        await activity(db,tenantId,row,actor.accountId,randomUUID(),requestDigest,
          {certificateDigest,ballotSalt},"closed",at);
        return {certificate,certificateDigest};
      });
    },
    /** Any member of the frozen electorate may challenge during the window. */
    async challenge(credentials,tenantId,documentId,proposalId,{reasonCategory,statement,commandId}){
      ids(tenantId,documentId,proposalId);
      check(uuid(commandId)&&CHALLENGE_CATEGORIES.includes(reasonCategory)&&typeof statement==="string"&&
        statement.trim().length>=1&&statement.length<=2000&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(statement),"INVALID_CHALLENGE");
      return scoped(credentials,tenantId,allRoles,true,async(db,actor)=>{
        const row=await decision(db,tenantId,documentId,proposalId,true);
        const requestDigest=digest("decision-challenge-command-v1",{decisionId:row.id,actorId:actor.accountId,reasonCategory,statement});
        const prior=(await db.query("SELECT * FROM dge_electorates.challenges WHERE tenant_id=$1 AND challenger_id=$2 AND command_id=$3",
          [tenantId,actor.accountId,commandId])).rows[0];
        if(prior){
          check(prior.request_digest===requestDigest,"COMMAND_REUSED",409);
          return challengeView(prior,{full:true});
        }
        check(isWeighted(row),"CHALLENGE_NOT_AVAILABLE",409);
        const snapshot=weightedSnapshotOf(row),at=new Date(now());
        const finality=finalityOf(row);
        check(["provisional","held"].includes(finality)&&at<new Date(row.challenge_closes_at),"CHALLENGE_WINDOW_CLOSED",409);
        check(snapshot.electorate.members.some(m=>m.principalId===actor.accountId),"NOT_IN_FROZEN_ELECTORATE",403);
        const counts=(await db.query("SELECT count(*)::int AS total,count(*) FILTER (WHERE challenger_id=$3)::int AS own FROM dge_electorates.challenges WHERE tenant_id=$1 AND decision_id=$2",
          [tenantId,row.id,actor.accountId])).rows[0];
        check(counts.own<maxChallengesPerVoter&&counts.total<maxChallenges,"CHALLENGE_LIMIT_REACHED",429);
        const id=randomUUID();
        await db.query("INSERT INTO dge_electorates.challenges(tenant_id,id,decision_id,challenger_id,reason_category,statement,created_at,command_id,request_digest) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
          [tenantId,id,row.id,actor.accountId,reasonCategory,statement,at,commandId,requestDigest]);
        if(finality!=="held")await db.query("UPDATE dge_decisions.decisions SET finality='held' WHERE tenant_id=$1 AND id=$2",[tenantId,row.id]);
        await activity(db,tenantId,row,actor.accountId,randomUUID(),requestDigest,{challengeId:id,reasonCategory},"challenged",at);
        return challengeView({id,reason_category:reasonCategory,status:"pending",created_at:at,resolved_at:null,statement,resolution_note:null},{full:true});
      });
    },
    async listChallenges(credentials,tenantId,documentId,proposalId){
      ids(tenantId,documentId,proposalId);
      return scoped(credentials,tenantId,allRoles,false,async(db,actor)=>{
        const row=await decision(db,tenantId,documentId,proposalId);
        const rows=(await db.query("SELECT * FROM dge_electorates.challenges WHERE tenant_id=$1 AND decision_id=$2 ORDER BY created_at,id",[tenantId,row.id])).rows;
        const manager=managerialRoles.includes(actor.role);
        return {finality:finalityOf(row),challengeClosesAt:row.challenge_closes_at?iso(row.challenge_closes_at):null,
          items:rows.map(c=>({...challengeView(c,{full:manager||c.challenger_id===actor.accountId}),mine:c.challenger_id===actor.accountId}))};
      });
    },
    /** Managers dismiss (towards final) or uphold (void, never resumable). */
    async resolveChallenge(credentials,tenantId,documentId,proposalId,challengeId,{resolution,note=null,commandId}){
      ids(tenantId,documentId,proposalId);
      check(uuid(challengeId)&&uuid(commandId)&&["dismiss","uphold"].includes(resolution)&&
        (note===null||(typeof note==="string"&&note.trim().length>=1&&note.length<=1000)),"INVALID_CHALLENGE_RESOLUTION");
      return identity.withTenant(credentials,tenantId,{roles:managerialRoles,write:true,recent:true},async(db,actor)=>{
        const row=await decision(db,tenantId,documentId,proposalId,true);
        const requestDigest=digest("decision-challenge-resolution-v1",{decisionId:row.id,challengeId,resolution,note});
        const prior=await priorEvent(db,tenantId,actor.accountId,commandId,requestDigest);
        if(prior)return prior;
        const challenge=(await db.query("SELECT * FROM dge_electorates.challenges WHERE tenant_id=$1 AND id=$2 FOR UPDATE",[tenantId,challengeId])).rows[0];
        check(challenge&&challenge.decision_id===row.id,"CHALLENGE_NOT_FOUND",404);
        check(challenge.status==="pending","CHALLENGE_ALREADY_RESOLVED",409);
        check(challenge.challenger_id!==actor.accountId,"CHALLENGER_CANNOT_RESOLVE",403);
        check(finalityOf(row)==="held","DECISION_NOT_HELD",409);
        const at=new Date(now()),status=resolution==="dismiss"?"dismissed":"upheld";
        await db.query("UPDATE dge_electorates.challenges SET status=$3,resolved_by=$4,resolved_at=$5,resolution_note=$6 WHERE tenant_id=$1 AND id=$2",
          [tenantId,challengeId,status,actor.accountId,at,note]);
        await appendLedgerEvent(db,{tenantId,kind:"decision-challenge-resolution",subjectId:row.id,at,
          eventDigest:digest("decision-challenge-resolution-event-v1",{decisionId:row.id,challengeId,status,at:at.toISOString()})});
        let finality,certificateDigest=row.certificate_digest;
        if(status==="upheld"){
          await db.query("UPDATE dge_electorates.challenges SET status='moot',resolved_by=$3,resolved_at=$4 WHERE tenant_id=$1 AND decision_id=$2 AND status='pending'",
            [tenantId,row.id,actor.accountId,at]);
          finality="void";
          const certificate={...row.certificate,finality,
            challenge:await challengeSummary(db,tenantId,row.id,row.certificate.challenge.windowEndsAt,"upheld"),
            application:"void-not-applied",appliedVersion:null,appliedDigest:null,
            finalizedAt:at.toISOString(),previousCertificateDigest:row.certificate_digest};
          certificateDigest=await recordCertificate(db,tenantId,row,finality,certificate,at);
          await db.query("UPDATE dge_decisions.decisions SET finality='void',certificate=$3,certificate_digest=$4 WHERE tenant_id=$1 AND id=$2",
            [tenantId,row.id,certificate,certificateDigest]);
        }else{
          const pending=(await db.query("SELECT count(*)::int AS n FROM dge_electorates.challenges WHERE tenant_id=$1 AND decision_id=$2 AND status='pending'",[tenantId,row.id])).rows[0].n;
          if(pending>0)finality="held";
          else if(at>=new Date(row.challenge_closes_at)){
            const snapshot=weightedSnapshotOf(row);
            const done=await finalizeWeighted(db,{tenantId,row,snapshot,base:row.certificate,actorId:actor.accountId,at,challengeOutcome:"dismissed"});
            finality="final";certificateDigest=done.certificateDigest;
            await db.query("UPDATE dge_decisions.decisions SET finality='final',certificate=$3,certificate_digest=$4 WHERE tenant_id=$1 AND id=$2",
              [tenantId,row.id,done.certificate,done.certificateDigest]);
          }else{
            finality="provisional";
            await db.query("UPDATE dge_decisions.decisions SET finality='provisional' WHERE tenant_id=$1 AND id=$2",[tenantId,row.id]);
          }
        }
        const result={challengeId,status,finality,certificateDigest};
        await activity(db,tenantId,row,actor.accountId,commandId,requestDigest,result,"challenge-resolved",at);
        return result;
      });
    },
    /** After an unchallenged (or fully dismissed) window, make the result final. */
    async finalize(credentials,tenantId,documentId,proposalId){
      ids(tenantId,documentId,proposalId);
      return scoped(credentials,tenantId,managerialRoles,true,async(db,actor)=>{
        const row=await decision(db,tenantId,documentId,proposalId,true);
        const finality=finalityOf(row);
        check(row.state==="closed","VOTE_STILL_OPEN",409);
        if(finality==="final")return {certificate:row.certificate,certificateDigest:row.certificate_digest};
        check(finality!=="void","DECISION_VOID",409);
        check(finality!=="held","CHALLENGE_PENDING",409);
        const at=new Date(now());
        check(at>=new Date(row.challenge_closes_at),"CHALLENGE_WINDOW_OPEN",409);
        const dismissed=(await db.query("SELECT 1 FROM dge_electorates.challenges WHERE tenant_id=$1 AND decision_id=$2 AND status='dismissed' LIMIT 1",[tenantId,row.id])).rows.length;
        const done=await finalizeWeighted(db,{tenantId,row,snapshot:weightedSnapshotOf(row),base:row.certificate,
          actorId:actor.accountId,at,challengeOutcome:dismissed?"dismissed":"none"});
        await db.query("UPDATE dge_decisions.decisions SET finality='final',certificate=$3,certificate_digest=$4 WHERE tenant_id=$1 AND id=$2",
          [tenantId,row.id,done.certificate,done.certificateDigest]);
        await activity(db,tenantId,row,actor.accountId,randomUUID(),digest("decision-finalization-v1",{decisionId:row.id,certificateDigest:done.certificateDigest}),
          {certificateDigest:done.certificateDigest},"finalized",at);
        return done;
      });
    },
  });
}
