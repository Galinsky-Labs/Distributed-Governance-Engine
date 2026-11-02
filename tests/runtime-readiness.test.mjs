import test from "node:test";
import assert from "node:assert/strict";
import {createEngineApplication} from "../server/application.mjs";
const origin="https://quill.example";
const request=(path,method="GET")=>new Request(origin+path,{method});
test("runtime liveness and readiness are distinct, safe and fail closed",async()=>{
  let healthy=false,checks=0;
  const application=createEngineApplication({
    origin,product:"charter",
    accounts:async()=>new Response("Unexpected authentication route"),
    readiness:async()=>{checks++;if(!healthy)throw Error("database URL and password unavailable");}
  });
  assert.equal((await application(request("/healthz"))).status,200);
  let result=await application(request("/readyz"));
  assert.equal(result.status,503);
  assert.deepEqual(await result.json(),{status:"unavailable"});
  assert.equal(result.headers.get("cache-control"),"no-store");
  healthy=true;
  result=await application(request("/readyz"));
  assert.equal(result.status,200);
  assert.deepEqual(await result.json(),{status:"ready"});
  assert.equal(checks,2);
  result=await application(request("/readyz","POST"));
  assert.equal(result.status,405);
  assert.equal(checks,2,"Write method must not perform readiness I/O");
  const without=createEngineApplication({origin,accounts:async()=>new Response("unused")});
  assert.equal((await without(request("/readyz"))).status,503);
  const wrong=await application(new Request("https://wrong.example/readyz"));
  assert.equal(wrong.status,400);
});
