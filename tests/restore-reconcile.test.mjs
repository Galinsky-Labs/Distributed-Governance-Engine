import {before,after,test} from "node:test";
import assert from "node:assert/strict";
import {PGlite} from "@electric-sql/pglite";
import {openWorld,id} from "./governance-fixture.mjs";
import {reconciliationManifest,compareManifests,RECONCILED_TABLES,INVARIANTS} from "../server/restore-reconcile.mjs";

let w,source;
before(async()=>{
  w=await openWorld();await w.reset();
  const {tenantId,owner}=w,doc=await w.document(),member=await w.member();
  const proposal=await w.propose(member,doc);
  await w.decisions.open(owner,tenantId,doc.id,proposal.proposal.id,{hours:1,commandId:id()});
  await w.decisions.cast(owner,tenantId,doc.id,proposal.proposal.id,{choice:"yes",expectedVersion:0,commandId:id()});
  await w.decisions.cast(member,tenantId,doc.id,proposal.proposal.id,{choice:"yes",expectedVersion:0,commandId:id()});
  w.time+=3600001;
  await w.decisions.close(owner,tenantId,doc.id,proposal.proposal.id);
  source=await reconciliationManifest(sql=>w.db.query(sql));
});
after(async()=>w?.db.close());

const restoreCopy=async()=>PGlite.create({loadDataDir:await w.db.dumpDataDir("none")});

test("a manifest covers revisions, ballots, receipts, keys and anchor outboxes without content",()=>{
  for(const table of RECONCILED_TABLES)assert.ok(source.tables[table],table);
  assert.equal(source.tables["dge_documents.versions"].rows,"2","source and applied revision");
  assert.equal(source.tables["dge_decisions.ballots"].rows,"2");
  assert.equal(Number(source.tables["dge_decisions.decisions"].rows),1);
  for(const count of Object.values(source.invariants))assert.equal(count,0);
  const text=JSON.stringify(source);
  assert.ok(!text.includes("Meetings occur")&&!text.includes("quarterly"),"no document text in the manifest");
  assert.ok(Object.keys(source.pendingOutbox).every(t=>t.endsWith("outbox")));
});

test("restore drill: an exact copy reconciles",async()=>{
  const restored=await restoreCopy();
  try{
    const result=compareManifests(source,await reconciliationManifest(sql=>restored.query(sql)));
    assert.deepEqual(result,{ok:true,problems:[]});
  }finally{await restored.close();}
});

test("restore drill: a lost ballot, a changed receipt and a broken head are each detected",async()=>{
  const restored=await restoreCopy();
  try{
    await restored.exec("ALTER TABLE dge_decisions.ballots DISABLE TRIGGER ALL; DELETE FROM dge_decisions.ballots WHERE ctid IN (SELECT ctid FROM dge_decisions.ballots LIMIT 1)");
    await restored.exec("ALTER TABLE dge_decisions.decisions DISABLE TRIGGER ALL; UPDATE dge_decisions.decisions SET certificate_digest=repeat('0',64)");
    await restored.exec("ALTER TABLE dge_documents.documents DISABLE TRIGGER ALL; UPDATE dge_documents.documents SET digest=repeat('1',64)");
    const result=compareManifests(source,await reconciliationManifest(sql=>restored.query(sql)));
    assert.equal(result.ok,false);
    const by=key=>result.problems.find(p=>p.table===key||p.invariant===key);
    assert.equal(by("dge_decisions.ballots").problem,"row-count-differs");
    assert.equal(by("dge_decisions.decisions").problem,"row-content-differs");
    assert.equal(by("document-head-matches-latest-version").problem,"invariant-violated");
    assert.ok(!JSON.stringify(result).includes("Meetings"));
  }finally{await restored.close();}
});

test("restore drill: storage loss of a whole table is reported, not silently skipped",async()=>{
  const restored=await restoreCopy();
  try{
    await restored.exec("DROP TABLE dge_ledger.anchors");
    const result=compareManifests(source,await reconciliationManifest(sql=>restored.query(sql)));
    assert.deepEqual(result.problems.find(p=>p.table==="dge_ledger.anchors"),{table:"dge_ledger.anchors",problem:"row-count-differs",source:"0",restored:null});
  }finally{await restored.close();}
});

test("every invariant query runs and returns a count",async()=>{
  for(const sql of Object.values(INVARIANTS))assert.equal(typeof (await w.db.query(sql)).rows[0].n,"number");
});
