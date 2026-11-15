import {before,after,beforeEach,test} from "node:test";
import assert from "node:assert/strict";
import {openWorld,iso,id} from "./governance-fixture.mjs";
import {SECTION_RIGHTS} from "../server/section-grants.mjs";

let w,tenantId,owner,doc,people;
before(async()=>{w=await openWorld();});
after(async()=>w?.db.close());
beforeEach(async()=>{
  await w.reset();({tenantId,owner}=w);doc=await w.document();
  people={owner,admin:await w.member("admin"),editor:await w.member("editor"),participant:await w.member("participant"),viewer:await w.member("viewer")};
});
const outcome=promise=>promise.then(()=>"ok",error=>error.code);
const grant=(sectionId,grantee,rights,extra={})=>w.sectionGrants.grant(owner,tenantId,doc.id,{sectionId,grantee,rights,commandId:id(),...extra});
const role=r=>({kind:"role",role:r});
const point=(who,proposal)=>w.discussion.create(who,tenantId,doc.id,proposal.proposal.id,{position:"support",text:"A reasoned point.",
  commandId:id(),disclosure:"publish-point-v1"});
const ROLE_CAN={propose:["owner","admin","editor","participant"],discuss:["owner","admin","editor","participant"],vote:["owner","admin","editor","participant"]};

test("authorization matrix: every role × every right on a restricted section, enforced by the stores",async()=>{
  const matrix={owner:["read","vote"],admin:["propose","discuss","vote"],editor:["propose"],participant:["discuss","vote"],viewer:[...SECTION_RIGHTS]};
  for(const [r,rights] of Object.entries(matrix))await grant("s-board",role(r),rights);
  // An admin proposal on the board clause anchors the discussion and vote checks.
  const anchor=await w.propose(people.admin,doc,"p-board");
  for(const [r,who] of Object.entries(people)){
    const granted=matrix[r];
    const expect=right=>ROLE_CAN[right].includes(r)&&granted.includes(right);
    const proposed=await outcome(w.propose(who,doc,"p-board",{replacement:"six "+r}));
    assert.equal(proposed==="ok",expect("propose"),`${r} propose → ${proposed}`);
    if(ROLE_CAN.propose.includes(r)&&!expect("propose"))assert.equal(proposed,"SECTION_RIGHT_REQUIRED");
    const discussed=await outcome(point(who,anchor));
    assert.equal(discussed==="ok",expect("discuss"),`${r} discuss → ${discussed}`);
    const mine=(await w.sectionGrants.list(who,tenantId,doc.id)).mine.find(m=>m.sectionId==="s-board");
    assert.deepEqual(mine.rights,SECTION_RIGHTS.filter(x=>granted.includes(x)),`${r} effective rights`);
    // Ungranted text of a restricted document is denied by default.
    if(ROLE_CAN.propose.includes(r))assert.equal(await outcome(w.propose(who,doc,"p-public")),"SECTION_RIGHT_REQUIRED");
  }
  const opened=await w.decisions.open(owner,tenantId,doc.id,anchor.proposal.id,{hours:1,commandId:id(),weighting:"equal"});
  assert.equal(opened.electorate.exclusions["no-section-vote-right"],1,"the editor lacks vote on the board clause");
  for(const [r,who] of Object.entries(people)){
    const read=await w.decisions.read(who,tenantId,doc.id,anchor.proposal.id);
    assert.equal(read.mine.eligible,ROLE_CAN.vote.includes(r)&&matrix[r].includes("vote"),`${r} vote eligibility`);
  }
  assert.equal(await outcome(w.decisions.cast(people.editor,tenantId,doc.id,anchor.proposal.id,{choice:"yes",expectedVersion:0,commandId:id()})),"NOT_IN_FROZEN_ELECTORATE");
  assert.equal(await outcome(w.decisions.cast(people.participant,tenantId,doc.id,anchor.proposal.id,{choice:"yes",expectedVersion:0,commandId:id()})),"ok");
  const rights=await w.discussion.mine(people.editor,tenantId,doc.id,anchor.proposal.id,{pointIds:[]});
  assert.equal(rights.canContribute,false,"the UI hint follows the discuss right");
});

test("nested clauses inherit allows, an ancestor deny overrides any allow below it, and child grants never leak upward",async()=>{
  await grant("s-board",role("editor"),["propose","vote"]);
  await grant("s-board-pay",{kind:"account",accountId:people.participant.accountId},["propose","vote"]);
  assert.equal(await outcome(w.propose(people.editor,doc,"p-pay")),"ok","allow on a section covers nested subsections");
  assert.equal(await outcome(w.propose(people.participant,doc,"p-pay")),"ok");
  assert.equal(await outcome(w.propose(people.participant,doc,"p-board")),"SECTION_RIGHT_REQUIRED","a child unlock does not open its parent");
  await grant("s-board",role("participant"),["vote"],{effect:"deny"});
  assert.equal(await outcome(w.propose(people.participant,doc,"p-pay",{replacement:"again"})),"ok","deny covers only the rights it names");
  await grant("s-board",{kind:"account",accountId:people.participant.accountId},["propose"],{effect:"deny"});
  assert.equal(await outcome(w.propose(people.participant,doc,"p-pay",{replacement:"third"})),"SECTION_RIGHT_REQUIRED","inherited deny beats a nested allow");
  const anchor=await w.propose(people.editor,doc,"p-pay",{replacement:"with a stipend"});
  await w.decisions.open(owner,tenantId,doc.id,anchor.proposal.id,{hours:1,commandId:id()});
  assert.equal(await outcome(w.decisions.cast(people.participant,tenantId,doc.id,anchor.proposal.id,{choice:"yes",expectedVersion:0,commandId:id()})),
    "NOT_IN_FROZEN_ELECTORATE","version 1 decisions honour the same vote restriction");
  assert.equal(await outcome(w.decisions.cast(people.editor,tenantId,doc.id,anchor.proposal.id,{choice:"yes",expectedVersion:0,commandId:id()})),"ok");
});

test("expired and revoked unlocks fall back to deny; lifting restriction is explicit, versioned and audited",async()=>{
  await grant("s-public",role("participant"),["propose"],{expiresAt:iso(w.time+1000)});
  assert.equal(await outcome(w.propose(people.participant,doc,"p-public")),"ok");
  w.time+=2000;
  assert.equal(await outcome(w.propose(people.participant,doc,"p-public",{replacement:"weekly"})),"SECTION_RIGHT_REQUIRED","an expired unlock does not reopen the document");
  const lasting=await grant("s-public",role("participant"),["propose"]);
  assert.equal(await outcome(w.propose(people.participant,doc,"p-public",{replacement:"daily"})),"ok");
  await w.sectionGrants.revoke(owner,tenantId,doc.id,lasting.id,{commandId:id()});
  assert.equal(await outcome(w.propose(people.participant,doc,"p-public",{replacement:"hourly"})),"SECTION_RIGHT_REQUIRED");
  await assert.rejects(w.sectionGrants.revoke(owner,tenantId,doc.id,lasting.id,{commandId:id()}),{code:"SECTION_GRANT_ALREADY_REVOKED"});
  await assert.rejects(w.sectionGrants.setRestricted(owner,tenantId,doc.id,{restricted:false,expectedVersion:0,commandId:id()}),{code:"SECTION_ACCESS_VERSION_CONFLICT"});
  const lifted=await w.sectionGrants.setRestricted(owner,tenantId,doc.id,{restricted:false,expectedVersion:1,commandId:id()});
  assert.deepEqual(lifted,{restricted:false,version:2});
  assert.equal(await outcome(w.propose(people.participant,doc,"p-public",{replacement:"yearly"})),"ok");
  const kinds=(await w.db.query("SELECT kind FROM dge_moderation.access_events ORDER BY occurred_at,kind")).rows.map(r=>r.kind);
  assert.deepEqual(kinds.sort(),["granted","granted","revoked","unrestricted"]);
  await assert.rejects(w.db.query("UPDATE dge_moderation.section_grants SET rights='[\"read\"]'"),/revoked once/);
  await assert.rejects(w.db.query("DELETE FROM dge_moderation.access_events"),/append-only/);
});

test("roster-class grantees, manager-only administration and cross-tenant canaries",async()=>{
  const roster=await w.electorates.createRoster(owner,tenantId,{kind:"unit-register",name:"Board",commandId:id()});
  await w.electorates.recordEntry(owner,tenantId,roster.id,{principalId:people.participant.accountId,units:"1",class:"directors",
    validFrom:iso(w.time-1000),expectedVersion:0,commandId:id()});
  w.time+=10;
  await grant("s-board",{kind:"roster-class",rosterId:roster.id,class:"directors"},["propose"]);
  assert.equal(await outcome(w.propose(people.participant,doc,"p-board")),"ok");
  assert.equal(await outcome(w.propose(people.editor,doc,"p-board")),"SECTION_RIGHT_REQUIRED");
  for(const who of [people.editor,people.participant,people.viewer])
    assert.equal(await outcome(w.sectionGrants.grant(who,tenantId,doc.id,{sectionId:"s-board",grantee:role(who===people.viewer?"viewer":"editor"),
      rights:["propose"],commandId:id()})),"ACCESS_DENIED","only owners and admins administer grants");
  assert.equal((await w.sectionGrants.list(people.participant,tenantId,doc.id)).grants,undefined,"members never see the grant list");
  assert.equal(await outcome(grant("missing-section",role("editor"),["propose"])),"SECTION_NOT_FOUND");
  assert.equal(await outcome(grant("p-board",role("editor"),["propose"])),"SECTION_NOT_FOUND","grants target sections, not paragraphs");
  assert.equal(await outcome(grant("s-board",role("editor"),["propose","propose"])),"INVALID_SECTION_GRANT");
  const outsider=await w.user();
  const {tenantId:other}=await w.identity.createTenant(outsider);
  assert.equal(await outcome(w.sectionGrants.grant(outsider,other,doc.id,{sectionId:"s-board",grantee:role("viewer"),rights:["read"],commandId:id()})),"DOCUMENT_NOT_FOUND");
  assert.notEqual(await outcome(w.sectionGrants.list(outsider,tenantId,doc.id)),"ok");
  const response=await w.call(`/api/workspaces/${tenantId}/documents/${doc.id}/section-grants`,{who:owner});
  assert.equal(response.status,200);
  assert.equal((await response.json()).restricted,true);
  await w.transaction(async tx=>assert.equal((await tx.query("SELECT * FROM dge_moderation.section_grants")).rows.length,0));
});
