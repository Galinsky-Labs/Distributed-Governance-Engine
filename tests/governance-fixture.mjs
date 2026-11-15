import {randomUUID,randomBytes} from "node:crypto";
import {PGlite} from "@electric-sql/pglite";
import {createIdentityStore,applyIdentityMigrations} from "../server/identity-store.mjs";
import {createLegalDocument} from "../src/legal-structure.mjs";
import {createDocumentStore} from "../server/document-store.mjs";
import {createProposalStore} from "../server/proposal-store.mjs";
import {createDiscussionStore} from "../server/discussion-store.mjs";
import {createDecisionStore} from "../server/decision-store.mjs";
import {createElectorateStore} from "../server/electorate-store.mjs";
import {createSectionGrantStore} from "../server/section-grants.mjs";
import {createModerationStore} from "../server/moderation-store.mjs";
import {createAccountHandler} from "../server/account-http.mjs";
import {createDecisionRoutes} from "../server/decision-http.mjs";
import {createElectorateRoutes} from "../server/electorate-http.mjs";
import {createSectionGrantRoutes} from "../server/section-grants-http.mjs";
import {createModerationRoutes} from "../server/moderation-http.mjs";
import {createProposalRoutes} from "../server/proposal-http.mjs";
import {createDiscussionRoutes} from "../server/discussion-http.mjs";

export const origin="https://quill.example";

/** Shared PGlite world for governance suites: one database per file, reset per test. */
export async function openWorld(){
  const db=await PGlite.create();
  await applyIdentityMigrations(fn=>db.transaction(fn));
  const world={db,time:Date.now(),crashBeforeCommit:false};
  world.transaction=fn=>db.transaction(async tx=>{
    await tx.exec("SET LOCAL ROLE dge_identity_runtime");
    const result=await fn(tx);
    if(world.crashBeforeCommit){world.crashBeforeCommit=false;throw new Error("simulated crash before commit");}
    return result;
  });
  world.reset=async(options={})=>{
    await db.exec("TRUNCATE dge_identity.accounts,dge_identity.tenants,dge_identity.login_challenges CASCADE");
    world.time=Date.now();
    const clock=()=>world.time,transaction=world.transaction;
    world.identity=createIdentityStore({transaction,origin,sessionKey:randomBytes(32),stateKey:randomBytes(32)});
    const identity=world.identity;
    world.documents=createDocumentStore({identity,transaction});
    world.proposals=createProposalStore({identity,transaction,clock});
    world.discussion=createDiscussionStore({identity,transaction,clock});
    world.decisions=createDecisionStore({identity,transaction,clock});
    world.electorates=createElectorateStore({identity,clock,personKeySecret:randomBytes(32)});
    world.sectionGrants=createSectionGrantStore({identity,clock});
    world.moderation=createModerationStore({identity,transaction,clock,...options.moderation});
    world.handler=createAccountHandler({store:identity,login:{},origin,extensions:[
      createDecisionRoutes({decisions:world.decisions}),
      createElectorateRoutes({electorates:world.electorates}),
      createSectionGrantRoutes({sectionGrants:world.sectionGrants}),
      createModerationRoutes({moderation:world.moderation}),
      createProposalRoutes({proposals:world.proposals}),
      createDiscussionRoutes({discussion:world.discussion}),
    ]});
    world.owner=await world.user();
    ({tenantId:world.tenantId}=await identity.createTenant(world.owner));
    return world;
  };
  world.user=async()=>({...await world.identity.establishSession({
    issuer:"https://provider.example",subject:randomUUID(),authenticatedAt:Date.now()
  }),origin});
  world.member=async(role="participant",tenantId=world.tenantId,inviter=world.owner)=>{
    const who=await world.user();
    const invitation=await world.identity.invite(inviter,tenantId,who.accountId,role);
    await world.identity.acceptInvitation(who,tenantId,invitation.invitationToken);
    return who;
  };
  /** A collaboration draft with two sections, a nested subsection and a preamble. */
  world.document=async(tenantId=world.tenantId,owner=world.owner)=>{
    const doc=structuredClone(createLegalDocument({id:randomUUID(),tenantId,title:"Governance test"}));
    doc.content=[
      {kind:"paragraph",id:"preamble",inlines:[{kind:"text",text:"The members adopt these rules."}]},
      {kind:"section",id:"s-public",title:"Public",children:[
        {kind:"paragraph",id:"p-public",inlines:[{kind:"text",text:"Meetings occur annually and openly."}]},
      ]},
      {kind:"section",id:"s-board",title:"Board",children:[
        {kind:"paragraph",id:"p-board",inlines:[{kind:"text",text:"The board has five seats and meets monthly."}]},
        {kind:"section",id:"s-board-pay",title:"Compensation",children:[
          {kind:"paragraph",id:"p-pay",inlines:[{kind:"text",text:"Directors serve without pay."}]},
        ]},
      ]},
    ];
    await world.documents.create(owner,tenantId,{document:doc,commandId:randomUUID(),disclosure:"publish-all-revisions-v1"});
    return doc;
  };
  const quotes={"preamble":"members","p-public":"annually","p-board":"five","p-pay":"without pay"};
  const replacements={"preamble":"citizens","p-public":"quarterly","p-board":"seven","p-pay":"with modest pay"};
  world.propose=async(who,doc,blockId="p-public",{quote=quotes[blockId],replacement=replacements[blockId],baseVersion=1}={})=>{
    const text=JSON.stringify(doc.content).includes(blockId)?findText(doc,blockId):"";
    const start=text.indexOf(quote);
    return world.proposals.create(who,doc.tenantId,doc.id,{baseVersion,
      selection:{blockId,start,end:start+quote.length,quote},replacement,rationale:"Test rationale.",
      commandId:randomUUID(),disclosure:"publish-proposal-v1"});
  };
  world.call=(path,{who,method="GET",body}={})=>world.handler(new Request(origin+path,{method,headers:{
    ...(who?{cookie:"__Host-dge_session="+who.sessionToken,origin,"x-dge-csrf":who.csrfToken}:{}),
    ...(body?{"content-type":"application/json"}:{})},...(body?{body:JSON.stringify(body)}:{})}),{peerAddress:"127.0.0.1"});
  return world;
}
function findText(doc,blockId){
  let found="";
  const walk=nodes=>{for(const n of nodes){if(n.id===blockId)found=n.inlines.map(r=>r.text).join("");if(n.children)walk(n.children);}};
  walk(doc.content);
  return found;
}
export const iso=ms=>new Date(ms).toISOString();
export const id=()=>randomUUID();
