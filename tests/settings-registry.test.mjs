import test from "node:test";
import assert from "node:assert/strict";
import {
  SETTINGS_REGISTRY,HARD_INVARIANTS,settingDefinition,normalizeSettingValue,validateSettingsChange,
  applySettingsChanges,settingsDelta,resolveEffectiveSettings,diffEffectiveSettings,periodWindow,validTimeZone,
} from "../src/settings-registry.mjs";

const iso=window=>[new Date(window.start).toISOString(),new Date(window.end).toISOString()];

test("every definition has a validated, frozen default and the required parameter families",()=>{
  for(const definition of SETTINGS_REGISTRY){
    assert(Object.isFrozen(definition.default)||typeof definition.default!=="object",definition.key);
    assert.deepEqual(normalizeSettingValue(definition.key,definition.default),definition.default);
  }
  for(const prefix of ["documents.","votes.","trust.","points.","abuse.","organization.","anchoring.","export.","billing.","quotas.","officials.","roles.","notifications.","retention.","invariants."])
    assert(SETTINGS_REGISTRY.some(d=>d.key.startsWith(prefix)),prefix);
  assert.deepEqual(settingDefinition("billing.catalog").default,[]);
  assert.equal(settingDefinition("nope"),null);
  assert.equal(HARD_INVARIANTS.length,5);
});

test("typed values are validated exactly and normalized",()=>{
  assert.equal(normalizeSettingValue("votes.quorumFraction","0.5000"),"0.5");
  assert.equal(normalizeSettingValue("votes.quorumFraction","1"),"1");
  for(const bad of ["0","0.00001","1.0001","-0.5","0.5e1",0.5,".5","01"])
    assert.throws(()=>normalizeSettingValue("votes.quorumFraction",bad),{code:"INVALID_SETTING_VALUE"},String(bad));
  for(const bad of [-1,721,1.5,"24",-0])assert.throws(()=>normalizeSettingValue("votes.deliberationHours",bad),{code:"INVALID_SETTING_VALUE"});
  assert.throws(()=>normalizeSettingValue("quotas.weekTimeZone","Mars/Olympus_Mons"),{code:"INVALID_SETTING_VALUE"});
  assert.equal(normalizeSettingValue("quotas.weekTimeZone","Europe/Paris"),"Europe/Paris");
  assert.throws(()=>normalizeSettingValue("documents.modesAllowed",["collaboration","collaboration"]),/unique/);
  assert.throws(()=>normalizeSettingValue("documents.modesAllowed",[]),{code:"INVALID_SETTING_VALUE"});
  const sparse=["collaboration"];sparse.length=2;
  assert.throws(()=>normalizeSettingValue("documents.modesAllowed",sparse),{code:"INVALID_SETTING_VALUE"});
  let touched=false;
  const accessor=Object.defineProperty({},"mode",{enumerable:true,get(){touched=true;return "unlimited";}});
  assert.throws(()=>normalizeSettingValue("officials.grantPolicy",accessor),{code:"INVALID_SETTING_VALUE"});
  assert.equal(touched,false);
  assert.throws(()=>normalizeSettingValue("officials.grantPolicy",{mode:"monthly-cap"}),/monthly cap is required/);
  assert.deepEqual(normalizeSettingValue("officials.grantPolicy",{mode:"monthly-cap",monthlyCap:50}),{mode:"monthly-cap",monthlyCap:50});
  const item={id:"pro",kind:"subscription",label:"Pro",price:{currency:"USD",amountMinor:1500},interval:"month",quantity:20};
  assert.equal(normalizeSettingValue("billing.catalog",[item])[0].quantity,20);
  for(const bad of [{...item,interval:undefined},{...item,unlimited:true},{...item,price:{currency:"usd",amountMinor:1500}},{...item,price:{currency:"USD",amountMinor:15.5}},
    {...item,price:{currency:"USD",amountMinor:0}},{id:"one",kind:"single-document",label:"One",price:{currency:"USD",amountMinor:900},quantity:2},
    {id:"pack",kind:"credit-pack",label:"Pack",price:{currency:"USD",amountMinor:900}}])
    assert.throws(()=>normalizeSettingValue("billing.catalog",[JSON.parse(JSON.stringify(bad))]),{code:"INVALID_SETTING_VALUE"});
  assert.throws(()=>normalizeSettingValue("billing.catalog",[item,{...item,label:"Again"}]),/unique/);
  assert.throws(()=>normalizeSettingValue("roles.capabilities",{...settingDefinition("roles.capabilities").default,viewer:["discuss"]}),/read access/);
});

test("change validation reports every invariant, scope and active-vote violation",()=>{
  for(const rule of HARD_INVARIANTS){
    const result=validateSettingsChange({scope:"platform",changes:{[rule.key]:rule.value}});
    assert.deepEqual(result.errors.map(e=>e.code),[rule.code]);
  }
  const document=validateSettingsChange({scope:"document",changes:{"anchoring.enabled":false,"votes.challengeHours":1,"billing.catalog":[]},context:{visibility:"public",activeVote:true}});
  assert.deepEqual(document.errors.map(e=>e.code),["INVARIANT_PUBLIC_ANCHORING_REQUIRED","SETTING_SCOPE_NOT_ALLOWED","SETTING_LOCKED_ACTIVE_VOTE"]);
  assert.equal(validateSettingsChange({scope:"document",changes:{"anchoring.enabled":true},context:{visibility:"public"}}).valid,true);
  assert.equal(validateSettingsChange({scope:"tenant",changes:{"votes.challengeHours":1},context:{activeVote:true}}).valid,true);
  assert.throws(()=>validateSettingsChange({scope:"tenant",changes:{}}),{code:"INVALID_SETTINGS_CHANGE"});
  assert.throws(()=>validateSettingsChange({scope:"galaxy",changes:{a:1}}),{code:"INVALID_SETTINGS_SCOPE"});
  const next=applySettingsChanges({"points.rankingProfile":"net-votes","votes.challengeHours":2},{"points.rankingProfile":null,"votes.deliberationHours":3});
  assert.deepEqual(next,{"votes.challengeHours":2,"votes.deliberationHours":3});
  assert.deepEqual(settingsDelta({"a":1,"b":2},{"b":3,"c":4}),{a:null,b:3,c:4});
});

test("resolution names each source, ignores stale overrides and forces public anchoring",()=>{
  const layers={platform:{"votes.challengeHours":10,"billing.catalog":"not a list"},product:{"votes.challengeHours":20},tenant:{"votes.challengeHours":30,"quotas.weeklyFreeDocuments":9},document:{"anchoring.enabled":false}};
  const {values,ignored}=resolveEffectiveSettings(layers,{product:"charter",visibility:"public"});
  assert.deepEqual(values["votes.challengeHours"],{value:30,source:"tenant",locked:false});
  assert.deepEqual(values["billing.catalog"],{value:[],source:"default",locked:false});
  assert.deepEqual(values["quotas.weeklyFreeDocuments"],{value:1,source:"default",locked:false});
  assert.deepEqual(values["anchoring.enabled"],{value:true,source:"invariant",locked:true});
  assert.deepEqual(ignored,[{scope:"platform",key:"billing.catalog"},{scope:"tenant",key:"quotas.weeklyFreeDocuments"}]);
  assert.equal(resolveEffectiveSettings(layers,{product:"charter",visibility:"organization"}).values["anchoring.enabled"].source,"document");
  const before=resolveEffectiveSettings({}).values,after=resolveEffectiveSettings({product:{"votes.challengeHours":5}},{product:"civic"}).values;
  assert.deepEqual(diffEffectiveSettings(before,after).map(d=>[d.key,d.after.source]),[["votes.challengeHours","product:civic"]]);
});

test("calendar periods use local midnight in the configured zone, including DST transitions",()=>{
  assert.deepEqual(iso(periodWindow(Date.UTC(2026,2,4,12),"week","America/New_York")),["2026-03-02T05:00:00.000Z","2026-03-09T04:00:00.000Z"]);
  assert.deepEqual(iso(periodWindow(Date.UTC(2026,2,9,4),"week","America/New_York")),["2026-03-09T04:00:00.000Z","2026-03-16T04:00:00.000Z"]);
  assert.deepEqual(iso(periodWindow(Date.UTC(2026,10,1,12),"week","America/New_York")),["2026-10-26T04:00:00.000Z","2026-11-02T05:00:00.000Z"]);
  assert.deepEqual(iso(periodWindow(Date.UTC(2026,9,26,0,30),"week","Europe/Berlin")),["2026-10-25T23:00:00.000Z","2026-11-01T23:00:00.000Z"]);
  assert.deepEqual(iso(periodWindow(Date.UTC(2026,11,31,12),"month","Pacific/Auckland")),["2026-12-31T11:00:00.000Z","2027-01-31T11:00:00.000Z"]);
  assert.deepEqual(iso(periodWindow(Date.UTC(2026,5,15),"year","UTC")),["2026-01-01T00:00:00.000Z","2027-01-01T00:00:00.000Z"]);
  assert.deepEqual(iso(periodWindow(Date.UTC(2026,2,8,23,59,59),"week","UTC")),["2026-03-02T00:00:00.000Z","2026-03-09T00:00:00.000Z"]);
  assert.throws(()=>periodWindow(0,"week","Not/AZone"),{code:"INVALID_PERIOD"});
  assert.equal(validTimeZone("UTC"),true);assert.equal(validTimeZone("../etc"),false);
});
