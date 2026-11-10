import test from 'node:test';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import {mlsFixture} from './support/mls-fixture.mjs';
const binary=process.env.DGE_BROWSER_EXECUTABLE;
if(!binary)throw Error('DGE_BROWSER_EXECUTABLE is required');
test('three isolated browser endpoints authenticate MLS messages and exclude a removed device',{timeout:90000},async()=>{
 const fixture=await mlsFixture();let browser;
 try{
  browser=await puppeteer.launch({executablePath:binary,headless:true,acceptInsecureCerts:true,args:['--no-sandbox','--disable-dev-shm-usage']});
  const peers=[];
  for(const name of ['alice-device','bob-device','carol-device']){
   const context=await browser.createBrowserContext(),page=await context.newPage();
   await page.goto(fixture.origin);
   const publicData=await page.evaluate(async name=>{
    const {default:init,BrowserEndpoint}=await import('/quill_mls.js');await init();
    window.endpoint=new BrowserEndpoint(new TextEncoder().encode(name));
    return {identity:Array.from(new TextEncoder().encode(name)),signature_key:Array.from(endpoint.signatureKey()),package:Array.from(endpoint.keyPackage())};
   },name);
   peers.push({page,...publicData});
  }
  const [alice,bob,carol]=peers;
  let pins=[alice,bob].map(({identity,signature_key})=>({identity,signature_key}));
  const addition=await alice.page.evaluate(bob=>{
   window.group=endpoint.createGroup(new TextEncoder().encode('workspace:document'));
   const added=endpoint.add(group,new Uint8Array(bob.package),new Uint8Array(bob.identity),new Uint8Array(bob.signature_key));
   const result={commit:Array.from(added.commit),welcome:Array.from(added.welcome)};added.free();endpoint.mergePending(group);return result;
  },{package:bob.package,identity:bob.identity,signature_key:bob.signature_key});
  await bob.page.evaluate(({welcome,pins})=>{window.group=endpoint.join(new Uint8Array(welcome),new TextEncoder().encode('workspace:document'),JSON.stringify(pins));},{welcome:addition.welcome,pins});
  const encrypted=await alice.page.evaluate(()=>Array.from(endpoint.encrypt(group,new TextEncoder().encode('Confidential MLS canary'))));
  assert.equal(await bob.page.evaluate(({encrypted,pins})=>{
   const altered=new Uint8Array(encrypted);altered[altered.length-1]^=1;
   try{endpoint.receive(group,altered,JSON.stringify(pins));return false;}catch{}
   const valid=endpoint.receive(group,new Uint8Array(encrypted),JSON.stringify(pins));
   const correct=valid.application && new TextDecoder().decode(valid.bytes)==='Confidential MLS canary';valid.free();
   try{endpoint.receive(group,new Uint8Array(encrypted),JSON.stringify(pins));return false;}catch{}
   return correct;
  },{encrypted,pins}),true);
  const addition2=await alice.page.evaluate(carol=>{
   const added=endpoint.add(group,new Uint8Array(carol.package),new Uint8Array(carol.identity),new Uint8Array(carol.signature_key));
   const result={commit:Array.from(added.commit),welcome:Array.from(added.welcome)};added.free();endpoint.mergePending(group);return result;
  },{package:carol.package,identity:carol.identity,signature_key:carol.signature_key});
  const oldPins=pins;pins=[...pins,{identity:carol.identity,signature_key:carol.signature_key}];
  assert.equal(await bob.page.evaluate(({commit,oldPins,pins})=>{
   try{endpoint.receive(group,new Uint8Array(commit),JSON.stringify(oldPins));return false;}catch{}
   const result=endpoint.receive(group,new Uint8Array(commit),JSON.stringify(pins));const okay=!result.application;result.free();return okay;
  },{commit:addition2.commit,oldPins,pins}),true);
  await carol.page.evaluate(({welcome,pins})=>{window.group=endpoint.join(new Uint8Array(welcome),new TextEncoder().encode('workspace:document'),JSON.stringify(pins));},{welcome:addition2.welcome,pins});
  const removal=await alice.page.evaluate(identity=>{const message=Array.from(endpoint.remove(group,new Uint8Array(identity)));endpoint.mergePending(group);return message;},bob.identity);
  pins=pins.filter(pin=>String(pin.identity)!==String(bob.identity));
  for(const peer of [bob,carol])await peer.page.evaluate(({removal,pins})=>{endpoint.receive(group,new Uint8Array(removal),JSON.stringify(pins)).free();},{removal,pins});
  assert.equal(await bob.page.evaluate(()=>endpoint.active(group)),false);
  const future=await alice.page.evaluate(()=>Array.from(endpoint.encrypt(group,new TextEncoder().encode('Future epoch canary'))));
  assert.equal(await carol.page.evaluate(({future,pins})=>{const received=endpoint.receive(group,new Uint8Array(future),JSON.stringify(pins));const matches=new TextDecoder().decode(received.bytes)==='Future epoch canary';received.free();return matches;},{future,pins}),true);
  assert.equal(await bob.page.evaluate(({future,pins})=>{try{endpoint.receive(group,new Uint8Array(future),JSON.stringify(pins));return false;}catch{return true;}},{future,pins}),true);
  for(const peer of peers)assert.equal(await peer.page.evaluate(()=>{endpoint.close(group);try{endpoint.encrypt(group,new Uint8Array([1]));return false;}catch{endpoint.free();return true;}}),true);
 }finally{await browser?.close();await fixture.close();}
});
