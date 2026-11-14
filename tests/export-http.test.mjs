import {before,after,test} from "node:test";
import assert from "node:assert/strict";
import {randomUUID,randomBytes,createHash} from "node:crypto";
import {PGlite} from "@electric-sql/pglite";
import {createIdentityStore,applyIdentityMigrations} from "../server/identity-store.mjs";
import {createLegalDocument} from "../src/legal-structure.mjs";
import {createPlatform} from "../server/platform.mjs";

const origin="https://quill.example";
let db,platform,owner,tenantId,documentId;
const transaction=fn=>db.transaction(async tx=>{await tx.exec("SET LOCAL ROLE dge_identity_runtime");return fn(tx);});
const get=path=>platform.application(new Request(origin+path),{peerAddress:"127.0.0.1"});
before(async()=>{
  db=await PGlite.create();await applyIdentityMigrations(fn=>db.transaction(fn));
  const identity=createIdentityStore({transaction,origin,sessionKey:randomBytes(32),stateKey:randomBytes(32)});
  platform=createPlatform({identity,transaction,login:{},origin,clock:()=>Date.UTC(2026,10,14)});
  owner={...await identity.establishSession({issuer:"https://id.example",subject:randomUUID(),authenticatedAt:Date.now()}),origin};
  ({tenantId}=await identity.createTenant(owner));
  const document=structuredClone(createLegalDocument({id:randomUUID(),tenantId,title:"Export Act"}));
  document.content=[{kind:"section",id:document.id+":s1",title:"Duties",children:[{kind:"paragraph",id:document.id+":p1",inlines:[{kind:"text",text:"The agency shall report annually. <script>alert(1)</script>"}]}]}];
  documentId=document.id;
  const saved=await platform.services.documents.create(owner,tenantId,{document,commandId:randomUUID(),disclosure:"publish-all-revisions-v1"});
  const next=structuredClone(saved.document);next.content[0].children[0].inlines[0].text="The agency shall report quarterly.";next.revision+=1;
  await platform.services.documents.save(owner,tenantId,documentId,{document:next,commandId:randomUUID(),expectedVersion:1});
});
after(async()=>db?.close());

test("public editions export as bound PDF, DOCX, text and redline artifacts",async()=>{
  const pdf=await get(`/api/public/documents/${documentId}/export?format=pdf&version=1`);
  assert.equal(pdf.status,200);
  assert.equal(pdf.headers.get("content-type"),"application/pdf");
  const bytes=new Uint8Array(await pdf.arrayBuffer());
  assert.equal(new TextDecoder().decode(bytes.slice(0,5)),"%PDF-");
  assert.equal(createHash("sha256").update(bytes).digest("hex"),pdf.headers.get("x-quill-artifact-sha256"));
  const v1=await platform.services.documents.publicRead(documentId,{version:1});
  assert.equal(pdf.headers.get("x-quill-edition-digest"),v1.digest);
  const docx=await get(`/api/public/documents/${documentId}/export?format=docx`);
  assert.equal(docx.status,200);
  assert.equal(new TextDecoder().decode(new Uint8Array(await docx.arrayBuffer()).slice(0,2)),"PK");
  const text=await (await get(`/api/public/documents/${documentId}/export?format=text`)).text();
  assert.match(text,/quarterly/);
  const redline=await get(`/api/public/documents/${documentId}/export?format=html&compare=1`);
  const html=await redline.text();
  assert.match(html,/<del[^>]*>[^<]*annually/);
  assert.match(html,/<ins[^>]*>[^<]*quarterly/);
  assert.equal((await get(`/api/public/documents/${documentId}/export?format=exe`)).status,400);
  assert.equal((await get(`/api/public/documents/${documentId}/export?version=99`)).status,404);
});

test("the reading page is script-free, escaped and locked down by its own policy",async()=>{
  const page=await get(`/api/public/documents/${documentId}/read?version=1`);
  assert.equal(page.status,200);
  assert.match(page.headers.get("content-security-policy"),/default-src 'none'; style-src 'unsafe-inline'/);
  const html=await page.text();
  assert.equal(/<script/i.test(html),false);
  assert.match(html,/&lt;script&gt;/);
});
