import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {canonicalize} from "../src/integrity.mjs";
import {memoryLog,fromHex,leafHash} from "../src/transparency.mjs";
import {
  signatureIntent,signingDigest,signingChallenge,signatureRecord,recordDigest,validateMark,displayText,nameKey,
  manifestRoot,base64url,INK_LIMITS,followUpRecord,CONSENT,
} from "../src/signatures.mjs";

const intentInput={tenantId:"11111111-1111-4111-8111-111111111111",documentId:"22222222-2222-4222-8222-222222222222",
  editionId:"33333333-3333-4333-8333-333333333333",editionDigest:"a".repeat(64),artifactDigest:"b".repeat(64),kind:"execution",
  capacity:"Secretary, Acme Inc.",accountId:"44444444-4444-4444-8444-444444444444",nonce:"c".repeat(64),
  issuedAt:"2026-11-14T12:00:00.000Z",expiresAt:"2026-11-14T12:15:00.000Z"};
const recordInput=intent=>({intent,mark:{type:"drawn",strokes:[[0,0,1000,400]]},display:{visibility:"public",name:"Pat Q. Signer"},
  assurance:{sessionAuthenticatedAt:"2026-11-14T11:58:00.000Z",sessionAssurance:"multifactor",passkey:true},signedAt:"2026-11-14T12:01:00.000Z"});

test("signing, mark and record digests are pinned golden vectors over exact canonical bytes",()=>{
  const intent=signatureIntent(intentInput);
  const digest=signingDigest(intent);
  assert.equal(digest,"358a19805e1f576ef90717d5b8561e838633c2373e01b35fc129fb34044aa609");
  // Independent recomputation with node:crypto over the documented byte layout.
  const bytes=Buffer.from("dce-c14n-v0-dev\0quill-signature-intent-v1\0"+canonicalize(intent),"utf8");
  assert.equal(createHash("sha256").update(bytes).digest("hex"),digest);
  assert.equal(signingChallenge(digest),"NYoZgF4fV275BxfVuFYeg4Yzwjc-AbNfwSn7NARKpgk");
  assert.equal(signingChallenge(digest),Buffer.from(digest,"hex").toString("base64url"));
  const record=signatureRecord(recordInput(intent));
  assert.equal(record.mark.digest,"87202f4848e6e341d4953a169697a966fdd1344adda674d5e2f5e4fabbdf0c73");
  assert.equal(recordDigest(record),"208475f8cecb3bfb155d38f0ebb2d820c6ffa96041d5f651074c73bf7f980bed");
  assert.equal(recordDigest(JSON.parse(JSON.stringify(record))),recordDigest(record),"key order and transport do not change the digest");
  assert.notEqual(signingDigest({...intent,capacity:"Secretary, Acme Inc"}),digest,"one changed byte changes the digest");
  assert.notEqual(signingDigest({...intent,editionDigest:"d".repeat(64)}),digest,"a different edition is a different assent");
  assert.throws(()=>signingDigest({...intent,consentText:CONSENT.execution.text+" "}),/consent/);
  assert.throws(()=>signingDigest({...intent,extra:true}),/Unexpected intent fields/);
  for(const n of [1,2,3]){const value=base64url(Uint8Array.from({length:n},(_,i)=>250+i));assert.equal(value,Buffer.from(Uint8Array.from({length:n},(_,i)=>250+i)).toString("base64url"));}
});

test("manifest roots equal the RFC 6962 transparency log root for every size",async()=>{
  const log=memoryLog(),digests=[];
  assert.equal(manifestRoot([]).size,0);
  for(let i=0;i<70;i++){
    const value=createHash("sha256").update("record "+i).digest("hex");
    digests.push(value);await log.append(leafHash(fromHex(value)));
    assert.deepEqual(manifestRoot(digests),{size:i+1,rootHash:await log.root()});
  }
  assert.deepEqual(manifestRoot(["d".repeat(64),"e".repeat(64),"f".repeat(64)]),
    {size:3,rootHash:"d12638e09d02081294a450d1d153461578382a47b16163011211c483332beb5e"});
});

test("visual marks are bounded, licensed and never accepted as identity material",()=>{
  assert.deepEqual(validateMark({type:"none"},"support"),{type:"none"});
  assert.throws(()=>validateMark({type:"none"},"execution"),/required/);
  assert.throws(()=>validateMark({type:"typed",text:"Pat",fontId:"unlicensed"},"support"),/font/);
  assert.throws(()=>validateMark({type:"typed",text:"Pat‮evil",fontId:"caveat"},"support"));
  assert.throws(()=>validateMark({type:"drawn",strokes:[[1,2,3]]},"support"),/stroke/);
  assert.throws(()=>validateMark({type:"drawn",strokes:[[1.5,2]]},"support"),/coordinate/);
  assert.throws(()=>validateMark({type:"drawn",strokes:[[0,INK_LIMITS.height+1]]},"support"),/coordinate/);
  assert.throws(()=>validateMark({type:"drawn",strokes:Array.from({length:5},()=>Array(1000*2).fill(1))},"support"),/Too many/);
  assert.throws(()=>validateMark({type:"drawn",strokes:[[1,1]],svg:"<svg/>"},"support"),/Unexpected/);
  assert.equal(displayText("  Ana \n  María  "),"Ana María");
  assert.equal(nameKey("ÁNA"),"ána");
  const intent=signatureIntent({...intentInput,kind:"support",capacity:null});
  const record=signatureRecord({...recordInput(intent),display:{visibility:"private"},assurance:{...recordInput(intent).assurance,passkey:false}});
  assert.equal(record.publicName,null);
  assert.equal(record.method,"drawn");
  assert.ok(!JSON.stringify(record).includes("1000,400"),"the record holds a mark digest, not the ink");
  const withdrawal=followUpRecord({action:"withdraw",signature:record,nonce:"e".repeat(64),at:"2026-11-15T00:00:00.000Z"});
  assert.equal(withdrawal.signatureRecordDigest,recordDigest(record));
  assert.throws(()=>followUpRecord({action:"withdraw",signature:record,raisedBy:"manager",nonce:"e".repeat(64),at:"2026-11-15T00:00:00.000Z"}),/signer/);
});
