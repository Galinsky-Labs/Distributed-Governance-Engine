import {before,after,test} from "node:test";
import assert from "node:assert/strict";
import {randomBytes,randomUUID} from "node:crypto";
import {PGlite} from "@electric-sql/pglite";
import {createIdentityStore,applyIdentityMigrations} from "../server/identity-store.mjs";
import {createDocumentStore} from "../server/document-store.mjs";
import {createDocumentRoutes} from "../server/document-http.mjs";
import {createAccountHandler} from "../server/account-http.mjs";
import {createLegalDocument} from "../src/legal-structure.mjs";

let db;
const origin="https://quill.example";
const transaction=fn=>db.transaction(async tx=>{await tx.exec("SET LOCAL ROLE dge_identity_runtime");return fn(tx);});
before(async()=>{db=await PGlite.create();await applyIdentityMigrations(fn=>db.transaction(fn));});
after(async()=>db?.close());
test("anonymous pagination exposes only deliberately public document metadata",async()=>{
  const identity=createIdentityStore({transaction,origin,sessionKey:randomBytes(32),stateKey:randomBytes(32)});
  const session={...await identity.establishSession({
    issuer:"https://provider.example",subject:randomUUID(),authenticatedAt:Date.now()
  }),origin};
  const {tenantId}=await identity.createTenant(session);
  const documents=createDocumentStore({identity,transaction});
  const titles=["Public voter initiative","Public corporate resolution","Public census measure"];
  const ids=[];
  for(const title of titles){
    const doc=structuredClone(createLegalDocument({id:randomUUID(),tenantId,title}));
    doc.content[0].inlines=[{kind:"text",text:"Document text deliberately excluded from catalog."}];
    ids.push(doc.id);
    await documents.create(session,tenantId,{document:doc,commandId:randomUUID(),disclosure:"publish-all-revisions-v1"});
  }
  const handler=createAccountHandler({origin,store:identity,login:{},
    extensions:[createDocumentRoutes({documents})]});
  const get=(path,method="GET")=>handler(new Request(origin+path,{method}),{peerAddress:"127.0.0.1"});
  const base="/api/public/documents";
  const observed=new Set();
  let cursor=null;
  for(let i=0;i<3;i++){
    const res=await get(base+"?limit=1"+(cursor?"&after="+cursor:""));
    assert.equal(res.status,200);
    const json=await res.json();
    assert.equal(json.items.length,1);
    assert.equal(json.items[0].tenantId,tenantId);
    assert.equal(json.items[0].mode,"collaboration");
    assert.ok(titles.includes(json.items[0].title));
    observed.add(json.items[0].id);
    assert.ok(!JSON.stringify(json).includes("Document text deliberately excluded"));
    assert.ok(!JSON.stringify(json).includes(session.accountId));
    cursor=json.nextCursor;
  }
  assert.deepEqual(observed,new Set(ids));
  const final=await get(base+"?after="+cursor);
  assert.equal((await final.json()).items.length,0);
  assert.equal((await get(base+"?limit=0")).status,400);
  assert.equal((await get(base+"?limit=1000")).status,400);
  assert.equal((await get(base+"?limit=1&limit=2")).status,400);
  assert.equal((await get(base+"?after=../../bad")).status,400);
  assert.equal((await get(base,"POST")).status,405);
  const hidden=await transaction(tx=>tx.query("SELECT count(*)::int n FROM dge_documents.documents"));
  assert.equal(hidden.rows[0].n,0,"The public-list context must never leak into a new SQL transaction");
  const doc=await get(base+"/"+ids[0]);
  assert.equal(doc.status,200,"Public content remains available by exact ID");
});
