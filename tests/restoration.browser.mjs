import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import puppeteer from 'puppeteer-core';
import {createLegalDocument} from '../src/legal-structure.mjs';
import {accountFixture} from './support/account-fixture.mjs';
import {openSelectedSavedDocument,withEditorReplacement} from './support/editor-browser.mjs';
const binary=process.env.DGE_BROWSER_EXECUTABLE;if(!binary)throw Error('DGE_BROWSER_EXECUTABLE is required');
async function click(page,text){await page.bringToFront();await page.waitForFunction(text=>[...document.querySelectorAll('button')].some(button=>button.textContent===text&&!button.disabled),{polling:100},text);const handle=await page.evaluateHandle(text=>[...document.querySelectorAll('button')].find(button=>button.textContent===text),text);await handle.asElement().click();await handle.dispose();}
async function write(page,path,body,method='POST'){return page.evaluate(async({path,body,method})=>{const csrf=document.cookie.split('; ').find(value=>value.startsWith('__Host-dge_csrf=')).split('=')[1];const response=await fetch(path,{method,headers:{'content-type':'application/json','x-dge-csrf':csrf},body:JSON.stringify(body)});if(!response.ok)throw Error('Restoration fixture write rejected');return response.json();},{path,body,method});}
async function publicVersion(page,id,version){return page.evaluate(async({id,version})=>(await(await fetch('/api/public/documents/'+id+(version?'?version='+version:''))).json()),{id,version});}
async function saved(page,version){await page.waitForFunction(version=>document.querySelector('.save-controls')?.textContent.includes('Saved version '+version),{polling:100},version);}

test('restoration waits for an existing save, recovers a lost committed response and preserves frozen history',{timeout:90000},async()=>{
 const fixture=await accountFixture({publicCollaboration:true});let browser;
 try{
  browser=await puppeteer.launch({executablePath:binary,headless:true,acceptInsecureCerts:true,args:['--no-sandbox','--disable-dev-shm-usage']});const page=await browser.newPage();page.setDefaultTimeout(15000);
  await page.goto(fixture.origin+'/account');await page.locator('a[href="/auth/start"]').click();await page.waitForSelector('input[name="subject"]');await page.type('input[name="subject"]','restoreauthor');await click(page,'Continue fixture login');await page.waitForSelector('.account-id');await click(page,'Create workspace');await page.waitForFunction(()=>document.querySelector('select[aria-label="Your workspace"]')?.value);
  const tenantId=await page.$eval('select[aria-label="Your workspace"]',node=>node.value),id=randomUUID(),path='/api/workspaces/'+tenantId+'/documents/'+id;
  const ownerAccount=await page.evaluate(async()=>(await(await fetch('/api/session')).json()).accountId);
  const otherContext=await browser.createBrowserContext(),other=await otherContext.newPage();other.setDefaultTimeout(15000);await other.bringToFront();
  await other.goto(fixture.origin+'/account');await other.locator('a[href="/auth/start"]').click();await other.waitForSelector('input[name="subject"]');await other.type('input[name="subject"]','restorecoowner');await click(other,'Continue fixture login');await other.waitForSelector('.account-id');
  const otherAccount=await other.evaluate(async()=>(await(await fetch('/api/session')).json()).accountId);
  const invitation=await write(page,'/api/workspaces/'+tenantId+'/invitations',{accountId:otherAccount,role:'admin'});
  await write(other,'/api/workspaces/'+tenantId+'/join',{invitationToken:invitation.invitationToken});
  await write(page,'/api/workspaces/'+tenantId+'/members/'+otherAccount,{role:'owner'},'PATCH');
  const original=structuredClone(createLegalDocument({id,tenantId,title:'Original restoration title'}));original.content=[{kind:'paragraph',id:'body',inlines:[{kind:'text',text:'Original public wording 😀.'}]}];
  const initial=await write(page,'/api/workspaces/'+tenantId+'/documents',{document:original,commandId:randomUUID(),disclosure:'publish-all-revisions-v1'});
  const updated=structuredClone(original);updated.revision++;updated.metadata.title='Changed restoration title';updated.content[0].inlines[0].text='Current public wording.';
  await write(page,path,{document:updated,commandId:randomUUID(),expectedVersion:1},'PUT');
  await click(page,'Documents');await page.waitForSelector('.document-list button');await openSelectedSavedDocument(page);await saved(page,2);await click(page,'Load version history');await page.waitForSelector('.restore-version');
  const cdp=await page.createCDPSession(),restoreRequests=[];let heldSave,releaseSave,failedCurrentRead=false;
  const saveHeld=new Promise(resolve=>releaseSave=resolve);
  await cdp.send('Fetch.enable',{patterns:[{urlPattern:fixture.origin+path,requestStage:'Response'},{urlPattern:fixture.origin+path+'/restore',requestStage:'Response'}]});
  cdp.on('Fetch.requestPaused',async event=>{
    if(event.request.method==='PUT'&&!heldSave){heldSave=event;releaseSave();return;}
    if(event.request.method==='POST'&&event.request.url.endsWith('/restore')){
      restoreRequests.push(JSON.parse(event.request.postData));
      if(restoreRequests.length===1){await cdp.send('Fetch.failRequest',{requestId:event.requestId,errorReason:'ConnectionClosed'});return;}
    }
    if(event.request.method==='GET'&&restoreRequests.length===3&&!failedCurrentRead){failedCurrentRead=true;await cdp.send('Fetch.failRequest',{requestId:event.requestId,errorReason:'ConnectionClosed'});return;}
    await cdp.send('Fetch.continueRequest',{requestId:event.requestId});
  });
  await page.locator('.ProseMirror [data-block-id="body"]').click();await page.keyboard.press('Home');await page.keyboard.type('Pending edit. ');await saveHeld;
  let confirmations=0;page.once('dialog',async dialog=>{confirmations++;assert.match(dialog.message(),/new public draft revision/);await dialog.accept();});
  const oldEditor=await page.$('.ProseMirror');await click(page,'Restore version 1 as new draft');await page.waitForSelector('.ProseMirror[contenteditable="false"]');
  assert.equal(restoreRequests.length,0,'Restoration must wait for the existing save acknowledgment');
  await click(page,'Restart sample');assert.equal(await oldEditor.evaluate(node=>node.isConnected),true);assert.match(await page.$eval('.status',node=>node.textContent),/Wait for the restoration/);
  await cdp.send('Fetch.continueRequest',{requestId:heldSave.requestId});
  await page.waitForFunction(()=>document.querySelector('.status')?.textContent.includes('restoration response was lost'));
  assert.equal((await publicVersion(page,id)).version,4);assert.match((await publicVersion(page,id,3)).document.content[0].inlines[0].text,/Pending edit/);
  assert.equal(await page.$eval('.ProseMirror',node=>node.getAttribute('contenteditable')),'false');
  // A definite denial of a retry does not prove the original uncertain write
  // failed. Keep the copy locked until the current head can be recovered.
  await write(other,'/api/workspaces/'+tenantId+'/members/'+ownerAccount,{role:'viewer'},'PATCH');
  const denied=page.waitForResponse(response=>response.url().endsWith('/restore')&&response.status()===403);
  await click(page,'Retry restoration of version 1');await denied;
  await page.waitForFunction(()=>[...document.querySelectorAll('.restore-version')].some(button=>button.textContent==='Retry restoration of version 1'&&!button.disabled));
  assert.equal(await page.$eval('.ProseMirror',node=>node.getAttribute('contenteditable')),'false');
  await write(other,'/api/workspaces/'+tenantId+'/members/'+ownerAccount,{role:'owner'},'PATCH');
  const restoredRecord=await publicVersion(page,id,4);
  assert.equal(restoredRecord.document.metadata.title,'Original restoration title');
  const later=structuredClone(restoredRecord.document);later.revision++;later.metadata.title='Later current title';later.content[0].inlines[0].text+=' Later edit.';
  await write(other,path,{document:later,expectedVersion:4,commandId:randomUUID()},'PUT');
  await click(page,'Retry restoration of version 1');
  await page.waitForFunction(()=>document.querySelector('.status')?.textContent.includes('Restoration was recorded, but the current version could not be reopened'));
  assert.equal(await page.$eval('.ProseMirror',node=>node.getAttribute('contenteditable')),'false');
  await withEditorReplacement(page,()=>click(page,'Retry restoration of version 1'));await saved(page,5);
  assert.equal(failedCurrentRead,true);
  assert.equal(confirmations,1);assert.equal(restoreRequests.length,3);for(const request of restoreRequests)assert.deepEqual(request,restoreRequests[0]);assert.equal(restoreRequests[0].expectedVersion,3);
  assert.equal(await page.$eval('.ProseMirror [data-block-id="body"]',node=>node.textContent),'Original public wording 😀. Later edit.');
  assert.equal(await page.$eval('.document-heading h1',node=>node.textContent),'Later current title');
  assert.match(await page.$eval('.status',node=>node.textContent),/advanced to version 5/);
  assert.equal((await publicVersion(page,id,1)).digest,initial.digest);
  assert.equal((await publicVersion(page,id,2)).document.content[0].inlines[0].text,'Current public wording.');
  await click(page,'Load version history');await page.waitForSelector('.history-restoration');assert.match(await page.$eval('.history-restoration',node=>node.textContent),/version 1/);
  assert.equal(await page.$$eval('.version-history>ol>li',nodes=>nodes.length),5);
  await page.setViewport({width:320,height:900});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.setViewport({width:1360,height:1000});
  await cdp.send('Fetch.disable');await cdp.detach();await oldEditor.dispose();
  // A fresh real WebSocket room starts from the restored content, not old Yjs state.
  await click(page,'Join live editing');await page.waitForFunction(()=>document.querySelector('.save-controls')?.textContent.includes('Public collaboration connected'));
  assert.equal(await page.$eval('.ProseMirror [data-block-id="body"]',node=>node.textContent),'Original public wording 😀. Later edit.');
  await page.locator('.ProseMirror [data-block-id="body"]').click();await page.keyboard.press('End');await page.keyboard.type(' Live after restore.');
  await page.waitForFunction(async id=>{const response=await fetch('/api/public/documents/'+id);const snapshot=await response.json();return snapshot.version>=6&&snapshot.document.content[0].inlines.map(run=>run.text??'').join('').includes('Live after restore.');},{polling:100},id);
  page.once('dialog',dialog=>dialog.accept());await withEditorReplacement(page,()=>click(page,'Exit live editing'));
  const current=await publicVersion(page,id);await write(page,path+'/freeze-input',{commandId:randomUUID(),expectedVersion:current.version});
  await click(page,'Documents');await page.waitForSelector('.document-list button');await openSelectedSavedDocument(page);await page.waitForSelector('.ProseMirror[contenteditable="false"]');
  await click(page,'Load version history');await page.waitForSelector('.history-restoration');assert.equal(await page.$('.restore-version'),null,'Fixed source has no restoration action');
 }finally{await browser?.close();await fixture.close();}
});
