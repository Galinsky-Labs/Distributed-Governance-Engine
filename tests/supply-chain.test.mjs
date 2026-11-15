import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {inventory,supplyChainProblems,sbom} from "../scripts/supply-chain.mjs";

test("the committed lockfiles pass the supply-chain policy and the committed SBOM is regenerated exactly",async()=>{
  const data=await inventory();
  assert.deepEqual(supplyChainProblems(data),[]);
  const committed=JSON.parse(await readFile(new URL("../security/sbom.cdx.json",import.meta.url),"utf8"));
  assert.deepEqual(committed,sbom(data),"run npm run sbom after changing a lockfile");
  assert.equal(committed.components.length,data.npm.length+data.cargo.filter(c=>c.source).length);
  assert.ok(committed.components.every(c=>c.purl&&(c.hashes?.length||c.externalReferences?.[0]?.type==="vcs")));
});

test("the policy rejects ranges, unhashed packages, foreign hosts, new install scripts and unpinned crates",async()=>{
  const data=await inventory();
  const bad=structuredClone(data);
  bad.pkg.dependencies={...bad.pkg.dependencies,"left-pad":"^1.3.0"};
  bad.npm.push({path:"node_modules/x",name:"x",version:"1.0.0",resolved:"https://evil.example/x.tgz",integrity:null,installScript:true});
  bad.cargo.push({name:"y",version:"1.0.0",source:"git+https://github.com/someone/y.git?branch=main",checksum:null});
  const problems=supplyChainProblems(bad).join("\n");
  for(const expected of ["left-pad: dependency spec","node_modules/x: missing sha512","unexpected source host evil.example","node_modules/x: new install script","y: unexpected crate source"])
    assert.ok(problems.includes(expected),expected);
});
