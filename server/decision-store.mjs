import {randomUUID,randomBytes} from "node:crypto";
import {digest} from "../src/integrity.mjs";
import {
  createGovernanceSnapshot, validateGovernanceSnapshot,
  ballotForGovernanceSnapshot, evaluateGovernanceSnapshot,
} from "../src/governance-snapshots.mjs";
import {textProposalDigest,applyTextProposal} from "../src/legal-proposals.mjs";
import {legalDocumentDigest} from "../src/legal-schema.mjs";
import {DocumentError} from "./document-store.mjs";

const uuid = value => typeof value === "string" &&
  /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
const check = (condition, code, status=400) => {
  if (!condition) throw new DocumentError(code,status);
};
const votingRoles=["owner","admin","editor","participant"];
const managerialRoles=["owner","admin"];
const choices=["yes","no","abstain"];
const rowsFor = async(db,tenantId,decisionId) =>
  (await db.query("SELECT account_id,choice,cast_at,version FROM dge_decisions.ballots WHERE tenant_id=$1 AND decision_id=$2 ORDER BY account_id",
    [tenantId,decisionId])).rows;
const ballotsFor = (snapshot, rows) =>
  rows.map(row => ballotForGovernanceSnapshot(snapshot,row.account_id,row.choice,new Date(row.cast_at).getTime()));
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
    rule:{quorum:"At least half of the frozen electorate",approval:"Strict majority of yes/no votes",minYes:1},
    state:row.state,
    outcome:{
      status:row.state==="closed" ? result.status : clock>=snapshot.policy.closesAt ? "awaiting-closure" : "open",
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

/** Scoped governance ledger: exact-version votes with frozen workspace electorate.
 * This is not a statutory signature, an enacted law or an executed resolution.
 */
export function createDecisionStore({
  identity,transaction,clock=Date.now,maxElectors=1000,maxVoteVersions=50,
}={}) {
  check(identity && typeof identity.withTenant==="function" && typeof clock==="function",
    "DECISION_STORE_CONFIG");
  check(Number.isSafeInteger(maxElectors)&&maxElectors>0&&maxElectors<=100000 &&
    Number.isSafeInteger(maxVoteVersions)&&maxVoteVersions>0&&maxVoteVersions<=100,"DECISION_STORE_CONFIG");
  const now=()=>{
    const ms=clock();
    check(Number.isSafeInteger(ms)&&ms>=0,"CLOCK_UNAVAILABLE",503);
    return ms;
  };
  const ids=(tenantId,documentId,proposalId) =>
    check(uuid(tenantId)&&uuid(documentId)&&uuid(proposalId),"INVALID_DECISION_CONTEXT");
  async function decision(db,tenantId,documentId,proposalId,lock=false) {
    const row=(await db.query(
      "SELECT * FROM dge_decisions.decisions WHERE tenant_id=$1 AND document_id=$2 AND proposal_id=$3" +
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
  return Object.freeze({
    async open(credentials,tenantId,documentId,proposalId,{hours,commandId}) {
      ids(tenantId,documentId,proposalId);
      check(uuid(commandId)&&Number.isSafeInteger(hours)&&hours>=1&&hours<=720,"INVALID_VOTE_WINDOW");
      return scoped(credentials,tenantId,managerialRoles,true,async(db,actor)=>{
        const requestDigest=digest("decision-open-command-v1",{tenantId,documentId,proposalId,hours,actorId:actor.accountId});
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
          "SELECT base_version,proposal,digest FROM dge_proposals.proposals WHERE tenant_id=$1 AND document_id=$2 AND id=$3",
          [tenantId,documentId,proposalId])).rows[0];
        check(proposal,"PROPOSAL_NOT_FOUND",404);
        check(textProposalDigest(proposal.proposal)===proposal.digest,"PROPOSAL_INTEGRITY_ERROR",503);
        check(source.version===proposal.base_version,"STALE_SOURCE_VERSION",409);
        const existing=(await db.query(
          "SELECT id FROM dge_decisions.decisions WHERE tenant_id=$1 AND document_id=$2 AND proposal_id=$3",
          [tenantId,documentId,proposalId])).rows[0];
        check(!existing,"DECISION_ALREADY_EXISTS",409);
        const members=(await db.query(
          "SELECT account_id FROM dge_identity.memberships WHERE tenant_id=$1 AND active=true AND role IN ('owner','admin','editor','participant') ORDER BY account_id",
          [tenantId])).rows;
        check(members.length>0&&members.length<=maxElectors,"ELECTORATE_LIMIT_REACHED",429);
        const at=new Date(now()),decisionId=randomUUID(),closeMs=at.getTime()+hours*3600000;
        const snapshot=createGovernanceSnapshot({
          id:decisionId,tenantId,documentId,mode:source.current.mode,proposalDigest:proposal.digest,
          createdAt:at.getTime(),
          electorate:{id:"electorate-"+decisionId,kind:"frozen",members:members.map(m=>({principalId:m.account_id,weight:"1"}))},
          policy:{id:"policy-"+decisionId,weighting:"equal",allowEarlyClose:false,
            opensAt:at.getTime(),closesAt:closeMs,minYes:"1",
            quorum:{kind:"fraction-count",numerator:"1",denominator:"2"},
            approval:{basis:"decisive",comparison:"gt",numerator:"1",denominator:"2"}}
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
      return scoped(credentials,tenantId,["owner","admin","editor","participant","viewer"],false,async(db,actor)=>{
        const row=await decision(db,tenantId,documentId,proposalId);
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
          "SELECT certificate,certificate_digest FROM dge_decisions.decisions WHERE document_id=$1 AND proposal_id=$2 AND state='closed'",
          [documentId,proposalId])).rows[0];
        check(row,"DECISION_RECEIPT_NOT_FOUND",404);
        check(row.certificate?.documentId===documentId&&row.certificate?.proposalId===proposalId &&
          digest("governance-decision-certificate-v1",row.certificate)===row.certificate_digest,
          "DECISION_RECEIPT_CORRUPT",503);
        return {
          schemaVersion:1,documentId,proposalId,certificate:row.certificate,
          certificateDigest:row.certificate_digest,
          verification:"content-digest-only",
          externalAnchorVerified:false,
          legallyExecuted:false
        };
      });
    },
    async cast(credentials,tenantId,documentId,proposalId,{choice,expectedVersion,commandId}){
      ids(tenantId,documentId,proposalId);
      check(uuid(commandId)&&choices.includes(choice)&&Number.isSafeInteger(expectedVersion)&&
        expectedVersion>=0&&expectedVersion<maxVoteVersions,"INVALID_BALLOT");
      return scoped(credentials,tenantId,votingRoles,true,async(db,actor)=>{
        const row=await decision(db,tenantId,documentId,proposalId,true);
        const requestDigest=digest("decision-ballot-command-v1",{
          actorId:actor.accountId,decisionId:row.id,choice,expectedVersion
        });
        const prior=(await db.query(
          "SELECT result,request_digest FROM dge_decisions.events WHERE tenant_id=$1 AND actor_id=$2 AND command_id=$3",
          [tenantId,actor.accountId,commandId])).rows[0];
        if(prior){
          check(prior.request_digest===requestDigest,"COMMAND_REUSED",409);
          return prior.result;
        }
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
    async close(credentials,tenantId,documentId,proposalId) {
      ids(tenantId,documentId,proposalId);
      return scoped(credentials,tenantId,managerialRoles,true,async(db,actor)=>{
        const row=await decision(db,tenantId,documentId,proposalId,true);
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
            check(source.version<1000000,"VERSION_LIMIT_REACHED",429);
            const proposal=(await db.query(
              "SELECT proposal,digest FROM dge_proposals.proposals WHERE tenant_id=$1 AND document_id=$2 AND id=$3",
              [tenantId,documentId,proposalId])).rows[0];
            check(proposal&&proposal.digest===snapshot.proposalDigest &&
              textProposalDigest(proposal.proposal)===proposal.digest,
              "PROPOSAL_INTEGRITY_ERROR",503);
            // The pure transformer checks the exact source digest, selected
            // text, quote and surrounding context. Never silently rebase.
            let amended;
            try{amended=applyTextProposal(source.current,proposal.proposal);}
            catch{throw new DocumentError("ADOPTION_CONFLICT",409);}
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
            const requestDigest=digest("public-document-command-v1",{
              action:"auto-adopt-frozen-decision",decisionId:row.id,
              sourceVersion:source.version,proposalDigest:snapshot.proposalDigest
            });
            await db.query(
              "UPDATE dge_documents.documents SET current=$3,version=$4,digest=$5 WHERE tenant_id=$1 AND id=$2",
              [tenantId,documentId,amended,nextVersion,newDigest]
            );
            await db.query(
              "INSERT INTO dge_documents.versions(tenant_id,document_id,version,document,digest,previous_digest,event_digest,command_id,request_digest,actor_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
              [tenantId,documentId,nextVersion,amended,newDigest,source.digest,eventDigest,row.id,requestDigest,actor.accountId,at]
            );
            await db.query(
              "INSERT INTO dge_documents.anchor_outbox(tenant_id,document_id,version,event_digest,created_at) VALUES($1,$2,$3,$4,$5)",
              [tenantId,documentId,nextVersion,eventDigest,at]
            );
            application="applied-to-public-draft";
            appliedVersion=nextVersion;
            appliedDigest=newDigest;
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
          "UPDATE dge_decisions.decisions SET state='closed',closed_at=$3,certificate=$4,certificate_digest=$5 WHERE tenant_id=$1 AND id=$2",
          [tenantId,row.id,at,certificate,certificateDigest]
        );
        const requestDigest=digest("decision-closure-v1",{decisionId:row.id,certificateDigest});
        await activity(db,tenantId,row,actor.accountId,randomUUID(),requestDigest,
          {certificateDigest,ballotSalt},"closed",at);
        return {certificate,certificateDigest};
      });
    },
  });
}
