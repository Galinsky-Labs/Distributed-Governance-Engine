import {before,after,beforeEach,test} from "node:test";
import assert from "node:assert/strict";
import {randomUUID,randomBytes,generateKeyPairSync,createHash,sign} from "node:crypto";
import {PGlite} from "@electric-sql/pglite";
import {isoCBOR} from "@simplewebauthn/server/helpers";
import {createIdentityStore,applyIdentityMigrations,AccessError} from "../server/identity-store.mjs";
import {createLegalDocument} from "../src/legal-structure.mjs";
import {createDocumentStore} from "../server/document-store.mjs";
import {createProposalStore} from "../server/proposal-store.mjs";
import {createDecisionStore} from "../server/decision-store.mjs";
import {createEditionStore} from "../server/edition-store.mjs";
import {createSignatureStore} from "../server/signature-store.mjs";
import {createEditionRoutes} from "../server/edition-http.mjs";
import {createSignatureRoutes} from "../server/signature-http.mjs";
import {createAccountHandler} from "../server/account-http.mjs";
import {createLedger,loadLogSigningKey} from "../server/ledger.mjs";
import {createPasskeyVerifiers} from "../server/passkey-verifier.mjs";
import {verifyInclusion,verifyConsistency,fromHex,leafHash} from "../src/transparency.mjs";
import {
  signingChallenge,signingDigest,recordDigest,verifySignatureReceipt,manifestRoot,manifestDigest,CONSENT,
} from "../src/signatures.mjs";

const origin="https://quill.example",rpId="quill.example";
let db,identity,documents,proposals,decisions,editions,signatures,handler,tenantId,owner,member,third,outsider,now,clock;
const transaction=fn=>db.transaction(async tx=>{await tx.exec("SET LOCAL ROLE dge_identity_runtime");return fn(tx);});
const user=async()=>({...await identity.establishSession({issuer:"https://provider.example",subject:randomUUID(),authenticatedAt:Date.now()}),origin});
const verifier=createPasskeyVerifiers();

before(async()=>{db=await PGlite.create();await applyIdentityMigrations(fn=>db.transaction(fn));});
after(async()=>db?.close());
beforeEach(async()=>{
  await db.exec("TRUNCATE dge_identity.accounts,dge_identity.tenants,dge_identity.login_challenges CASCADE");
  now=Date.now();clock=Date.now();
  identity=createIdentityStore({transaction,origin,sessionKey:randomBytes(32),stateKey:randomBytes(32)});
  documents=createDocumentStore({identity,transaction});
  proposals=createProposalStore({identity,transaction});
  decisions=createDecisionStore({identity,clock:()=>now});
  editions=createEditionStore({identity,transaction});
  signatures=createSignatureStore({identity,transaction,origin,clock:()=>clock,
    verifyPasskeyAuthentication:verifier.verifyPasskeyAuthentication});
  owner=await user();member=await user();third=await user();outsider=await user();
  ({tenantId}=await identity.createTenant(owner));
  for(const who of [member,third]){
    const invite=await identity.invite(owner,tenantId,who.accountId,"participant");
    await identity.acceptInvitation(who,tenantId,invite.invitationToken);
  }
  handler=createAccountHandler({store:identity,login:{},origin,
    extensions:[createEditionRoutes({editions}),createSignatureRoutes({signatures})]});
});

async function publish(text="The agency shall report annually."){
  const document=structuredClone(createLegalDocument({id:randomUUID(),tenantId,title:"Signing test"}));
  document.content[0].inlines=[{kind:"text",text}];
  return documents.create(owner,tenantId,{document,commandId:randomUUID(),disclosure:"publish-all-revisions-v1"});
}
const freeze=(saved,kind="final",extra={})=>editions.freeze(owner,tenantId,saved.document.id,{
  commandId:randomUUID(),kind,sourceVersion:saved.version,sourceDigest:saved.digest,...extra});
const intent=(who,editionId,kind="support")=>signatures.createIntent(who,tenantId,editionId,{kind});
const signWith=(who,editionId,issued,body={})=>signatures.sign(who,tenantId,editionId,{
  intentId:issued.intentId,signingDigest:issued.signingDigest,consent:true,
  mark:{type:"typed",text:"Pat Signer",fontId:"caveat"},display:{visibility:"private"},...body});
const support=async(who,editionId,body)=>signWith(who,editionId,await intent(who,editionId),body);
const call=(path,{who=owner,method="GET",body,csrf=true}={})=>handler(new Request(origin+path,{method,headers:{
  cookie:"__Host-dge_session="+who.sessionToken,origin,...(csrf?{"x-dge-csrf":who.csrfToken}:{}),
  ...(body?{"content-type":"application/json"}:{})},...(body?{body:JSON.stringify(body)}:{})}),{peerAddress:"127.0.0.1"});

/** Real ES256 WebAuthn credential; assertions are verified by the pinned production verifier. */
async function enrollPasskey(who){
  const {privateKey,publicKey}=generateKeyPairSync("ec",{namedCurve:"prime256v1"});
  const jwk=publicKey.export({format:"jwk"}),credentialId=randomBytes(32).toString("base64url");
  const cose=isoCBOR.encode(new Map([[1,2],[3,-7],[-1,1],[-2,Buffer.from(jwk.x,"base64url")],[-3,Buffer.from(jwk.y,"base64url")]]));
  await db.query(`INSERT INTO dge_identity.passkey_credentials(id,account_id,credential_id,public_key,sign_count,transports,backed_up,created_at,attestation_policy_id,attestation_format,aaguid)
    VALUES($1,$2,$3,$4,0,'{internal}',false,now(),'test-policy','none','00000000-0000-0000-0000-000000000000')`,
    [randomUUID(),who.accountId,credentialId,Buffer.from(cose).toString("base64url")]);
  let counter=0;
  return (challenge,{clientOrigin=origin}={})=>{
    const data=Buffer.from(JSON.stringify({type:"webauthn.get",challenge,origin:clientOrigin,crossOrigin:false}));
    const auth=Buffer.alloc(37);createHash("sha256").update(rpId).digest().copy(auth);auth[32]=5;auth.writeUInt32BE(++counter,33);
    const signature=sign("sha256",Buffer.concat([auth,createHash("sha256").update(data).digest()]),privateKey);
    return {id:credentialId,rawId:credentialId,type:"public-key",clientExtensionResults:{},response:{
      authenticatorData:auth.toString("base64url"),clientDataJSON:data.toString("base64url"),signature:signature.toString("base64url")}};
  };
}
const asRuntime=(settings,fn)=>db.transaction(async tx=>{
  await tx.exec("SET LOCAL ROLE dge_identity_runtime");
  for(const [key,value] of Object.entries(settings))await tx.query("SELECT set_config($1,$2,true)",[key,value]);
  return fn(tx);
});

test("final editions freeze an exact saved version, survive later draft saves and are logged for anchoring",async()=>{
  const first=await publish();
  const draft=structuredClone(first.document);draft.revision=1;draft.content[0].inlines=[{kind:"text",text:"The agency shall report monthly."}];
  const second=await documents.save(owner,tenantId,first.document.id,{document:draft,commandId:randomUUID(),expectedVersion:1});
  const commandId=randomUUID();
  const edition=await editions.freeze(owner,tenantId,first.document.id,{commandId,kind:"final",sourceVersion:1,sourceDigest:first.digest});
  assert.equal(edition.sourceDigest,first.digest);
  assert.equal(edition.lifecycle,"published");
  assert.equal(edition.ledger.status,"pending");
  assert.deepEqual(await editions.freeze(owner,tenantId,first.document.id,{commandId,kind:"final",sourceVersion:1,sourceDigest:first.digest}),edition);
  await assert.rejects(editions.freeze(owner,tenantId,first.document.id,{commandId,kind:"final",sourceVersion:2,sourceDigest:second.digest}),{code:"COMMAND_REUSED"});
  await assert.rejects(freeze(first),{code:"EDITION_EXISTS"});
  await assert.rejects(freeze({...second,digest:first.digest}),{code:"SOURCE_DIGEST_MISMATCH"});
  await assert.rejects(editions.freeze(member,tenantId,first.document.id,{commandId:randomUUID(),kind:"final",sourceVersion:2,sourceDigest:second.digest}),AccessError);
  const read=await editions.publicRead(edition.id);
  const later=structuredClone(second.document);later.revision=2;later.content[0].inlines=[{kind:"text",text:"Rewritten after freezing."}];
  await documents.save(owner,tenantId,first.document.id,{document:later,commandId:randomUUID(),expectedVersion:2});
  const reread=await editions.publicRead(edition.id);
  assert.deepEqual(reread,read,"later working-draft saves never change an edition");
  assert.equal(reread.document.content[0].inlines[0].text,"The agency shall report annually.");
  assert.equal(reread.document.lifecycle,"published");
  const outbox=(await db.query("SELECT kind,finalization,subject_id FROM dge_ledger.outbox WHERE event_digest=$1",[edition.recordDigest])).rows;
  assert.deepEqual(outbox,[{kind:"final-edition",finalization:true,subject_id:first.document.id}]);
  const listed=await editions.publicList(first.document.id);
  assert.deepEqual(listed.items.map(item=>item.id),[edition.id]);
  await assert.rejects(db.query("UPDATE dge_editions.editions SET kind='final'"),/append-only/);
  await assert.rejects(db.query("DELETE FROM dge_editions.editions"),/append-only/);
});

test("finalization refuses unresolved references and edition kinds must match the document mode",async()=>{
  const saved=await publish();
  const broken=structuredClone(saved.document);broken.revision=1;
  broken.content[0].inlines=[{kind:"text",text:"See "},{kind:"reference",targetId:"missing-node"}];
  const draft=await documents.save(owner,tenantId,saved.document.id,{document:broken,commandId:randomUUID(),expectedVersion:1});
  await assert.rejects(freeze(draft),{code:"LEGAL_REFERENCE_ISSUES"});
  const fixed=structuredClone(saved.document);fixed.revision=2;
  const clean=await documents.save(owner,tenantId,saved.document.id,{document:fixed,commandId:randomUUID(),expectedVersion:2});
  const frozen=await documents.freezeForInput(owner,tenantId,saved.document.id,{commandId:randomUUID(),expectedVersion:3});
  await assert.rejects(freeze(frozen,"final"),{code:"EDITION_KIND_MODE_MISMATCH"});
  await assert.rejects(freeze(clean,"consultation-source"),{code:"EDITION_KIND_MODE_MISMATCH"});
  const source=await freeze(frozen,"consultation-source");
  assert.equal(source.lifecycle,"published");
  assert.equal(source.editionDigest,frozen.digest,"the consultation source is frozen byte-for-byte");
  await assert.rejects(intent(owner,source.id,"execution"),{code:"SIGNATURE_KIND_NOT_ALLOWED"});
});

test("an adopted edition requires the final passed decision certificate that produced that exact version",async()=>{
  const saved=await publish();
  await assert.rejects(freeze(saved,"adopted"),{code:"DECISION_CERTIFICATE_REQUIRED"});
  const proposal=await proposals.create(member,tenantId,saved.document.id,{
    baseVersion:1,selection:{blockId:saved.document.content[0].id,start:24,end:32,quote:"annually"},
    replacement:"quarterly",rationale:"Timely reporting.",commandId:randomUUID(),disclosure:"publish-proposal-v1"});
  const pid=proposal.proposal.id;
  await decisions.open(owner,tenantId,saved.document.id,pid,{commandId:randomUUID(),hours:1});
  for(const who of [owner,member,third])await decisions.cast(who,tenantId,saved.document.id,pid,{choice:"yes",expectedVersion:0,commandId:randomUUID()});
  const opened=await decisions.read(owner,tenantId,saved.document.id,pid);
  now+=3600001;
  const closed=await decisions.close(owner,tenantId,saved.document.id,pid);
  assert.equal(closed.certificate.outcome.status,"passed");
  assert.equal(closed.certificate.appliedVersion,2);
  const applied=await documents.publicRead(saved.document.id);
  const reference={decisionId:closed.certificate.decisionId,certificateDigest:closed.certificateDigest};
  await assert.rejects(freeze(saved,"adopted",reference),{code:"DECISION_DID_NOT_PRODUCE_VERSION"});
  await assert.rejects(freeze(applied,"adopted",{...reference,certificateDigest:"0".repeat(64)}),{code:"DECISION_CERTIFICATE_MISMATCH"});
  await assert.rejects(freeze(applied,"final",reference),{code:"INVALID_EDITION"});
  // The database refuses an adoption row that the decision did not produce, even if a store bug tried.
  const row=(await db.query("SELECT document,digest FROM dge_documents.versions WHERE document_id=$1 AND version=1",[saved.document.id])).rows[0];
  const forgedId=randomUUID();
  await assert.rejects(asRuntime({"dge.tenant_id":tenantId},tx=>tx.query(
    `INSERT INTO dge_editions.editions(tenant_id,id,document_id,sequence,kind,lifecycle,source_version,source_digest,document,edition_digest,decision_id,certificate_digest,record,record_digest,command_id,request_digest,created_by,created_at)
     VALUES($1,$2,$3,1,'adopted','adopted',1,$4,$5,$4,$6,$7,$8,$9,$10,$9,$11,now())`,
    [tenantId,forgedId,saved.document.id,row.digest,{...row.document,lifecycle:"adopted"},reference.decisionId,reference.certificateDigest,
      {editionId:forgedId,editionDigest:row.digest,sourceDigest:row.digest},"a".repeat(64),randomUUID(),owner.accountId])),/passed decision that produced this exact version/);
  const adopted=await freeze(applied,"adopted",reference);
  assert.equal(adopted.lifecycle,"adopted");
  assert.deepEqual(adopted.decision,reference);
  assert.equal(opened.state,"open");
});

test("signing requires explicit consent, honours decline and rejects replayed, expired, foreign or substituted intents",async()=>{
  const edition=await freeze(await publish());
  const other=await freeze(await publish("Fees are waived."));
  const issued=await intent(member,edition.id);
  assert.equal(issued.intent.consentText,CONSENT.support.text);
  assert.equal(issued.signingDigest,signingDigest(issued.intent));
  assert.equal(issued.intent.editionDigest,edition.editionDigest);
  await assert.rejects(signWith(member,edition.id,issued,{consent:false}),{code:"CONSENT_REQUIRED"});
  await assert.rejects(signWith(member,edition.id,issued,{consent:"yes"}),{code:"CONSENT_REQUIRED"});
  await assert.rejects(signWith(third,edition.id,issued),{code:"INTENT_NOT_FOUND"});
  await assert.rejects(signWith(member,other.id,issued),{code:"INTENT_EDITION_MISMATCH"});
  await assert.rejects(signWith(member,edition.id,{...issued,signingDigest:"f".repeat(64)}),{code:"INTENT_DIGEST_MISMATCH"});
  await assert.rejects(signWith(member,edition.id,issued,{mark:{type:"typed",text:"Pat",fontId:"comic-sans"}}),{code:"INVALID_SIGNATURE"});
  const declined=await intent(member,edition.id);
  assert.deepEqual(await signatures.declineIntent(member,tenantId,edition.id,declined.intentId),{intentId:declined.intentId,outcome:"declined"});
  await assert.rejects(signWith(member,edition.id,declined),{code:"INTENT_ALREADY_USED"});
  const signed=await signWith(member,edition.id,issued);
  assert.equal(signed.record.consent,true);
  assert.equal(signed.record.intentDigest,issued.signingDigest);
  assert.equal(signed.recordDigest,recordDigest(signed.record));
  await assert.rejects(signWith(member,edition.id,issued),{code:"INTENT_ALREADY_USED"});
  await assert.rejects(intent(member,edition.id),{code:"ALREADY_SIGNED"});
  const late=await intent(third,edition.id);
  clock+=900001;
  await assert.rejects(signWith(third,edition.id,late),{code:"INTENT_EXPIRED"});
  await assert.rejects(intent(outsider,edition.id),AccessError);
  // Intent bytes cannot be rewritten once closed.
  await assert.rejects(db.query("UPDATE dge_signatures.intents SET outcome=NULL,closed_at=NULL WHERE id=$1",[issued.intentId]),/closed once/);
});

test("concurrent signing by one account leaves exactly one active signature",async()=>{
  const edition=await freeze(await publish());
  const [a,b]=[await intent(member,edition.id),await intent(member,edition.id)];
  const results=await Promise.allSettled([signWith(member,edition.id,a),signWith(member,edition.id,b)]);
  assert.equal(results.filter(r=>r.status==="fulfilled").length,1);
  assert.equal(results.find(r=>r.status==="rejected").reason.code,"ALREADY_SIGNED");
  assert.equal((await db.query("SELECT count(*)::int AS n FROM dge_signatures.active WHERE edition_id=$1",[edition.id])).rows[0].n,1);
  const record=(await db.query("SELECT record_id FROM dge_signatures.active WHERE edition_id=$1",[edition.id])).rows[0].record_id;
  await assert.rejects(db.query("INSERT INTO dge_signatures.active(tenant_id,edition_id,kind,account_id,record_id,display) VALUES($1,$2,'support',$3,$4,'private')",
    [tenantId,edition.id,member.accountId,record]),/duplicate key/);
});

test("execution follows the configured order and requires a passkey assertion bound to the signing digest",async()=>{
  const edition=await freeze(await publish());
  await assert.rejects(signatures.configureSignatories(member,tenantId,edition.id,{signatories:[{accountId:member.accountId,capacity:"President"}]}),AccessError);
  await assert.rejects(signatures.configureSignatories(owner,tenantId,edition.id,{signatories:[{accountId:outsider.accountId,capacity:"Guest"}]}),{code:"SIGNATORY_NOT_MEMBER"});
  await signatures.configureSignatories(owner,tenantId,edition.id,{signatories:[
    {accountId:owner.accountId,capacity:"Secretary, Acme Inc."},{accountId:member.accountId,capacity:"President, Acme Inc."}]});
  await assert.rejects(signatures.configureSignatories(owner,tenantId,edition.id,{signatories:[{accountId:third.accountId,capacity:"Clerk"}]}),{code:"SIGNATORIES_ALREADY_CONFIGURED"});
  await assert.rejects(intent(member,edition.id,"execution"),{code:"SIGNING_ORDER_VIOLATION"});
  await assert.rejects(intent(third,edition.id,"execution"),{code:"NOT_A_SIGNATORY"});
  await assert.rejects(intent(owner,edition.id,"execution"),{code:"PASSKEY_NOT_ENROLLED"});
  // The database rejects an out-of-order active execution signature on its own.
  const placeholder=await support(member,edition.id);
  await assert.rejects(asRuntime({"dge.tenant_id":tenantId},tx=>tx.query(
    "INSERT INTO dge_signatures.active(tenant_id,edition_id,kind,account_id,record_id,display) VALUES($1,$2,'execution',$3,$4,'private')",
    [tenantId,edition.id,member.accountId,placeholder.signatureId])),/configured order/);
  const assertOwner=await enrollPasskey(owner);
  const issued=await intent(owner,edition.id,"execution");
  assert.equal(issued.intent.capacity,"Secretary, Acme Inc.");
  assert.equal(issued.passkey.required,true);
  assert.equal(issued.passkey.challenge,signingChallenge(issued.signingDigest));
  assert.equal(Buffer.from(issued.passkey.challenge,"base64url").toString("hex"),issued.signingDigest);
  await assert.rejects(signWith(owner,edition.id,issued),{code:"PASSKEY_REQUIRED"});
  const unrelated=signingChallenge(createHash("sha256").update("another intent").digest("hex"));
  await assert.rejects(signWith(owner,edition.id,issued,{passkey:assertOwner(unrelated)}),{code:"PASSKEY_VERIFICATION_FAILED"});
  await assert.rejects(signWith(owner,edition.id,issued,{passkey:assertOwner(issued.passkey.challenge,{clientOrigin:"https://attacker.example"})}),{code:"PASSKEY_VERIFICATION_FAILED"});
  const executed=await signWith(owner,edition.id,issued,{passkey:assertOwner(issued.passkey.challenge)});
  assert.equal(executed.record.kind,"execution");
  assert.equal(executed.record.capacity,"Secretary, Acme Inc.");
  assert.equal(executed.record.method,"typed+passkey");
  assert.equal(executed.record.assurance.passkey,true);
  assert.match(executed.record.assurance.sessionAuthenticatedAt,/^\d{4}-/);
  const assertMember=await enrollPasskey(member);
  const second=await intent(member,edition.id,"execution");
  const signedSecond=await signWith(member,edition.id,second,{passkey:assertMember(second.passkey.challenge)});
  assert.equal(signedSecond.record.capacity,"President, Acme Inc.");
  const listed=await signatures.signatories(member,tenantId,edition.id);
  assert.deepEqual(listed.signatories.map(s=>s.signed),[true,true]);
});

test("private ink and identities stay with the signer and managers; the public sees only opted-in names",async()=>{
  const edition=await freeze(await publish());
  const ink={type:"drawn",strokes:[[10,10,40,60,90,20],[100,100,120,140]]};
  const hidden=await support(member,edition.id,{mark:ink,display:{visibility:"private"}});
  const shown=await support(third,edition.id,{mark:{type:"typed",text:"Jordan Public",fontId:"dancing-script"},display:{visibility:"public",name:"Jordan Public"}});
  await assert.rejects(support(owner,edition.id,{mark:{type:"drawn",strokes:[[1001,10]]}}),{code:"INVALID_SIGNATURE"});
  await assert.rejects(support(owner,edition.id,{mark:{type:"drawn",strokes:Array.from({length:65},()=>[1,1])}}),{code:"INVALID_SIGNATURE"});
  await signatures.freezeManifest(owner,tenantId,edition.id,{kind:"support"});
  const publicHidden=await signatures.publicReceipt(edition.id,hidden.recordDigest);
  assert.equal(publicHidden.record,null);
  assert.equal(publicHidden.mark,null);
  assert.equal(publicHidden.display,"private");
  assert.equal(verifySignatureReceipt(publicHidden).valid,true);
  const publicShown=await signatures.publicReceipt(edition.id,shown.recordDigest);
  assert.equal(publicShown.record.publicName,"Jordan Public");
  assert.equal(publicShown.mark.text,"Jordan Public");
  const directory=await signatures.directory(edition.id,{kind:"support"});
  assert.deepEqual(directory.items.map(i=>i.name),["Jordan Public"]);
  assert.equal(directory.total,2);
  assert.equal(directory.publiclyNamed,1);
  const exported=[];for await(const chunk of signatures.exportManifest(edition.id,"support",1,"json"))exported.push(chunk);
  const serialized=JSON.stringify([publicHidden,directory,exported.join("")]);
  for(const secret of [member.accountId,third.accountId,"[10,10,40,60,90,20]","Pat Signer"])assert.ok(!serialized.includes(secret),"public output leaked private evidence");
  await assert.rejects(signatures.list(member,tenantId,edition.id,{kind:"support"}),AccessError);
  const managerView=await signatures.list(owner,tenantId,edition.id,{kind:"support"});
  assert.deepEqual(managerView.items.find(i=>i.id===hidden.signatureId).mark,ink);
  const mine=await signatures.mine(member,tenantId,edition.id);
  assert.deepEqual(mine.items.map(i=>i.mark),[ink]);
  const theirs=await signatures.mine(third,tenantId,edition.id);
  assert.ok(!JSON.stringify(theirs).includes("[10,10,40,60,90,20]"));
  await assert.rejects(signatures.receipt(third,tenantId,edition.id,hidden.signatureId),{code:"SIGNATURE_NOT_FOUND"});
  for(const settings of [{},{"dge.public_edition_id":edition.id}])
    await asRuntime(settings,async tx=>{
      for(const table of ["evidence","active","intents","signatories"])
        assert.equal((await tx.query(`SELECT * FROM dge_signatures.${table}`)).rows.length,0,table+" must stay tenant-private");
      if(settings["dge.public_edition_id"])
        assert.equal((await tx.query("SELECT * FROM dge_signatures.records WHERE public_record IS NOT NULL")).rows.length,1);
    });
});

test("withdrawal and dispute are new records; history is never erased",async()=>{
  const edition=await freeze(await publish());
  const signed=await support(member,edition.id,{display:{visibility:"public",name:"Morgan Member"}});
  const withdrawn=await signatures.withdraw(member,tenantId,edition.id,signed.signatureId);
  assert.equal(withdrawn.record.action,"withdraw");
  assert.equal(withdrawn.record.signatureRecordDigest,signed.recordDigest);
  await assert.rejects(signatures.withdraw(member,tenantId,edition.id,signed.signatureId),{code:"SIGNATURE_NOT_ACTIVE"});
  await assert.rejects(signatures.withdraw(third,tenantId,edition.id,signed.signatureId),{code:"SIGNATURE_NOT_ACTIVE"});
  assert.equal((await signatures.directory(edition.id,{kind:"support"})).items.length,0);
  const again=await support(member,edition.id);
  const dispute=await signatures.dispute(owner,tenantId,edition.id,again.signatureId,{reason:"not-signer"});
  assert.equal(dispute.record.raisedBy,"manager");
  await assert.rejects(signatures.dispute(owner,tenantId,edition.id,again.signatureId,{reason:"other"}),{code:"DISPUTE_EXISTS"});
  await assert.rejects(signatures.dispute(third,tenantId,edition.id,again.signatureId,{reason:"other"}),{code:"ACCESS_DENIED"});
  const history=(await db.query("SELECT action FROM dge_signatures.records WHERE edition_id=$1 ORDER BY seq",[edition.id])).rows.map(r=>r.action);
  assert.deepEqual(history,["sign","withdraw","sign","dispute"]);
  await assert.rejects(db.query("DELETE FROM dge_signatures.records"),/append-only/);
  await assert.rejects(db.query("UPDATE dge_signatures.evidence SET mark='{}'"),/append-only/);
  const frozen=await signatures.freezeManifest(owner,tenantId,edition.id,{kind:"support"});
  assert.equal(frozen.manifest.size,4);
  assert.equal(frozen.manifest.activeSigners,1);
  assert.equal(frozen.manifest.publicSigners,0);
  const receipt=await signatures.receipt(member,tenantId,edition.id,signed.signatureId);
  assert.equal(receipt.record.publicName,"Morgan Member","the withdrawn signature remains provable");
  assert.equal(verifySignatureReceipt(receipt).valid,true);
});

test("manifest receipts verify independently, re-freezes append new versions and the ledger anchors each root",async()=>{
  const edition=await freeze(await publish());
  const first=[];for(const who of [owner,member,third])first.push(await support(who,edition.id));
  await assert.rejects(signatures.freezeManifest(member,tenantId,edition.id,{kind:"support"}),AccessError);
  const v1=await signatures.freezeManifest(owner,tenantId,edition.id,{kind:"support"});
  assert.equal(v1.manifest.version,1);
  assert.equal(v1.manifest.size,3);
  assert.equal(v1.digest,manifestDigest(v1.manifest));
  assert.deepEqual(manifestRoot(first.map(s=>s.recordDigest)),{size:3,rootHash:v1.manifest.rootHash});
  for(const [i,item] of first.entries()){
    const receipt=await signatures.receipt(i===0?owner:i===1?member:third,tenantId,edition.id,item.signatureId);
    assert.equal(verifySignatureReceipt(receipt).valid,true);
    assert.equal(verifySignatureReceipt(receipt).checks.intentDigest,true);
    // Independent check using only RFC 6962 primitives.
    assert.equal(verifyInclusion({leaf:leafHash(fromHex(item.recordDigest)),index:receipt.position,treeSize:3,proof:receipt.proof,root:v1.manifest.rootHash}),true);
    const tampered=structuredClone(receipt);tampered.proof[0]=tampered.proof[0].replace(/^./,c=>c==="0"?"1":"0");
    assert.equal(verifySignatureReceipt(tampered).valid,false);
    const forged=structuredClone(receipt);forged.record.publicName="Someone Else";forged.record.display="public";
    assert.equal(verifySignatureReceipt(forged).valid,false);
  }
  const again=await signatures.freezeManifest(owner,tenantId,edition.id,{kind:"support"});
  assert.equal(again.created,false);
  assert.equal(again.digest,v1.digest);
  const second=await signatures.withdraw(member,tenantId,edition.id,first[1].signatureId);
  const v2=await signatures.freezeManifest(owner,tenantId,edition.id,{kind:"support"});
  assert.equal(v2.manifest.version,2);
  assert.equal(v2.manifest.previousRootHash,v1.manifest.rootHash);
  assert.equal(v2.manifest.activeSigners,2);
  assert.equal(verifyConsistency({first:3,second:4,firstRoot:v1.manifest.rootHash,secondRoot:v2.manifest.rootHash,proof:v2.consistency}),true);
  assert.deepEqual((await signatures.manifest(edition.id,"support",1)).manifest,v1.manifest,"old manifest versions never change");
  const listed=await signatures.manifests(edition.id,{kind:"support"});
  assert.deepEqual(listed.items.map(i=>i.manifest.version),[2,1]);
  const withdrawalReceipt=await signatures.publicReceipt(edition.id,second.recordDigest);
  assert.equal(withdrawalReceipt.position,3);
  assert.equal(verifySignatureReceipt(withdrawalReceipt).valid,true);
  await assert.rejects(db.query("UPDATE dge_signatures.manifests SET size=1"),/append-only/);
  await assert.rejects(db.query("UPDATE dge_signatures.manifest_heads SET size=1,version=version+1"),/only grow/);
  await assert.rejects(db.query("DELETE FROM dge_signatures.manifest_nodes"),/append-only/);
  const outbox=(await db.query("SELECT event_digest,finalization FROM dge_ledger.outbox WHERE kind='signature-manifest' ORDER BY created_at")).rows;
  assert.deepEqual(outbox.map(r=>[r.event_digest,r.finalization]).sort(),[[v1.digest,true],[v2.digest,true]].sort());
  const {privateKey}=generateKeyPairSync("ed25519");
  const ledger=createLedger({transaction,logId:"quill.test",signingKey:loadLogSigningKey(privateKey.export({format:"der",type:"pkcs8"}).toString("base64"))});
  await ledger.tick();
  const anchored=await signatures.receipt(owner,tenantId,edition.id,first[0].signatureId);
  assert.equal(typeof anchored.ledger.seq,"number");
  assert.equal((await ledger.proof({eventDigest:anchored.ledger.eventDigest,kind:"signature-manifest"})).status,"included");
});

test("HTTP routes stream redacted JSON and CSV manifests, page the directory and keep the request boundary",async()=>{
  const edition=await freeze(await publish());
  const base="/api/workspaces/"+tenantId+"/editions/"+edition.id;
  let response=await call(base+"/intents",{who:member,method:"POST",body:{kind:"support"},csrf:false});
  assert.equal(response.status,403);
  response=await call(base+"/intents",{who:member,method:"POST",body:{kind:"support"}});
  assert.equal(response.status,200);
  const issued=await response.json();
  response=await call(base+"/signatures",{who:member,method:"POST",body:{intentId:issued.intentId,signingDigest:issued.signingDigest,consent:true,
    mark:{type:"drawn",strokes:[[5,5,50,50]]},display:{visibility:"private"},accountId:owner.accountId}});
  assert.equal(response.status,400,"unknown fields are refused");
  response=await call(base+"/signatures",{who:member,method:"POST",body:{intentId:issued.intentId,signingDigest:issued.signingDigest,consent:true,
    mark:{type:"drawn",strokes:[[5,5,50,50]]},display:{visibility:"private"}}});
  assert.equal(response.status,200);
  const hidden=await response.json();
  for(const [who,name] of [[third,"=SUM(A1)"],[owner,"Avery, \"Ace\" Owner"]])
    await support(who,edition.id,{display:{visibility:"public",name}});
  response=await call(base+"/manifests",{method:"POST",body:{kind:"support"}});
  assert.equal(response.status,200);
  const frozen=await response.json();
  response=await call("/api/public/editions/"+edition.id+"/manifests/support/1/entries.csv",{who:outsider});
  assert.equal(response.status,200);
  assert.match(response.headers.get("content-type"),/^text\/csv/);
  assert.match(response.headers.get("content-disposition"),/attachment; filename="signature-manifest-.*-support-v1\.csv"/);
  const csv=await response.text();
  const lines=csv.trim().split("\n");
  assert.equal(lines[0],"position,record_digest,action,display,public_name,signed_at,method,capacity");
  assert.equal(lines[1],"0,"+hidden.recordDigest+",sign,private,,,,");
  assert.match(lines[2],/^1,[a-f0-9]{64},sign,public,"'=SUM\(A1\)",/);
  assert.match(lines[3],/"Avery, ""Ace"" Owner"/);
  response=await call("/api/public/editions/"+edition.id+"/manifests/support/1/entries.json",{who:outsider});
  const full=await response.json();
  assert.equal(full.digest,frozen.digest);
  assert.equal(full.entries.length,3);
  assert.deepEqual(full.entries[0],{position:0,recordDigest:hidden.recordDigest,action:"sign",display:"private"});
  assert.deepEqual(manifestRoot(full.entries.map(e=>e.recordDigest)).rootHash,full.manifest.rootHash);
  response=await call("/api/public/editions/"+edition.id+"/manifests/support/9/entries.csv");
  assert.equal(response.status,404);
  response=await call("/api/public/editions/"+edition.id+"/directory?kind=support&limit=1");
  const page1=await response.json();
  assert.equal(page1.items.length,1);
  response=await call("/api/public/editions/"+edition.id+"/directory?kind=support&limit=1&after="+page1.nextCursor);
  const page2=await response.json();
  assert.notEqual(page2.items[0].name,page1.items[0].name);
  assert.equal(page2.nextCursor,null);
  response=await call("/api/public/editions/"+edition.id+"/directory?kind=support&q=av");
  assert.deepEqual((await response.json()).items.map(i=>i.name),['Avery, "Ace" Owner']);
  response=await call("/api/public/editions/"+edition.id+"/receipts/"+hidden.recordDigest);
  assert.equal(verifySignatureReceipt(await response.json()).valid,true);
  response=await call("/api/public/editions/"+edition.id);
  assert.equal((await response.json()).editionDigest,edition.editionDigest);
  response=await call("/api/public/editions?documentId="+edition.documentId);
  assert.equal((await response.json()).items.length,1);
  response=await call(base+"/signatures/"+hidden.signatureId+"/receipt",{who:member});
  assert.equal(verifySignatureReceipt(await response.json()).checks.intentDigest,true);
});

test("cross-tenant canaries: another workspace cannot read, sign or freeze this workspace's editions",async()=>{
  const edition=await freeze(await publish());
  await support(member,edition.id,{mark:{type:"drawn",strokes:[[7,7,8,8]]}});
  const {tenantId:otherTenant}=await identity.createTenant(outsider);
  await assert.rejects(signatures.createIntent(outsider,otherTenant,edition.id,{kind:"support"}),{code:"EDITION_NOT_FOUND"});
  await assert.rejects(signatures.createIntent(outsider,tenantId,edition.id,{kind:"support"}),AccessError);
  await assert.rejects(signatures.freezeManifest(outsider,otherTenant,edition.id,{kind:"support"}),{code:"EDITION_NOT_FOUND"});
  await assert.rejects(signatures.list(outsider,otherTenant,edition.id,{kind:"support"}),{code:"EDITION_NOT_FOUND"});
  await assert.rejects(editions.list(outsider,tenantId,edition.documentId),AccessError);
  assert.deepEqual((await editions.list(outsider,otherTenant,edition.documentId)).items,[]);
  await asRuntime({"dge.tenant_id":otherTenant},async tx=>{
    for(const table of ["records","evidence","active","intents","directory","manifest_queue"])
      assert.equal((await tx.query(`SELECT * FROM dge_signatures.${table}`)).rows.length,0,table);
    assert.equal((await tx.query("SELECT * FROM dge_editions.editions")).rows.length,0);
    await assert.rejects(tx.query("INSERT INTO dge_signatures.directory(tenant_id,edition_id,kind,record_id,seq,public_name,name_key,signed_at) SELECT $1,$2,'support',$3,1,'x','x',now()",
      [tenantId,edition.id,randomUUID()]),/row-level security/);
  });
});
