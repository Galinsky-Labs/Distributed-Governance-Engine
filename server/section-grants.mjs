import {randomUUID} from "node:crypto";
import {digest} from "../src/integrity.mjs";
import {CLASS_PATTERN} from "../src/weighted-governance.mjs";
import {legalDocumentDigest} from "../src/legal-schema.mjs";
import {currentHoldings} from "./electorate-store.mjs";
import {DocumentError} from "./document-store.mjs";

const UUID=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const NODE_ID=/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
const uuid=value=>typeof value==="string"&&UUID.test(value);
const check=(condition,code,status=400)=>{if(!condition)throw new DocumentError(code,status);};
export const SECTION_RIGHTS=Object.freeze(["read","propose","discuss","vote","sign"]);
const ROLES=["owner","admin","editor","participant","viewer"];
const managers=["owner","admin"];
const iso=value=>new Date(value).toISOString();

/** Ancestor path [documentId, …containers…, nodeId] of a node, or null. */
export function targetPath(document,nodeId){
  if(nodeId===document.id)return [document.id];
  const walk=(nodes,trail)=>{
    for(const node of nodes){
      if(node.id===nodeId)return [...trail,node.id];
      if(node.children){const found=walk(node.children,[...trail,node.id]);if(found)return found;}
    }
    return null;
  };
  return walk(document.content,[document.id]);
}
function sectionNode(document,nodeId){
  if(nodeId===document.id)return true;
  const walk=nodes=>nodes.some(n=>(n.id===nodeId&&["section","exhibit"].includes(n.kind))||(n.children&&walk(n.children)));
  return walk(document.content);
}

/**
 * Effective clause rights for a document at an instant. An unrestricted
 * document grants every right (ordinary workspace roles still apply). A
 * restricted document denies by default; an allow grant on a section is
 * inherited by everything nested inside it, and a deny on any ancestor
 * overrides every allow below it. Expired and revoked grants are ignored,
 * so an expired unlock falls back to deny rather than to openness.
 */
export async function sectionAccess(db,{tenantId,documentId,at}){
  const access=(await db.query("SELECT restricted FROM dge_moderation.section_access WHERE tenant_id=$1 AND document_id=$2",[tenantId,documentId])).rows[0];
  if(!access?.restricted)return Object.freeze({restricted:false,holds:()=>true,rightsAt:()=>[...SECTION_RIGHTS]});
  const grants=(await db.query(
    "SELECT section_id,grantee_kind,grantee_role,grantee_account,grantee_roster,grantee_class,rights,effect FROM dge_moderation.section_grants WHERE tenant_id=$1 AND document_id=$2 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>$3)",
    [tenantId,documentId,at])).rows;
  const rosterIds=[...new Set(grants.filter(g=>g.grantee_kind==="roster-class").map(g=>g.grantee_roster))];
  const holdings=rosterIds.length?await currentHoldings(db,tenantId,rosterIds,at):new Map();
  const matches=(g,principal)=>g.grantee_kind==="role"?g.grantee_role===principal.role:
    g.grantee_kind==="account"?g.grantee_account===principal.accountId:
    Object.hasOwn(holdings.get(g.grantee_roster+":"+principal.accountId)??{},g.grantee_class);
  const holds=(principal,path,right)=>{
    const relevant=grants.filter(g=>path.includes(g.section_id)&&g.rights.includes(right)&&matches(g,principal));
    return relevant.some(g=>g.effect==="allow")&&!relevant.some(g=>g.effect==="deny");
  };
  return Object.freeze({restricted:true,holds,rightsAt:(principal,path)=>SECTION_RIGHTS.filter(r=>holds(principal,path,r))});
}

/** Base-edition document a proposal targets, integrity checked. */
export async function proposalBase(db,{tenantId,documentId,proposalId}){
  const row=(await db.query(
    `SELECT p.proposal,v.document,v.digest FROM dge_proposals.proposals p JOIN dge_documents.versions v
      ON v.tenant_id=p.tenant_id AND v.document_id=p.document_id AND v.version=p.base_version
     WHERE p.tenant_id=$1 AND p.document_id=$2 AND p.id=$3`,[tenantId,documentId,proposalId])).rows[0];
  check(row,"PROPOSAL_NOT_FOUND",404);
  check(legalDocumentDigest(row.document)===row.digest,"DOCUMENT_INTEGRITY_ERROR",503);
  return {proposal:row.proposal,document:row.document};
}

/** Throws SECTION_RIGHT_REQUIRED unless the actor holds `right` on the target. */
export async function requireSectionRight(db,{tenantId,documentId,document,blockId,actor,right,at}){
  const access=await sectionAccess(db,{tenantId,documentId,at});
  if(!access.restricted)return;
  const path=targetPath(document,blockId);
  check(path&&access.holds(actor,path,right),"SECTION_RIGHT_REQUIRED",403);
}

const granteeOf=(value)=>{
  check(value&&typeof value==="object"&&!Array.isArray(value),"INVALID_SECTION_GRANTEE");
  if(value.kind==="role"){
    check(Object.keys(value).sort().join(",")==="kind,role"&&ROLES.includes(value.role),"INVALID_SECTION_GRANTEE");
    return {kind:"role",role:value.role};
  }
  if(value.kind==="account"){
    check(Object.keys(value).sort().join(",")==="accountId,kind"&&uuid(value.accountId),"INVALID_SECTION_GRANTEE");
    return {kind:"account",accountId:value.accountId};
  }
  check(value.kind==="roster-class"&&Object.keys(value).sort().join(",")==="class,kind,rosterId"&&uuid(value.rosterId)&&
    typeof value.class==="string"&&CLASS_PATTERN.test(value.class),"INVALID_SECTION_GRANTEE");
  return {kind:"roster-class",rosterId:value.rosterId,class:value.class};
};
const grantView=g=>({id:g.id,sectionId:g.section_id,
  grantee:g.grantee_kind==="role"?{kind:"role",role:g.grantee_role}:g.grantee_kind==="account"?{kind:"account",accountId:g.grantee_account}:
    {kind:"roster-class",rosterId:g.grantee_roster,class:g.grantee_class},
  rights:g.rights,effect:g.effect,expiresAt:g.expires_at===null?null:iso(g.expires_at),createdAt:iso(g.created_at),
  revokedAt:g.revoked_at===null?null:iso(g.revoked_at)});

/** Clause-level grants (DCE-018). Managers administer; everyone is subject. */
export function createSectionGrantStore({identity,clock=Date.now,maxGrantsPerDocument=500}={}){
  check(identity&&typeof identity.withTenant==="function"&&typeof clock==="function"&&
    Number.isSafeInteger(maxGrantsPerDocument)&&maxGrantsPerDocument>0&&maxGrantsPerDocument<=100000,"SECTION_GRANT_CONFIG");
  const now=()=>{const ms=clock();check(Number.isSafeInteger(ms)&&ms>=0,"CLOCK_UNAVAILABLE",503);return new Date(ms);};
  const ids=(tenantId,documentId)=>check(uuid(tenantId)&&uuid(documentId),"INVALID_DOCUMENT_CONTEXT");
  async function current(db,tenantId,documentId){
    const row=(await db.query("SELECT current,digest FROM dge_documents.documents WHERE tenant_id=$1 AND id=$2 FOR UPDATE",[tenantId,documentId])).rows[0];
    check(row,"DOCUMENT_NOT_FOUND",404);
    check(legalDocumentDigest(row.current)===row.digest,"DOCUMENT_INTEGRITY_ERROR",503);
    return row.current;
  }
  async function replay(db,tenantId,actorId,commandId,requestDigest){
    const prior=(await db.query("SELECT request_digest,result FROM dge_moderation.access_events WHERE tenant_id=$1 AND actor_id=$2 AND command_id=$3",[tenantId,actorId,commandId])).rows[0];
    if(!prior)return undefined;
    check(prior.request_digest===requestDigest,"COMMAND_REUSED",409);
    return prior.result;
  }
  async function audit(db,{tenantId,documentId,actorId,kind,subjectId=null,commandId,requestDigest,result,at}){
    const id=randomUUID();
    await db.query("INSERT INTO dge_moderation.access_events(tenant_id,id,document_id,actor_id,kind,subject_id,command_id,request_digest,result,event_digest,occurred_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
      [tenantId,id,documentId,actorId,kind,subjectId,commandId,requestDigest,result,
        digest("section-access-event-v1",{id,tenantId,documentId,kind,subjectId,requestDigest,at:iso(at)}),at]);
  }
  async function setAccess(db,tenantId,documentId,restricted,actorId,at){
    const row=(await db.query("SELECT restricted,version FROM dge_moderation.section_access WHERE tenant_id=$1 AND document_id=$2 FOR UPDATE",[tenantId,documentId])).rows[0];
    if(!row){
      await db.query("INSERT INTO dge_moderation.section_access(tenant_id,document_id,restricted,version,updated_by,updated_at) VALUES($1,$2,$3,1,$4,$5)",[tenantId,documentId,restricted,actorId,at]);
      return 1;
    }
    if(row.restricted===restricted)return row.version;
    await db.query("UPDATE dge_moderation.section_access SET restricted=$3,version=version+1,updated_by=$4,updated_at=$5 WHERE tenant_id=$1 AND document_id=$2",[tenantId,documentId,restricted,actorId,at]);
    return row.version+1;
  }
  return Object.freeze({
    /** Managers see every grant; other members see only their own effective rights. */
    async list(credentials,tenantId,documentId){
      ids(tenantId,documentId);
      return identity.withTenant(credentials,tenantId,{},async(db,actor)=>{
        const doc=(await db.query("SELECT current FROM dge_documents.documents WHERE tenant_id=$1 AND id=$2",[tenantId,documentId])).rows[0];
        check(doc,"DOCUMENT_NOT_FOUND",404);
        const at=now();
        const state=(await db.query("SELECT restricted,version FROM dge_moderation.section_access WHERE tenant_id=$1 AND document_id=$2",[tenantId,documentId])).rows[0];
        const access=await sectionAccess(db,{tenantId,documentId,at});
        const sections=[doc.current.id];
        const collect=nodes=>{for(const n of nodes){if(["section","exhibit"].includes(n.kind))sections.push(n.id);if(n.children)collect(n.children);}};
        collect(doc.current.content);
        const mine=sections.map(sectionId=>({sectionId,rights:access.rightsAt(actor,targetPath(doc.current,sectionId))}));
        const base={restricted:state?.restricted??false,version:state?.version??0,mine};
        if(!managers.includes(actor.role))return base;
        const grants=(await db.query("SELECT * FROM dge_moderation.section_grants WHERE tenant_id=$1 AND document_id=$2 ORDER BY created_at,id",[tenantId,documentId])).rows;
        return {...base,grants:grants.map(grantView)};
      });
    },
    async grant(credentials,tenantId,documentId,{sectionId,grantee,rights,effect="allow",expiresAt=null,commandId}){
      ids(tenantId,documentId);
      check(uuid(commandId)&&typeof sectionId==="string"&&NODE_ID.test(sectionId)&&["allow","deny"].includes(effect)&&
        Array.isArray(rights)&&rights.length>=1&&rights.length<=5&&new Set(rights).size===rights.length&&
        rights.every(r=>SECTION_RIGHTS.includes(r)),"INVALID_SECTION_GRANT");
      const who=granteeOf(grantee);
      const ordered=SECTION_RIGHTS.filter(r=>rights.includes(r));
      let expires=null;
      if(expiresAt!==null){
        check(typeof expiresAt==="string"&&Number.isSafeInteger(Date.parse(expiresAt))&&iso(Date.parse(expiresAt))===expiresAt,"INVALID_SECTION_GRANT");
        expires=new Date(expiresAt);
      }
      return identity.withTenant(credentials,tenantId,{write:true,recent:true,roles:managers},async(db,actor)=>{
        const requestDigest=digest("section-grant-command-v1",{documentId,sectionId,grantee:who,rights:ordered,effect,expiresAt});
        const prior=await replay(db,tenantId,actor.accountId,commandId,requestDigest);
        if(prior)return prior;
        const doc=await current(db,tenantId,documentId),at=now();
        check(sectionNode(doc,sectionId),"SECTION_NOT_FOUND",404);
        check(expires===null||expires>at,"INVALID_SECTION_GRANT");
        if(who.kind==="account")check((await db.query("SELECT 1 FROM dge_identity.memberships WHERE tenant_id=$1 AND account_id=$2",[tenantId,who.accountId])).rows.length,"GRANTEE_NOT_IN_WORKSPACE",409);
        if(who.kind==="roster-class")check((await db.query("SELECT 1 FROM dge_electorates.rosters WHERE tenant_id=$1 AND id=$2",[tenantId,who.rosterId])).rows.length,"ROSTER_NOT_FOUND",404);
        const count=(await db.query("SELECT count(*)::int AS n FROM dge_moderation.section_grants WHERE tenant_id=$1 AND document_id=$2",[tenantId,documentId])).rows[0].n;
        check(count<maxGrantsPerDocument,"SECTION_GRANT_LIMIT_REACHED",429);
        const id=randomUUID();
        // The first grant restricts the document; deny-by-default starts now.
        const version=await setAccess(db,tenantId,documentId,true,actor.accountId,at);
        await db.query("INSERT INTO dge_moderation.section_grants(tenant_id,id,document_id,section_id,grantee_kind,grantee_role,grantee_account,grantee_roster,grantee_class,rights,effect,expires_at,created_by,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)",
          [tenantId,id,documentId,sectionId,who.kind,who.role??null,who.accountId??null,who.rosterId??null,who.class??null,
            JSON.stringify(ordered),effect,expires,actor.accountId,at]);
        const result={...grantView({id,section_id:sectionId,grantee_kind:who.kind,grantee_role:who.role??null,grantee_account:who.accountId??null,
          grantee_roster:who.rosterId??null,grantee_class:who.class??null,rights:ordered,effect,expires_at:expires,created_at:at,revoked_at:null}),accessVersion:version};
        await audit(db,{tenantId,documentId,actorId:actor.accountId,kind:"granted",subjectId:id,commandId,requestDigest,result,at});
        return result;
      });
    },
    async revoke(credentials,tenantId,documentId,grantId,{commandId}){
      ids(tenantId,documentId);check(uuid(grantId)&&uuid(commandId),"INVALID_SECTION_GRANT");
      return identity.withTenant(credentials,tenantId,{write:true,recent:true,roles:managers},async(db,actor)=>{
        const requestDigest=digest("section-revoke-command-v1",{documentId,grantId});
        const prior=await replay(db,tenantId,actor.accountId,commandId,requestDigest);
        if(prior)return prior;
        const row=(await db.query("SELECT revoked_at FROM dge_moderation.section_grants WHERE tenant_id=$1 AND document_id=$2 AND id=$3 FOR UPDATE",[tenantId,documentId,grantId])).rows[0];
        check(row,"SECTION_GRANT_NOT_FOUND",404);
        check(row.revoked_at===null,"SECTION_GRANT_ALREADY_REVOKED",409);
        const at=now();
        await db.query("UPDATE dge_moderation.section_grants SET revoked_at=$4,revoked_by=$5 WHERE tenant_id=$1 AND document_id=$2 AND id=$3",[tenantId,documentId,grantId,at,actor.accountId]);
        const result={id:grantId,revokedAt:iso(at)};
        await audit(db,{tenantId,documentId,actorId:actor.accountId,kind:"revoked",subjectId:grantId,commandId,requestDigest,result,at});
        return result;
      });
    },
    /** Explicitly lift or re-impose restriction; grants stay on record. */
    async setRestricted(credentials,tenantId,documentId,{restricted,expectedVersion,commandId}){
      ids(tenantId,documentId);
      check(uuid(commandId)&&typeof restricted==="boolean"&&Number.isSafeInteger(expectedVersion)&&expectedVersion>=0,"INVALID_SECTION_ACCESS");
      return identity.withTenant(credentials,tenantId,{write:true,recent:true,roles:managers},async(db,actor)=>{
        const requestDigest=digest("section-access-command-v1",{documentId,restricted,expectedVersion});
        const prior=await replay(db,tenantId,actor.accountId,commandId,requestDigest);
        if(prior)return prior;
        await current(db,tenantId,documentId);
        const state=(await db.query("SELECT version FROM dge_moderation.section_access WHERE tenant_id=$1 AND document_id=$2 FOR UPDATE",[tenantId,documentId])).rows[0];
        check((state?.version??0)===expectedVersion,"SECTION_ACCESS_VERSION_CONFLICT",409);
        const at=now();
        const version=await setAccess(db,tenantId,documentId,restricted,actor.accountId,at);
        const result={restricted,version};
        await audit(db,{tenantId,documentId,actorId:actor.accountId,kind:restricted?"restricted":"unrestricted",commandId,requestDigest,result,at});
        return result;
      });
    },
  });
}
