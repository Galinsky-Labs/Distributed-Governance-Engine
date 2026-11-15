import {test,before,after} from "node:test";
import assert from "node:assert/strict";
import {randomUUID,randomBytes} from "node:crypto";
import {PGlite} from "@electric-sql/pglite";
import {createIdentityStore,applyIdentityMigrations} from "../server/identity-store.mjs";
import {createLegalDocument} from "../src/legal-structure.mjs";
import {createDocumentStore} from "../server/document-store.mjs";
import {createEditionStore} from "../server/edition-store.mjs";
import {createSignatureStore} from "../server/signature-store.mjs";
import {verifyConsistency} from "../src/transparency.mjs";
import {verifySignatureReceipt,manifestRoot} from "../src/signatures.mjs";

const origin="https://quill.example";
let db,identity,signatures,owner,tenantId,edition;
const transaction=fn=>db.transaction(async tx=>{await tx.exec("SET LOCAL ROLE dge_identity_runtime");return fn(tx);});
const timed=async fn=>{const start=performance.now();const value=await fn();return [value,performance.now()-start];};

/** Bulk load bypasses the store on purpose: it simulates an existing large campaign. */
async function insertSignatures(from,to){
  await db.exec("CREATE TEMP TABLE IF NOT EXISTS batch(i int, account uuid, rid uuid)");
  await db.exec("TRUNCATE batch");
  await db.query("INSERT INTO batch SELECT i,gen_random_uuid(),gen_random_uuid() FROM generate_series($1::int,$2::int) i",[from,to]);
  await db.query("INSERT INTO dge_identity.accounts(id,issuer,subject,created_at) SELECT account,'https://scale.example','s'||i,now() FROM batch");
  await db.query(`INSERT INTO dge_signatures.records(tenant_id,id,edition_id,kind,action,record_digest,display,public_record,created_at)
    SELECT $1,rid,$2::uuid,'support','sign',encode(sha256(convert_to('scale-'||i,'UTF8')),'hex'),CASE WHEN i%3=0 THEN 'public' ELSE 'private' END,
      CASE WHEN i%3=0 THEN jsonb_build_object('editionId',$2::text,'kind','support','action','sign','publicName','Signer '||lpad(i::text,6,'0'),
        'signedAt','2026-11-14T00:00:00.000Z','method','none') END,now() FROM batch ORDER BY i`,[tenantId,edition.id]);
  await db.query(`INSERT INTO dge_signatures.evidence(tenant_id,record_id,edition_id,account_id,record,mark)
    SELECT $1,rid,$2,account,'{}','{"type":"none"}' FROM batch`,[tenantId,edition.id]);
  await db.query(`INSERT INTO dge_signatures.active(tenant_id,edition_id,kind,account_id,record_id,display)
    SELECT $1,$2,'support',account,rid,CASE WHEN i%3=0 THEN 'public' ELSE 'private' END FROM batch`,[tenantId,edition.id]);
  await db.query(`INSERT INTO dge_signatures.directory(tenant_id,edition_id,kind,record_id,seq,public_name,name_key,signed_at)
    SELECT $1,$2,'support',r.id,r.seq,r.public_record->>'publicName',lower(r.public_record->>'publicName'),now()
    FROM batch b JOIN dge_signatures.records r ON r.id=b.rid WHERE b.i%3=0`,[tenantId,edition.id]);
  await db.query(`INSERT INTO dge_signatures.manifest_queue(tenant_id,edition_id,kind,seq,record_id)
    SELECT $1,$2,'support',r.seq,r.id FROM batch b JOIN dge_signatures.records r ON r.id=b.rid`,[tenantId,edition.id]);
  await db.query(`INSERT INTO dge_signatures.tallies(tenant_id,edition_id,kind,shard,active_count,public_count)
    SELECT $1,$2,'support',0,count(*),count(*) FILTER (WHERE i%3=0) FROM batch
    ON CONFLICT (edition_id,kind,shard) DO UPDATE SET active_count=dge_signatures.tallies.active_count+excluded.active_count,
      public_count=dge_signatures.tallies.public_count+excluded.public_count`,[tenantId,edition.id]);
}

before(async()=>{
  db=await PGlite.create();await applyIdentityMigrations(fn=>db.transaction(fn));
  identity=createIdentityStore({transaction,origin,sessionKey:randomBytes(32),stateKey:randomBytes(32)});
  owner={...await identity.establishSession({issuer:"https://provider.example",subject:randomUUID(),authenticatedAt:Date.now()}),origin};
  ({tenantId}=await identity.createTenant(owner));
  const document=structuredClone(createLegalDocument({id:randomUUID(),tenantId,title:"Petition"}));
  document.content[0].inlines=[{kind:"text",text:"We support this petition."}];
  const saved=await createDocumentStore({identity,transaction}).create(owner,tenantId,{document,commandId:randomUUID(),disclosure:"publish-all-revisions-v1"});
  edition=await createEditionStore({identity,transaction}).freeze(owner,tenantId,document.id,{commandId:randomUUID(),kind:"final",sourceVersion:1,sourceDigest:saved.digest});
  signatures=createSignatureStore({identity,transaction,origin,maxLeavesPerFreeze:15000});
  for(let from=1;from<=20000;from+=5000)await insertSignatures(from,from+4999);
});
after(async()=>db?.close());

test("20,000 signatures: bounded manifest freezes, stable pagination, redaction and verifiable receipts",{timeout:600000},async t=>{
  const [first,firstMs]=await timed(()=>signatures.freezeManifest(owner,tenantId,edition.id,{kind:"support"}));
  assert.equal(first.manifest.size,15000,"one freeze request processes at most maxLeavesPerFreeze records");
  assert.equal(first.pending,true);
  const [second,secondMs]=await timed(()=>signatures.freezeManifest(owner,tenantId,edition.id,{kind:"support"}));
  assert.equal(second.manifest.size,20000);
  assert.equal(second.pending,false);
  assert.equal(second.manifest.activeSigners,20000);
  assert.equal(second.manifest.publicSigners,6666);
  assert.ok(secondMs<firstMs*0.8+5000,"work is proportional to new records, not total size");
  assert.ok(firstMs<120000,"freeze of 15,000 records finished in "+Math.round(firstMs)+"ms");
  assert.equal(verifyConsistency({first:15000,second:20000,firstRoot:first.manifest.rootHash,secondRoot:second.manifest.rootHash,proof:second.consistency}),true);

  const pageTimes=[],pages=[];
  let cursor=null;
  for(let i=0;i<5;i++){
    const [page,ms]=await timed(()=>signatures.directory(edition.id,{kind:"support",after:cursor,limit:100}));
    pages.push(page);pageTimes.push(ms);cursor=page.nextCursor;
  }
  assert.equal(pages[0].total,20000);
  assert.equal(pages[0].publiclyNamed,6666);
  assert.equal(new Set(pages.flatMap(p=>p.items.map(i=>i.recordDigest))).size,500,"pages never overlap");
  assert.equal(pages[0].items[0].name,"Signer 000003");
  await insertSignatures(20001,21000);
  let replay=null;
  for(let i=0;i<5;i++){
    const page=await signatures.directory(edition.id,{kind:"support",after:replay,limit:100});
    assert.deepEqual(page.items,pages[i].items,"existing cursors return identical pages after new signatures");
    replay=page.nextCursor;
  }
  const deepCursor=Buffer.from(JSON.stringify([null,Number((await db.query("SELECT seq FROM dge_signatures.directory WHERE public_name='Signer 019998'")).rows[0].seq)])).toString("base64url");
  const [deep,deepMs]=await timed(()=>signatures.directory(edition.id,{kind:"support",after:deepCursor,limit:100}));
  assert.equal(deep.items[0].name,"Signer 020001");
  const [search,searchMs]=await timed(()=>signatures.directory(edition.id,{kind:"support",q:"signer 01234",limit:100}));
  assert.deepEqual(search.items.map(i=>i.name),["Signer 012342","Signer 012345","Signer 012348"]);
  for(const ms of [...pageTimes,deepMs,searchMs])assert.ok(ms<3000,"directory page took "+Math.round(ms)+"ms");
  t.diagnostic(`freeze 15000 new: ${Math.round(firstMs)}ms; freeze 5000 new: ${Math.round(secondMs)}ms; pages: ${pageTimes.map(Math.round).join("/")}ms; deep page ${Math.round(deepMs)}ms; prefix search ${Math.round(searchMs)}ms`);

  for(const position of [0,9999,19999]){
    const digest=(await db.query("SELECT record_digest FROM dge_signatures.manifest_entries WHERE edition_id=$1 AND position=$2",[edition.id,position])).rows[0].record_digest;
    const [receipt,ms]=await timed(()=>signatures.publicReceipt(edition.id,digest));
    assert.equal(receipt.position,position);
    assert.ok(receipt.proof.length<=15);
    assert.equal(verifySignatureReceipt(receipt).valid,true);
    assert.ok(ms<3000);
    assert.equal(receipt.record===null,position%3!==2,"only public records are disclosed");
  }

  const digests=[];let csvRows=0,privateNames=0;
  for await(const chunk of signatures.exportManifest(edition.id,"support",2,"csv")){
    for(const line of chunk.split("\n").filter(Boolean).slice(chunk.startsWith("position")?1:0)){
      const fields=line.split(",");digests.push(fields[1]);csvRows++;
      if(fields[3]==="private"&&fields.slice(4).some(Boolean))privateNames++;
    }
  }
  assert.equal(csvRows,20000);
  assert.equal(privateNames,0);
  assert.deepEqual(manifestRoot(digests),{size:20000,rootHash:second.manifest.rootHash});
});
