import {before,after,beforeEach,test} from "node:test";
import assert from "node:assert/strict";
import {openWorld,iso,id} from "./governance-fixture.mjs";

let w,tenantId,owner;
before(async()=>{w=await openWorld();});
after(async()=>w?.db.close());
beforeEach(async()=>{await w.reset();({tenantId,owner}=w);});

const roster=(kind,name="Roster")=>w.electorates.createRoster(owner,tenantId,{kind,name,commandId:id()});
const entry=(rosterId,principalId,fields={})=>w.electorates.recordEntry(owner,tenantId,rosterId,{
  principalId,units:"1",validFrom:iso(w.time-60000),expectedVersion:0,commandId:id(),...fields});
const snapshot=(rosterId,recordDate=iso(w.time-1))=>w.electorates.createSnapshot(owner,tenantId,rosterId,{recordDate,commandId:id()});

test("verified-person cohort: duplicate person keys are excluded deterministically and counted, raw keys never stored",async()=>{
  const cohort=await roster("verified-person-cohort","Residents");
  const [a,b,c,d]=[await w.member(),await w.member(),await w.member(),await w.member()];
  w.time+=1000;await entry(cohort.id,a.accountId,{personKey:"resident-evidence-0001",evidenceRef:"kyc:batch-7/0001"});
  w.time+=1000;await entry(cohort.id,b.accountId,{personKey:"resident-evidence-0001"});
  w.time+=1000;await entry(cohort.id,c.accountId,{personKey:"resident-evidence-0002"});
  w.time+=1000;await entry(cohort.id,d.accountId,{personKey:"resident-evidence-0002"});
  await assert.rejects(entry(cohort.id,a.accountId,{class:"second",units:"2",personKey:"x-12345678"}),{code:"COHORT_UNITS_MUST_BE_ONE"});
  await assert.rejects(entry(cohort.id,a.accountId,{class:"second"}),{code:"INVALID_PERSON_KEY"});
  w.time+=1000;
  const frozen=await snapshot(cohort.id);
  assert.equal(frozen.principals,2,"two humans, two votes");
  assert.equal(frozen.entriesConsidered,4);
  assert.equal(frozen.entriesIncluded+frozen.exclusions["duplicate-person-key"],frozen.entriesConsidered);
  assert.equal(frozen.classTotals.default,"2");
  // The earliest-recorded holder of each key is kept.
  const stored=(await w.db.query("SELECT members FROM dge_electorates.snapshots")).rows[0].members.map(m=>m.principalId).sort();
  assert.deepEqual(stored,[a.accountId,c.accountId].sort());
  const everything=JSON.stringify((await w.db.query("SELECT * FROM dge_electorates.roster_entries")).rows)+
    JSON.stringify((await w.db.query("SELECT * FROM dge_electorates.events")).rows);
  assert.ok(!everything.includes("resident-evidence-0001"),"raw evidence is never persisted");
  for(const row of (await w.db.query("SELECT person_key_digest FROM dge_electorates.roster_entries")).rows)
    assert.match(row.person_key_digest,/^[a-f0-9]{64}$/);
  const publicText=JSON.stringify(frozen)+JSON.stringify(await w.electorates.readSnapshot(owner,tenantId,cohort.id,frozen.id));
  for(const who of [a,b,c,d])assert.ok(!publicText.includes(who.accountId),"snapshot summaries never name principals");
  assert.ok(!publicText.includes("kyc:batch"),"evidence references stay private");
  // Keys are salted per roster: the same evidence in another cohort yields a different digest.
  const other=await roster("verified-person-cohort","Other");
  await entry(other.id,a.accountId,{personKey:"resident-evidence-0001"});
  const digests=(await w.db.query("SELECT DISTINCT person_key_digest FROM dge_electorates.roster_entries WHERE principal_id=$1",[a.accountId])).rows;
  assert.equal(digests.length,2);
});

test("record date freezes history: later changes, expiry and future eligibility are honoured exactly",async()=>{
  const register=await roster("unit-register","Share register");
  const [a,b,c]=[await w.member(),await w.member(),await w.member()];
  const start=w.time;
  await entry(register.id,a.accountId,{units:"1000",class:"common"});
  await entry(register.id,a.accountId,{units:"50",class:"preferred-a"});
  await entry(register.id,b.accountId,{units:"700",class:"common",validTo:iso(start+5000)});
  await entry(register.id,c.accountId,{units:"300",class:"common",validFrom:iso(start+20000)});
  w.time=start+10000;
  const recordDate=iso(start+9000);
  const first=await snapshot(register.id,recordDate);
  assert.equal(first.totalUnits,"1050");
  assert.deepEqual(first.classTotals,{common:"1000","preferred-a":"50"});
  assert.equal(first.exclusions["eligibility-expired"],1);
  assert.equal(first.exclusions["not-yet-eligible"],1);
  assert.equal(first.entriesIncluded+Object.values(first.exclusions).reduce((x,y)=>x+y,0),first.entriesConsidered);
  // Changes recorded after the record date never alter the frozen snapshot.
  await w.electorates.recordEntry(owner,tenantId,register.id,{principalId:a.accountId,units:"5",class:"common",
    validFrom:iso(start),expectedVersion:1,commandId:id()});
  const again=await snapshot(register.id,recordDate);
  assert.equal(again.id,first.id);assert.equal(again.snapshotDigest,first.snapshotDigest);
  w.time=start+30000;
  const later=await snapshot(register.id,iso(start+25000));
  assert.equal(later.classTotals.common,"305");
  await assert.rejects(snapshot(register.id,iso(w.time+1)),{code:"RECORD_DATE_NOT_PAST"});
  await assert.rejects(w.electorates.recordEntry(owner,tenantId,register.id,{principalId:a.accountId,units:"6",class:"common",
    validFrom:iso(start),expectedVersion:1,commandId:id()}),{code:"ROSTER_ENTRY_VERSION_CONFLICT"});
});

test("concurrent snapshot creation converges on one frozen row with one digest",async()=>{
  const register=await roster("unit-register");
  const a=await w.member();
  await entry(register.id,a.accountId,{units:"10"});
  w.time+=1000;
  const recordDate=iso(w.time-10);
  const results=await Promise.all(Array.from({length:6},()=>snapshot(register.id,recordDate)));
  assert.equal(new Set(results.map(r=>r.id)).size,1);
  assert.equal(new Set(results.map(r=>r.snapshotDigest)).size,1);
  assert.equal((await w.db.query("SELECT count(*)::int n FROM dge_electorates.snapshots")).rows[0].n,1);
});

test("membership-derived rosters follow active voting members and reject manual entries",async()=>{
  const members=await roster("membership-derived","Members");
  const a=await w.member(),viewer=await w.member("viewer");
  const synced=await w.electorates.syncMembership(owner,tenantId,members.id,{commandId:id()});
  assert.equal(synced.added,2,"owner and participant; the viewer is not a voter");
  await assert.rejects(entry(members.id,a.accountId),{code:"ROSTER_IS_MEMBERSHIP_DERIVED"});
  w.time+=1000;
  const before=await snapshot(members.id);
  await w.identity.changeMember(owner,tenantId,a.accountId,"viewer");
  w.time+=1000;
  const removed=await w.electorates.syncMembership(owner,tenantId,members.id,{commandId:id()});
  assert.equal(removed.removed,1);
  w.time+=1000;
  const after=await snapshot(members.id);
  assert.equal(before.principals,2);assert.equal(after.principals,1);assert.equal(after.exclusions["zero-units"],1);
  assert.equal((await w.electorates.readRoster(viewer,tenantId,members.id)).scope,"own-entries");
});

test("replayed roster commands are idempotent and command reuse with different input is refused",async()=>{
  const register=await roster("unit-register");
  const a=await w.member();
  const commandId=id(),fields={principalId:a.accountId,units:"12",validFrom:iso(w.time-1000),expectedVersion:0,commandId};
  const [x,y]=await Promise.all([w.electorates.recordEntry(owner,tenantId,register.id,fields),w.electorates.recordEntry(owner,tenantId,register.id,fields)]);
  assert.deepEqual(x,y);
  await assert.rejects(w.electorates.recordEntry(owner,tenantId,register.id,{...fields,units:"13"}),{code:"COMMAND_REUSED"});
  assert.equal((await w.db.query("SELECT count(*)::int n FROM dge_electorates.roster_entries")).rows[0].n,1);
  await assert.rejects(w.db.query("UPDATE dge_electorates.roster_entries SET units=99"),/append-only/);
  await assert.rejects(w.db.query("DELETE FROM dge_electorates.roster_entries"),/append-only/);
});

test("authorization and cross-tenant canaries: members cannot manage rosters and outsiders see nothing",async()=>{
  const register=await roster("unit-register");
  const participant=await w.member(),outsider=await w.user();
  await assert.rejects(w.electorates.createRoster(participant,tenantId,{kind:"unit-register",name:"x",commandId:id()}));
  await assert.rejects(entry(register.id,outsider.accountId),{code:"PRINCIPAL_NOT_IN_WORKSPACE"});
  await assert.rejects(w.electorates.readRoster(outsider,tenantId,register.id));
  const {tenantId:otherTenant}=await w.identity.createTenant(outsider);
  await assert.rejects(w.electorates.readRoster(outsider,otherTenant,register.id),{code:"ROSTER_NOT_FOUND"});
  await assert.rejects(w.electorates.recordEntry(outsider,otherTenant,register.id,{principalId:outsider.accountId,units:"1",
    validFrom:iso(w.time-1),expectedVersion:0,commandId:id()}),{code:"ROSTER_NOT_FOUND"});
  await w.transaction(async tx=>{
    assert.equal((await tx.query("SELECT * FROM dge_electorates.rosters")).rows.length,0,"unscoped runtime sees no rosters");
  });
  const response=await w.call(`/api/workspaces/${tenantId}/rosters`,{who:owner,method:"POST",body:{kind:"unit-register",name:"HTTP",commandId:id()}});
  assert.equal(response.status,200);
  const denied=await w.call(`/api/workspaces/${tenantId}/rosters/${register.id}/entries`,{who:participant,method:"POST",
    body:{principalId:participant.accountId,units:"1",validFrom:iso(w.time-1),expectedVersion:0,commandId:id()}});
  assert.equal(denied.status,403);
  const extra=await w.call(`/api/workspaces/${tenantId}/rosters/${register.id}/entries`,{who:owner,method:"POST",
    body:{principalId:participant.accountId,units:"1",validFrom:iso(w.time-1),expectedVersion:0,commandId:id(),weight:"9"}});
  assert.equal(extra.status,400);
  const listed=await (await w.call(`/api/workspaces/${tenantId}/rosters`,{who:participant})).json();
  assert.equal(listed.items.length,2);
});

test("proxy grants: over-allocation, self-grants, cycles and revocation are enforced in the store",async()=>{
  const register=await roster("unit-register");
  const [p,a,b]=[await w.member(),await w.member(),await w.member()];
  await entry(register.id,p.accountId,{units:"100",class:"common"});
  await entry(register.id,a.accountId,{units:"10",class:"common"});
  w.time+=1000;
  const grant=(who,granteeId,allocation=null,extra={})=>w.electorates.grantProxy(who,tenantId,{granteeId,rosterId:register.id,allocation,commandId:id(),...extra});
  const first=await grant(p,a.accountId,{common:"60"});
  await grant(p,b.accountId,{common:"40"});
  await assert.rejects(grant(p,b.accountId,{common:"1"}),{code:"PROXY_OVER_ALLOCATION"});
  await assert.rejects(grant(p,a.accountId,null),{code:"PROXY_OVER_ALLOCATION"});
  await assert.rejects(grant(p,a.accountId,{"preferred-a":"1"}),{code:"PROXY_OVER_ALLOCATION"});
  await assert.rejects(grant(p,p.accountId),{code:"PROXY_SELF_GRANT"});
  await assert.rejects(grant(a,p.accountId),{code:"PROXY_CYCLE"});
  await assert.rejects(grant(b,a.accountId),{code:"GRANTOR_HAS_NO_VOTING_UNITS"});
  await assert.rejects(grant(p,a.accountId,{common:"1"},{expiresAt:iso(w.time-1)}),{code:"INVALID_PROXY_EXPIRY"});
  await assert.rejects(w.electorates.revokeProxy(b,tenantId,first.id,{commandId:id()}),{code:"ACCESS_DENIED"});
  await w.electorates.revokeProxy(p,tenantId,first.id,{commandId:id()});
  await assert.rejects(w.electorates.revokeProxy(p,tenantId,first.id,{commandId:id()}),{code:"PROXY_ALREADY_REVOKED"});
  await grant(p,a.accountId,{common:"60"});
  const mine=await w.electorates.listProxies(a,tenantId);
  assert.equal(mine.received.length,2);assert.equal(mine.received.filter(g=>g.active).length,1);
  assert.equal((await w.electorates.listProxies(b,tenantId)).given.length,0);
  await assert.rejects(w.db.query("UPDATE dge_electorates.proxy_grants SET allocation=NULL"),/revoked once/);
});
