import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,readFile,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import puppeteer from 'puppeteer-core';
import {createLegalDocument} from '../src/legal-structure.mjs';
import {accountFixture} from './support/account-fixture.mjs';
import {openSelectedSavedDocument} from './support/editor-browser.mjs';
const binary=process.env.DGE_BROWSER_EXECUTABLE;if(!binary)throw Error('DGE_BROWSER_EXECUTABLE is required');
async function click(page,text){await page.bringToFront();await page.waitForFunction(text=>[...document.querySelectorAll('button')].some(button=>button.textContent===text&&!button.disabled),{polling:100},text);const handle=await page.evaluateHandle(text=>[...document.querySelectorAll('button')].find(button=>button.textContent===text),text);await handle.asElement().click();await handle.dispose();}
async function write(page,path,body,method='POST'){return page.evaluate(async({path,body,method})=>{const csrf=document.cookie.split('; ').find(value=>value.startsWith('__Host-dge_csrf=')).split('=')[1];const response=await fetch(path,{method,headers:{'content-type':'application/json','x-dge-csrf':csrf},body:JSON.stringify(body)});if(!response.ok)throw Error('Revision fixture write rejected');return response.json();},{path,body,method});}
async function comparisonReady(page){await page.waitForSelector('.revision-comparison-result');await page.waitForFunction(()=>!document.querySelector('.revision-comparison [role="alert"]'));}

test('saved revision comparison checks exact versions, exports a bound report and never writes or replaces the editor',{timeout:90000},async()=>{
 const fixture=await accountFixture();let browser;const downloads=await mkdtemp(join(tmpdir(),'quill-comparison-download-'));
 try{
  browser=await puppeteer.launch({executablePath:binary,headless:true,acceptInsecureCerts:true,args:['--no-sandbox','--disable-dev-shm-usage']});const page=await browser.newPage();page.setDefaultTimeout(15000);
  await page.goto(fixture.origin+'/account');await page.locator('a[href="/auth/start"]').click();await page.waitForSelector('input[name="subject"]');await page.type('input[name="subject"]','revisionauthor');await click(page,'Continue fixture login');await page.waitForSelector('.account-id');await click(page,'Create workspace');await page.waitForFunction(()=>document.querySelector('select[aria-label="Your workspace"]')?.value);
  const tenantId=await page.$eval('select[aria-label="Your workspace"]',node=>node.value),id=randomUUID();
  const before=structuredClone(createLegalDocument({id,tenantId,title:'Revision comparison acceptance'}));
  before.content=[{kind:'section',id:'reports',title:'Reports',children:[{kind:'paragraph',id:'wording',inlines:[{kind:'text',text:'Report annually 😀.'}]}]}];
  const path='/api/workspaces/'+tenantId+'/documents/'+id;
  const initial=await write(page,'/api/workspaces/'+tenantId+'/documents',{document:before,commandId:randomUUID(),disclosure:'publish-all-revisions-v1'});
  const after=structuredClone(before);after.revision++;after.content[0].children[0].inlines=[{kind:'text',text:'Report quarterly 😁.',marks:['bold']}];
  const second=await write(page,path,{document:after,commandId:randomUUID(),expectedVersion:1},'PUT');
  await click(page,'Documents');await page.waitForSelector('.document-list button');await openSelectedSavedDocument(page);await page.waitForFunction(()=>document.querySelector('.save-controls')?.textContent.includes('Saved version 2'));
  const editor=await page.$('.ProseMirror'),beforeEditor=await page.$eval('.ProseMirror',node=>node.innerHTML);let writes=0;
  page.on('request',request=>{if(['POST','PUT','PATCH','DELETE'].includes(request.method())&&new URL(request.url()).pathname.startsWith('/api/'))writes++;});
  await click(page,'Load version history');await page.waitForFunction(()=>document.querySelectorAll('.version-history ol li').length===2);await click(page,'Compare saved versions');await comparisonReady(page);
  assert.match(await page.$eval('.revision-text-change del',node=>node.textContent),/annually 😀/);assert.match(await page.$eval('.revision-text-change ins',node=>node.textContent),/quarterly 😁/);
  await page.locator('.revision-comparison-checksums summary').click();
  assert.match(await page.$eval('.revision-comparison-binding',node=>node.textContent),new RegExp(initial.digest));assert.match(await page.$eval('.revision-comparison-binding',node=>node.textContent),new RegExp(second.digest));
  assert.match(await page.$eval('.revision-node-changes details summary',node=>node.textContent),/inlines/);
  assert.equal(await page.$eval('.ProseMirror',node=>node.innerHTML),beforeEditor);assert.equal(await editor.evaluate(node=>node.isConnected),true);assert.equal(writes,0);
  const cdp=await page.createCDPSession();await cdp.send('Page.setDownloadBehavior',{behavior:'allow',downloadPath:downloads});await click(page,'Download comparison JSON');
  let report;for(let attempt=0;attempt<100;attempt++){try{report=JSON.parse(await readFile(join(downloads,'Quill-comparison-v1-v2.json'),'utf8'));break;}catch{await new Promise(resolve=>setTimeout(resolve,50));}}
  assert.equal(report?.profile,'quill-stable-id-comparison-v1');assert.equal(report.before.digest,initial.digest);assert.equal(report.after.digest,second.digest);assert.equal(report.comparison.changes[0].id,'wording');assert.equal(report.legallyExecuted,false);
  await page.select('[aria-label="From saved version"]','2');await page.waitForFunction(()=>document.querySelector('.revision-comparison-result [role="status"]')?.textContent.includes('No semantic'));
  // Hold a genuine older response while the reader selects a different pair.
  // Releasing it must not resurrect the prior comparison.
  await cdp.send('Fetch.enable',{patterns:[{urlPattern:fixture.origin+'/api/public/documents/'+id+'?version=1',requestStage:'Response'}]});
  const held=new Promise(resolve=>cdp.once('Fetch.requestPaused',resolve));
  await page.select('[aria-label="From saved version"]','1');await held;
  await page.select('[aria-label="From saved version"]','2');
  await page.waitForFunction(()=>document.querySelector('.revision-comparison-result [role="status"]')?.textContent.includes('No semantic'));
  await cdp.send('Fetch.disable');await page.waitForNetworkIdle({idleTime:100,timeout:15000});
  assert.match(await page.$eval('.revision-comparison-result [role="status"]',node=>node.textContent),/No semantic/);
  // A hostile altered checksum from the real endpoint must fail before display
  // or report download. The actual saved edition remains unchanged.
  await cdp.send('Fetch.enable',{patterns:[{urlPattern:fixture.origin+'/api/public/documents/'+id+'?version=1',requestStage:'Response'}]});
  const corrupted=new Promise((resolve,reject)=>cdp.once('Fetch.requestPaused',async event=>{
    try{const response=await cdp.send('Fetch.getResponseBody',{requestId:event.requestId});const value=JSON.parse(response.base64Encoded?Buffer.from(response.body,'base64').toString('utf8'):response.body);value.digest='0'.repeat(64);
      await cdp.send('Fetch.fulfillRequest',{requestId:event.requestId,responseCode:200,responseHeaders:[{name:'Content-Type',value:'application/json'}],body:Buffer.from(JSON.stringify(value)).toString('base64')});resolve();
    }catch(error){reject(error);}
  }));
  await page.select('[aria-label="From saved version"]','1');await corrupted;
  await page.waitForSelector('.revision-comparison [role="alert"]');assert.equal(await page.$('.revision-comparison-result'),null);
  await cdp.send('Fetch.disable');await page.select('[aria-label="From saved version"]','2');await comparisonReady(page);
  await page.select('[aria-label="From saved version"]','1');await page.waitForSelector('.revision-text-change del');
  await page.setViewport({width:320,height:900});assert.equal(await page.$eval('.revision-comparison',node=>node.scrollWidth<=node.clientWidth),true);
  await mkdir('artifacts',{recursive:true});await page.screenshot({path:'artifacts/revision-comparison-mobile.png'});
  await page.keyboard.press('Escape');await page.waitForSelector('.revision-comparison',{hidden:true});assert.equal(await page.evaluate(()=>document.activeElement?.textContent),'Compare saved versions');
  assert.equal(await editor.evaluate(node=>node.isConnected),true);assert.equal(writes,0);
  await editor.dispose();await cdp.detach();
  // A fixed public-input source is also comparable by a cookie-free reader.
  const frozen=await write(page,path+'/freeze-input',{commandId:randomUUID(),expectedVersion:2});assert.equal(frozen.version,3);
  const context=await browser.createBrowserContext(),guest=await context.newPage();guest.setDefaultTimeout(15000);await guest.goto(fixture.origin+'/?document='+id+'&version=3');await guest.waitForSelector('.ProseMirror[contenteditable="false"]');
  await click(guest,'Load version history');await guest.waitForFunction(()=>document.querySelectorAll('.version-history ol li').length===3);await click(guest,'Compare saved versions');await comparisonReady(guest);
  assert.deepEqual(await guest.$$eval('.revision-metadata-change summary',nodes=>nodes.map(node=>node.textContent)),['Document mode changed','Document lifecycle changed']);
  assert.equal(await guest.$eval('.ProseMirror',node=>node.getAttribute('contenteditable')),'false');
  assert.equal((await guest.evaluate(async id=>(await(await fetch('/api/public/documents/'+id)).json()).version,id)),3);
  await context.close();
 }finally{await browser?.close();await fixture.close();await rm(downloads,{recursive:true,force:true});}
});
