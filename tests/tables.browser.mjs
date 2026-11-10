import test from 'node:test';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import {accountFixture} from './support/account-fixture.mjs';
const binary=process.env.DGE_BROWSER_EXECUTABLE;
if(!binary)throw Error('DGE_BROWSER_EXECUTABLE is required');
async function click(page,text){
 await page.bringToFront();
 await page.waitForFunction(text=>[...document.querySelectorAll('button')].some(button=>button.textContent===text&&!button.disabled),{polling:100},text);
 const handle=await page.evaluateHandle(text=>[...document.querySelectorAll('button')].find(button=>button.textContent===text),text);
 await handle.asElement().click();await handle.dispose();
}
async function login(context,origin,subject){
 const page=await context.newPage();page.setDefaultTimeout(15000);await page.goto(origin+'/account');
 await page.click('a[href="/auth/start"]');await page.waitForSelector('input[name="subject"]');await page.type('input[name="subject"]',subject);await click(page,'Continue fixture login');await page.waitForSelector('.account-id');return page;
}
async function saved(page){await page.waitForFunction(()=>document.querySelector('.save-controls')?.textContent.includes('Saved version '),{polling:100});}
async function openCurrent(page){await click(page,'Documents');await page.waitForSelector('.document-list button');await page.click('.document-list button');await page.waitForSelector('.save-controls');}
async function csrfRequest(page,path,method,body){return page.evaluate(async({path,method,body})=>{
 const csrf=document.cookie.split('; ').find(value=>value.startsWith('__Host-dge_csrf=')).split('=')[1];
 const response=await fetch(path,{method,headers:{'content-type':'application/json','x-dge-csrf':csrf},body:JSON.stringify(body)});
 if(!response.ok)throw Error('Fixture account request rejected');return response.json();
},{path,method,body});}

test('table layout, keyboard, saved reload, narrow layout and immutable source work through the real editor',{timeout:90000},async()=>{
 const fixture=await accountFixture();let browser,debugPage;
 try{
  browser=await puppeteer.launch({executablePath:binary,headless:true,acceptInsecureCerts:true,args:['--no-sandbox','--disable-dev-shm-usage']});
  const context=await browser.createBrowserContext(),page=await login(context,fixture.origin,'tableauthor');debugPage=page;
  await click(page,'Create workspace');await page.waitForFunction(()=>document.querySelector('select[aria-label="Your workspace"]')?.value,{polling:100});await click(page,'Documents');await page.waitForSelector('.public-create');await page.click('.public-create input[type="checkbox"]');await click(page,'Publish current text');await saved(page);
  await click(page,'Table');await page.waitForSelector('[aria-label="Table layout"]');await page.keyboard.type('Stable cell');
  const cellId=await page.$eval('.ProseMirror td',node=>node.dataset.blockId);
  await click(page,'Insert row below');await click(page,'Insert column right');
  assert.equal(await page.$$eval('.ProseMirror tr',rows=>rows.length),3);assert.equal(await page.$$eval('.ProseMirror tr:first-child td',cells=>cells.length),3);
  assert.equal(await page.$eval('[data-block-id="'+cellId+'"]',node=>node.textContent),'Stable cell');
  await click(page,'Undo');assert.equal(await page.$$eval('.ProseMirror tr:first-child td',cells=>cells.length),2);
  await click(page,'Redo');assert.equal(await page.$$eval('.ProseMirror tr:first-child td',cells=>cells.length),3);
  await page.click('.ProseMirror tr:last-child td:last-child p');
  await page.waitForFunction(()=>document.querySelector('[aria-label="Table layout"]')?.textContent.includes('Row 3, column 3.'),{polling:100});
  await page.keyboard.press('Tab');
  await page.waitForFunction(()=>document.querySelectorAll('.ProseMirror tr').length===4,{polling:100});
  await page.keyboard.type('Keyboard row');await saved(page);
  await openCurrent(page);await page.waitForFunction(()=>document.querySelectorAll('.ProseMirror tr').length===4,{polling:100});
  assert.equal(await page.$eval('[data-block-id="'+cellId+'"]',node=>node.textContent),'Stable cell');
  assert.match(await page.$eval('.ProseMirror tr:last-child',node=>node.textContent),/Keyboard row/);
  await page.setViewport({width:320,height:900});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.setViewport({width:1360,height:1000});await page.click('.side-panel section input[type="checkbox"]');await click(page,'Freeze source for public input');
  await page.waitForFunction(()=>document.querySelector('.ProseMirror')?.getAttribute('contenteditable')==='false',{polling:100});
  await page.click('.ProseMirror td p');
  assert.equal(await page.$$eval('[aria-label="Table layout"] button',buttons=>buttons.every(button=>button.disabled)),true);
  const before=await page.$eval('.ProseMirror table',node=>node.textContent);await page.keyboard.type('FORGED TABLE EDIT');assert.equal(await page.$eval('.ProseMirror table',node=>node.textContent),before);
 }catch(error){if(debugPage)console.log('Table fixture diagnostic:',await debugPage.evaluate(()=>({status:document.querySelector('.status')?.textContent,save:document.querySelector('.save-controls')?.textContent,table:document.querySelector('[aria-label="Table layout"]')?.textContent,rows:document.querySelectorAll('.ProseMirror tr').length,focus:document.activeElement?.tagName})));throw error;}finally{await browser?.close();await fixture.close();}
});

test('real WSS table row insertion preserves another authenticated editor text under delayed delivery',{timeout:90000},async()=>{
 const fixture=await accountFixture({publicCollaboration:true});let browser,debugPage,debugPeer;const network=[];
 try{
  browser=await puppeteer.launch({executablePath:binary,headless:true,acceptInsecureCerts:true,args:['--no-sandbox','--disable-dev-shm-usage']});
  const ownerContext=await browser.createBrowserContext(),peerContext=await browser.createBrowserContext();
  const owner=await ownerContext.newPage();debugPage=owner;const protocol=await owner.createCDPSession();await protocol.send('Network.enable');protocol.on('Network.webSocketCreated',()=>network.push('created'));protocol.on('Network.webSocketHandshakeResponseReceived',event=>network.push('status:'+event.response.status));protocol.on('Network.webSocketFrameError',event=>network.push(event.errorMessage.match(/net::[A-Z_]+/)?.[0]??'frame-error'));owner.on('console',message=>{if(message.type()==='error'&&message.text().includes('Content Security Policy'))network.push('csp-rejected');});owner.on('pageerror',error=>network.push('page-error:'+error.name));owner.setDefaultTimeout(15000);
  await owner.evaluateOnNewDocument(()=>{
   const Native=window.WebSocket;
   window.delayTableUpdates=false;window.delayedTableUpdates=[];window.releaseTableUpdates=()=>{window.delayTableUpdates=false;for(const deliver of window.delayedTableUpdates.splice(0))deliver();};
   window.WebSocket=class extends Native{
    constructor(...args){super(...args);this.listeners=new WeakMap();}
    addEventListener(name,listener,options){if(name!=='message')return super.addEventListener(name,listener,options);const wrapped=event=>{if(window.delayTableUpdates&&event.data instanceof ArrayBuffer&&new Uint8Array(event.data)[0]===2){window.delayedTableUpdates.push(()=>listener.call(this,event));return;}listener.call(this,event);};this.listeners.set(listener,wrapped);return super.addEventListener(name,wrapped,options);}
    removeEventListener(name,listener,options){return super.removeEventListener(name,name==='message'?(this.listeners.get(listener)??listener):listener,options);}
   };
  });
  await owner.goto(fixture.origin+'/account');await owner.click('a[href="/auth/start"]');await owner.waitForSelector('input[name="subject"]');await owner.type('input[name="subject"]','tableowner');await click(owner,'Continue fixture login');await owner.waitForSelector('.account-id');await click(owner,'Create workspace');
  await owner.waitForFunction(()=>document.querySelector('select[aria-label="Your workspace"]')?.value,{polling:100});
  const tenantId=await owner.$eval('select[aria-label="Your workspace"]',node=>node.value);
  const peer=await login(peerContext,fixture.origin,'tablepeer');debugPeer=peer;const accountId=await peer.$eval('.account-id',node=>node.textContent);
  const invitation=await csrfRequest(owner,`/api/workspaces/${tenantId}/invitations`,'POST',{accountId,role:'editor'});
  await csrfRequest(peer,`/api/workspaces/${tenantId}/join`,'POST',{invitationToken:invitation.invitationToken});
  await click(owner,'Documents');await owner.waitForSelector('.public-create');await owner.click('.public-create input[type="checkbox"]');await click(owner,'Publish current text');await saved(owner);await click(owner,'Table');await saved(owner);
  await openCurrent(peer);await peer.waitForSelector('.ProseMirror table');
  await click(owner,'Join live editing');await owner.waitForFunction(()=>['Public collaboration connected','Live edit acknowledged'].some(text=>document.querySelector('.save-controls')?.textContent.includes(text)),{polling:100});
  await click(peer,'Join live editing');await peer.waitForFunction(()=>['Public collaboration connected','Live edit acknowledged'].some(text=>document.querySelector('.save-controls')?.textContent.includes(text)),{polling:100});
  for(const page of [owner,peer])assert.equal(await page.$eval('.ProseMirror',node=>node.getAttribute('contenteditable')),'true');
  await owner.evaluate(()=>{window.delayTableUpdates=true;});
  await peer.bringToFront();await peer.click('.ProseMirror tr:first-child td:last-child p');await peer.keyboard.type('Peer text must survive');
  await peer.waitForFunction(()=>document.querySelector('.save-controls')?.textContent.includes('acknowledged'),{polling:100});
  await owner.waitForFunction(()=>window.delayedTableUpdates.length>0,{polling:100});
  await owner.bringToFront();await owner.click('.ProseMirror td:first-child p');await click(owner,'Insert row below');
  await owner.waitForFunction(()=>document.querySelector('.save-controls')?.textContent.includes('acknowledged'),{polling:100});
  await owner.evaluate(()=>window.releaseTableUpdates());
  for(const page of [owner,peer])await page.waitForFunction(()=>document.querySelectorAll('.ProseMirror tr').length===3&&document.querySelector('.ProseMirror table')?.textContent.includes('Peer text must survive'),{polling:100});
  assert.equal(await owner.$$eval('.ProseMirror tr:first-child td',cells=>cells.length),2);
  assert.equal(await peer.$$eval('.ProseMirror tr:first-child td',cells=>cells.length),2);
  owner.once('dialog',dialog=>dialog.accept());
  await click(owner,'Exit live editing');await openCurrent(owner);
  await owner.waitForFunction(()=>document.querySelectorAll('.ProseMirror tr').length===3&&document.querySelector('.ProseMirror table')?.textContent.includes('Peer text must survive'),{polling:100});
 }catch(error){if(debugPage)console.log('Live table fixture diagnostic:',await debugPage.evaluate(()=>({status:document.querySelector('.status')?.textContent,save:document.querySelector('.save-controls')?.textContent,rows:document.querySelectorAll('.ProseMirror tr').length,delayed:window.delayedTableUpdates?.length})),fixture.collaborationStats(),network,debugPeer&&await debugPeer.evaluate(()=>({save:document.querySelector('.save-controls')?.textContent,editable:document.querySelector('.ProseMirror')?.getAttribute('contenteditable'),focus:document.activeElement?.tagName,selection:document.querySelector('[aria-label="Table layout"]')?.textContent,cellLength:document.querySelector('.ProseMirror tr:first-child td:last-child')?.textContent.length})));throw error;}finally{await browser?.close();await fixture.close();}
});
