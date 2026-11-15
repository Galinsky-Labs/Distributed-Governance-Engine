import {before,after,beforeEach,test} from "node:test";
import assert from "node:assert/strict";
import {randomUUID,randomBytes} from "node:crypto";
import {PGlite} from "@electric-sql/pglite";
import {createIdentityStore,applyIdentityMigrations} from "../server/identity-store.mjs";
import {createLegalDocument,legalPlainText} from "../src/legal-structure.mjs";
import {createDocumentStore} from "../server/document-store.mjs";
import {createProposalStore} from "../server/proposal-store.mjs";
import {createSearchStore,buildSnippet,highlightTerms} from "../server/search-store.mjs";
import {createSearchRoutes} from "../server/search-http.mjs";
import {createAccountHandler} from "../server/account-http.mjs";

const origin="https://quill.example";
let db,identity,documents,proposals,search,handler,alice,bob,outsider,tenantA,tenantB;
const transaction=fn=>db.transaction(async tx=>{await tx.exec("SET LOCAL ROLE dge_identity_runtime");return fn(tx);});
const user=async()=>({...await identity.establishSession({issuer:"https://provider.example",subject:randomUUID(),authenticatedAt:Date.now()}),origin});
const publish=async(who,tenantId,title,text)=>{
  const document=structuredClone(createLegalDocument({id:randomUUID(),tenantId,title}));
  document.content[0].inlines=[{kind:"text",text}];
  return (await documents.create(who,tenantId,{document,commandId:randomUUID(),disclosure:"publish-all-revisions-v1"})).document;
};
const call=(path,who)=>handler(new Request(origin+path,{headers:who?{cookie:"__Host-dge_session="+who.sessionToken}:{}}),{peerAddress:"127.0.0.1"});

before(async()=>{db=await PGlite.create();await applyIdentityMigrations(fn=>db.transaction(fn));});
after(async()=>db?.close());
beforeEach(async()=>{
  await db.exec("TRUNCATE dge_identity.accounts,dge_identity.tenants,dge_identity.login_challenges CASCADE");
  identity=createIdentityStore({transaction,origin,sessionKey:randomBytes(32),stateKey:randomBytes(32)});
  documents=createDocumentStore({identity,transaction});
  proposals=createProposalStore({identity,transaction});
  search=createSearchStore({identity,transaction,product:"civic"});
  handler=createAccountHandler({store:identity,login:{},origin,extensions:[createSearchRoutes({search})]});
  alice=await user();bob=await user();outsider=await user();
  ({tenantId:tenantA}=await identity.createTenant(alice));
  ({tenantId:tenantB}=await identity.createTenant(bob));
});

test("public search ranks title matches first, highlights only public text and folds accents",async()=>{
  const titled=await publish(alice,tenantA,"Water quality act","Agencies publish reports.");
  const body=await publish(bob,tenantB,"Budget","The water authority shall publish quarterly water reports.");
  await publish(alice,tenantA,"Unrelated","Nothing here about rivers.");
  const accented=await publish(alice,tenantA,"Résumé","L'État publiera un rapport.");
  const result=await search.publicSearch({query:"water"});
  assert.deepEqual(result.items.map(i=>i.documentId),[titled.id,body.id]);
  assert.ok(result.items[0].rank>result.items[1].rank);
  const hit=result.items[1];
  const plain=legalPlainText(body).replace(/\s+/g," ");
  assert.ok(plain.includes(hit.snippet.segments.map(s=>s.text).join("")),"snippet is a contiguous slice of the public text");
  assert.deepEqual(hit.snippet.segments.filter(s=>s.match).map(s=>s.text),["water","water"]);
  assert.equal(hit.workspaceId,tenantB);assert.equal(hit.product,"civic");assert.equal(hit.kind,"document");
  const folded=await search.publicSearch({query:"etat RESUME"});
  assert.deepEqual(folded.items.map(i=>i.documentId),[accented.id]);
  assert.deepEqual(folded.items[0].snippet.segments.filter(s=>s.match).map(s=>s.text),["État"]);
  assert.equal((await search.publicSearch({query:"water",product:"charter"})).items.length,0,"other product matches nothing");
  assert.equal((await search.publicSearch({query:"water",mode:"public-input"})).items.length,0);
  assert.deepEqual((await search.publicSearch({query:"water",workspace:tenantB})).items.map(i=>i.documentId),[body.id]);
});

test("the index follows saved revisions and covers proposal rationale and replacement text",async()=>{
  const document=await publish(alice,tenantA,"Fees","Fees are charged annually.");
  const next=structuredClone(document);next.revision+=1;next.content[0].inlines=[{kind:"text",text:"Fees are waived for veterans."}];
  await documents.save(alice,tenantA,document.id,{document:next,commandId:randomUUID(),expectedVersion:1});
  assert.equal((await search.publicSearch({query:"annually"})).items.length,0,"old text is no longer indexed");
  assert.equal((await search.publicSearch({query:"veterans"})).items.length,1);
  const proposal=await proposals.create(alice,tenantA,document.id,{baseVersion:2,selection:{blockId:next.content[0].id,start:20,end:28,quote:"veterans"},
    replacement:"seniors",rationale:"Extend the waiver to pensioners.",commandId:randomUUID(),disclosure:"publish-proposal-v1"});
  const found=await search.publicSearch({query:"pensioners",kind:"proposal"});
  assert.equal(found.items.length,1);assert.equal(found.items[0].proposalId,proposal.proposal.id);assert.equal(found.items[0].title,"Fees");
  assert.deepEqual(found.items[0].snippet.segments.filter(s=>s.match).map(s=>s.text),["pensioners"]);
  assert.equal((await search.publicSearch({query:"seniors"})).items[0].kind,"proposal");
  assert.equal((await search.publicSearch({query:"pensioners",kind:"document"})).items.length,0);
});

test("member search is confined to the caller's active workspaces",async()=>{
  const own=await publish(alice,tenantA,"Harbor plan","Harbor dredging schedule.");
  await publish(bob,tenantB,"Harbor fees","Harbor fee schedule.");
  assert.equal((await search.publicSearch({query:"harbor"})).items.length,2);
  assert.deepEqual((await search.memberSearch(alice,{query:"harbor"})).items.map(i=>i.documentId),[own.id]);
  assert.equal((await search.memberSearch(outsider,{query:"harbor"})).items.length,0);
  await assert.rejects(search.memberSearch(alice,{query:"harbor",workspace:tenantB}),{code:"ACCESS_DENIED"});
  await assert.rejects(search.memberSearch({},{query:"harbor"}),{code:"AUTHENTICATION_REQUIRED"});
  const invite=await identity.invite(bob,tenantB,alice.accountId,"viewer");
  await identity.acceptInvitation(alice,tenantB,invite.invitationToken);
  assert.equal((await search.memberSearch(alice,{query:"harbor"})).items.length,2);
  await identity.changeMember(bob,tenantB,alice.accountId,null);
  assert.equal((await search.memberSearch(alice,{query:"harbor"})).items.length,1,"removal takes effect immediately");
  const response=await call("/api/search?q=harbor&workspace="+tenantA,alice);
  assert.equal(response.status,200);assert.equal((await response.json()).items.length,1);
  assert.equal((await call("/api/search?q=harbor")).status,401);
});

test("injection-shaped and degenerate queries are bounded and never reach tsquery syntax",async()=>{
  await publish(alice,tenantA,"Plain","Simple words only.");
  for(const query of ["simple')) OR 1=1 --","simple & | ! :* <-> (","'; DROP TABLE dge_documents.documents; --","\"simple words","simple -words","simple or"]){
    const result=await search.publicSearch({query});
    assert.ok(Array.isArray(result.items),query);
  }
  assert.equal((await search.publicSearch({query:"simple -words"})).items.length,0);
  assert.equal((await search.publicSearch({query:"-simple"})).items.length,0,"purely negated queries match nothing");
  assert.equal((await search.publicSearch({query:"&&& !!!"})).items.length,0);
  for(const query of [""," ","x".repeat(201),"a\u0000b",Array.from({length:17},(_,i)=>"w"+i).join(" "),42])
    await assert.rejects(search.publicSearch({query}),{code:"INVALID_QUERY"});
  await assert.rejects(search.publicSearch({query:"simple",mode:"private"}),{code:"INVALID_FILTER"});
  await assert.rejects(search.publicSearch({query:"simple",cursor:"not json"}),{code:"INVALID_CURSOR"});
  await assert.rejects(search.publicSearch({query:"simple",cursor:Buffer.from('[1,5,"x"]').toString("base64url")}),{code:"INVALID_CURSOR"});
  const response=await call("/api/public/search?q=simple&q=again");
  assert.equal(response.status,400);
  assert.equal((await call("/api/public/search?q=simple&sql=1")).status,400);
  assert.equal((await (await call("/api/public/search?q=simple")).json()).items.length,1);
  assert.equal(await db.query("SELECT count(*)::int n FROM dge_documents.documents").then(r=>r.rows[0].n),1);
});

test("cursor pagination is stable and complete across equal ranks",async()=>{
  const ids=[];
  for(let i=0;i<7;i++)ids.push((await publish(alice,tenantA,"Notice "+i,"Identical ordinance text.")).id);
  const seen=[];let cursor=null;
  do{const page=await search.publicSearch({query:"ordinance",limit:3,cursor});seen.push(...page.items.map(i=>i.documentId));cursor=page.nextCursor;}while(cursor);
  assert.deepEqual([...seen].sort(),[...ids].sort());
  assert.equal(new Set(seen).size,7);
  const again=[];cursor=null;
  do{const page=await search.publicSearch({query:"ordinance",limit:3,cursor});again.push(...page.items.map(i=>i.documentId));cursor=page.nextCursor;}while(cursor);
  assert.deepEqual(again,seen);
});

test("snippets are bounded segments with Unicode-safe edges",()=>{
  const text="😀".repeat(100)+" alpha beta gamma "+"😀".repeat(100);
  const snippet=buildSnippet(text,highlightTerms("beta -gamma"));
  assert.deepEqual(snippet.segments.filter(s=>s.match).map(s=>s.text),["beta"]);
  assert.equal(snippet.truncatedStart,true);assert.equal(snippet.truncatedEnd,true);
  for(const segment of snippet.segments)assert.doesNotMatch(segment.text,/^[\udc00-\udfff]|[\ud800-\udbff]$/);
  assert.deepEqual(buildSnippet("No match here",new Set(["zzz"])).segments,[{text:"No match here",match:false}]);
});
