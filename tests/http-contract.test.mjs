import {before,after,test} from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {randomUUID,randomBytes,generateKeyPairSync} from "node:crypto";
import {PGlite} from "@electric-sql/pglite";
import {createIdentityStore,applyIdentityMigrations} from "../server/identity-store.mjs";
import {createPlatform} from "../server/platform.mjs";
import {loadLogSigningKey} from "../server/ledger.mjs";
import {ENGINE_ROUTES,buildOpenApi,HTTP_CONTRACT_VERSION} from "../src/http-contract.mjs";
import {ENGINE_CONTRACT_VERSION} from "../src/extension-sdk.mjs";

const origin="https://quill.example";
let db,platform;
before(async()=>{
  db=await PGlite.create();
  await applyIdentityMigrations(fn=>db.transaction(fn));
  const transaction=fn=>db.transaction(async tx=>{await tx.exec("SET LOCAL ROLE dge_identity_runtime");return fn(tx);});
  const identity=createIdentityStore({transaction,origin,sessionKey:randomBytes(32),stateKey:randomBytes(32)});
  const {privateKey}=generateKeyPairSync("ed25519");
  platform=createPlatform({identity,transaction,login:{start:async()=>({authorizationUrl:origin+"/x",cookie:"a=b"}),complete:async()=>{throw Error("no");}},origin,
    logId:"quill.contract.test",logSigningKey:loadLogSigningKey(privateKey.export({format:"der",type:"pkcs8"}).toString("base64")),
    notificationTokenKey:randomBytes(32),privateWorkspaces:true,passkeySignin:true});
});
after(async()=>db?.close());

const concrete=path=>path.replace(/\{provider\}/g,"stripe").replace(/\{[a-zA-Z]+\}/g,()=>randomUUID());

test("every documented route is served by the platform with the documented method",async()=>{
  const missing=[];
  for(const [i,[method,path]] of ENGINE_ROUTES.entries()){
    const response=await platform.application(new Request(origin+concrete(path),{method,headers:{origin,
      ...(method==="GET"||method==="DELETE"?{}:{"content-type":"application/json"})},...(method==="GET"||method==="DELETE"?{}:{body:"{}"})}),{peerAddress:"10.0."+(i>>8)+"."+(i&255)});
    const text=await response.text();
    let code=null;try{code=JSON.parse(text).error;}catch{}
    if(response.status===429||response.status===405||(response.status===404&&(code==="NOT_FOUND"||code===null)))missing.push(method+" "+path+" -> "+response.status+" "+(code??text.slice(0,40)));
  }
  assert.deepEqual(missing,[]);
  // Control: an undocumented path is detected by the same probe.
  const control=await platform.application(new Request(origin+"/api/workspaces/"+randomUUID()+"/not-a-route",{headers:{origin}}),{peerAddress:"127.0.0.2"});
  assert.equal(control.status,404);
});

test("the committed OpenAPI document is generated from the contract table",async()=>{
  const committed=JSON.parse(await readFile(new URL("../docs/sdk/openapi.json",import.meta.url),"utf8"));
  assert.deepEqual(committed,buildOpenApi());
  assert.equal(HTTP_CONTRACT_VERSION,ENGINE_CONTRACT_VERSION);
  const ids=Object.values(committed.paths).flatMap(p=>Object.values(p).map(o=>o.operationId));
  assert.equal(new Set(ids).size,ids.length,"operation IDs are unique");
  assert.equal(new Set(ENGINE_ROUTES.map(([m,p])=>m+" "+p)).size,ENGINE_ROUTES.length);
});
