import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import puppeteer from 'puppeteer-core';
import {createLegalDocument,legalPlainText} from '../src/legal-structure.mjs';
import {accountFixture} from './support/account-fixture.mjs';
import {openSelectedSavedDocument,withEditorReplacement} from './support/editor-browser.mjs';
const binary=process.env.DGE_BROWSER_EXECUTABLE;
if(!binary)throw Error('DGE_BROWSER_EXECUTABLE is required');
async function click(page,text){await page.bringToFront();await page.waitForFunction(text=>[...document.querySelectorAll('button')].some(button=>button.textContent===text&&!button.disabled),{polling:100},text);const handle=await page.evaluateHandle(text=>[...document.querySelectorAll('button')].find(button=>button.textContent===text),text);await handle.asElement().click();await handle.dispose();}
async function saved(page,version){await page.waitForFunction(version=>document.querySelector('.save-controls')?.textContent.includes('Saved version '+version),{polling:100},version);}
async function fill(page,selector,text){await page.locator(selector).click();await page.keyboard.down('Control');await page.keyboard.press('KeyA');await page.keyboard.up('Control');await page.keyboard.press('Backspace');if(text)await page.keyboard.type(text);}
async function post(page,path,body){return page.evaluate(async({path,body})=>{const csrf=document.cookie.split('; ').find(value=>value.startsWith('__Host-dge_csrf=')).split('=')[1];const result=await fetch(path,{method:'POST',headers:{'content-type':'application/json','x-dge-csrf':csrf},body:JSON.stringify(body)});if(!result.ok)throw Error('Reference fixture API rejected');return result.json();},{path,body});}
async function record(page,id){return page.evaluate(async id=>(await(await fetch('/api/public/documents/'+id)).json()),id);}
async function withEditor(run){
 const fixture=await accountFixture({publicCollaboration:true});let browser;
 try{
  browser=await puppeteer.launch({executablePath:binary,headless:true,acceptInsecureCerts:true,args:['--no-sandbox','--disable-dev-shm-usage']});const page=await browser.newPage();page.setDefaultTimeout(15000);
  await page.goto(fixture.origin+'/account');await page.locator('a[href="/auth/start"]').click();await page.waitForSelector('input[name="subject"]');await page.type('input[name="subject"]','referenceauthor');await click(page,'Continue fixture login');await page.waitForSelector('.account-id');await click(page,'Create workspace');await page.waitForFunction(()=>document.querySelector('select[aria-label="Your workspace"]')?.value,{polling:100});
  const tenantId=await page.$eval('select[aria-label="Your workspace"]',node=>node.value),id=randomUUID(),d=structuredClone(createLegalDocument({id,tenantId,title:'Reference acceptance'}));
  d.content=[{kind:'section',id:'reports',title:'Reports',children:[{kind:'paragraph',id:'body',inlines:[{kind:'text',text:'Report annually.'}]},{kind:'paragraph',id:'links',inlines:[{kind:'reference',targetId:'review'},{kind:'text',text:' '},{kind:'footnote-reference',targetId:'note'}]}]},{kind:'section',id:'review',title:'Review',children:[{kind:'paragraph',id:'review-body',inlines:[{kind:'text',text:'Review reports.'}]}]},{kind:'definition',id:'agency',term:'Agency',inlines:[{kind:'text',text:'The reporting authority.'}]},{kind:'footnote',id:'note',inlines:[{kind:'text',text:'Initial supporting source.'}]}];
  await post(page,`/api/workspaces/${tenantId}/documents`,{document:d,commandId:randomUUID(),disclosure:'publish-all-revisions-v1'});
  await click(page,'Documents');await page.waitForSelector('.document-list button');await openSelectedSavedDocument(page);await saved(page,1);
  await run({page,id,d,fixture});
 }finally{await browser?.close();await fixture.close();}
}
const target='select[aria-label="Reference target"]';
test('authenticated authors create, edit, unlink, define and footnote stable internal references with saved undo',{timeout:90000},async()=>withEditor(async({page,id})=>{
 let version=1;const save=async()=>saved(page,++version);
 assert.equal(await page.$eval('[data-reference="review"]',node=>node.textContent),'SEC. 2.');
 await page.locator('[data-reference="review"]').click();await click(page,'Reference');await click(page,'Go to target');
 assert.equal((await record(page,id)).version,version);
 await page.select(target,'agency');await click(page,'Insert reference');await save();
 assert.equal(await page.$eval('[data-reference="agency"]',node=>node.textContent),'Agency');
 await fill(page,'input[aria-label="Optional reference label"]','Reporting authority');await click(page,'Update reference');await save();
 assert.equal(await page.$eval('[data-reference="agency"]',node=>node.textContent),'Reporting authority');
 await click(page,'Remove reference');await save();assert.equal(await page.$('[data-reference="agency"]'),null);
 assert.match(await page.$eval('[data-block-id="review-body"]',node=>node.textContent),/Reporting authority/);
 await click(page,'Undo');await save();assert.equal(await page.$eval('[data-reference="agency"]',node=>node.textContent),'Reporting authority');
 await page.locator('[data-block-id="body"]').click();await page.keyboard.press('End');await click(page,'Footnote');
 await page.type('textarea[aria-label="Footnote text"]','A second public supporting source.');await click(page,'Insert footnote');await save();
 const noteId=await page.$$eval('.ProseMirror sup[data-footnote-reference]',nodes=>nodes.find(node=>node.textContent==='2').dataset.footnoteReference);
 assert.equal(await page.$eval('[data-block-id="'+noteId+'"]',node=>node.textContent),'A second public supporting source.');
 await click(page,'Undo');await save();assert.equal(await page.$('[data-block-id="'+noteId+'"]'),null);
 await click(page,'Redo');await save();assert.equal(await page.$eval('[data-block-id="'+noteId+'"]',node=>node.textContent),'A second public supporting source.');
 await click(page,'Definition');await page.type('input[aria-label="Defined term"]','Reviewer');await page.type('textarea[aria-label="New definition text"]','One who reviews the reports.');await click(page,'Add definition');await save();
 const definitionId=await page.$eval('[data-definition="Reviewer"]',node=>node.dataset.blockId);
 await fill(page,'input[aria-label="Defined term"]','Review officer');await click(page,'Rename selected term');await save();assert.equal(await page.$eval('[data-definition="Review officer"]',node=>node.dataset.blockId),definitionId);
 await page.locator('[data-block-id="body"]').click();await page.keyboard.press('End');await click(page,'Reference');await page.select(target,definitionId);await click(page,'Insert reference');await save();
 assert.equal(await page.$eval('[data-reference="'+definitionId+'"]',node=>node.textContent),'Review officer');
 await click(page,'Go to target');await click(page,'Definition');await fill(page,'input[aria-label="Defined term"]','Chief reviewer');await click(page,'Rename selected term');await save();
 assert.equal(await page.$eval('[data-reference="'+definitionId+'"]',node=>node.textContent),'Chief reviewer');
 const snapshot=await record(page,id);assert.match(legalPlainText(snapshot.document),/Chief reviewer/);
 let stable;function scan(nodes){for(const node of nodes){for(const run of node.inlines??[])if(run.kind==='reference'&&run.targetId===definitionId)stable=run;if(node.children)scan(node.children);}}scan(snapshot.document.content);assert.deepEqual(stable,{kind:'reference',targetId:definitionId});
 await click(page,'Documents');await page.waitForSelector('.document-list button');await openSelectedSavedDocument(page);await saved(page,version);assert.equal(await page.$eval('[data-reference="'+definitionId+'"]',node=>node.textContent),'Chief reviewer');
}));
test('derived references track renumbering and moves without view-only WSS writes, and frozen readers can navigate',{timeout:90000},async()=>withEditor(async({page,id})=>{
 await page.select('.numbering-tools select','corporate-v1');await click(page,'Preview numbering');await click(page,'Apply numbering');await saved(page,2);assert.equal(await page.$eval('[data-reference="review"]',node=>node.textContent),'(II)');
 await page.locator('[data-block-id="review-body"]').click();await click(page,'Preview indent');await click(page,'Apply section move');await saved(page,3);assert.equal(await page.$eval('[data-reference="review"]',node=>node.textContent),'(I)(A)');
 await click(page,'Undo');await saved(page,4);assert.equal(await page.$eval('[data-reference="review"]',node=>node.textContent),'(II)');
 const protocol=await page.createCDPSession();await protocol.send('Network.enable');let writes=0;protocol.on('Network.webSocketFrameSent',event=>{if(event.response.opcode===2&&Buffer.from(event.response.payloadData,'base64')[0]===2)writes++;});
 await click(page,'Join live editing');await page.waitForFunction(()=>document.querySelector('.save-controls')?.textContent.includes('Public collaboration connected'),{polling:100});
 assert.equal(await page.$eval('[data-reference="review"]',node=>node.textContent),'(II)');await page.locator('[data-reference="review"]').click();await click(page,'Reference');await click(page,'Go to target');assert.equal((await record(page,id)).version,4);assert.equal(writes,0,'Rendering and navigation must not persist derived strings.');
 await page.select(target,'agency');await click(page,'Insert reference');await page.waitForFunction(()=>document.querySelector('.save-controls')?.textContent.includes('Live edit acknowledged'),{polling:100});assert.ok(writes>0);assert.equal(await page.$eval('[data-reference="agency"]',node=>node.textContent),'Agency');const current=await record(page,id);assert.ok(current.version>4);
 page.once('dialog',dialog=>dialog.accept());await click(page,'Exit live editing');await saved(page,current.version);
 await page.locator('.side-panel section input[type=checkbox]').click();await withEditorReplacement(page,()=>click(page,'Freeze source for public input'));await page.waitForFunction(()=>document.querySelector('.ProseMirror')?.getAttribute('contenteditable')==='false',{polling:100});
 await page.locator('[data-reference="review"]').click();await click(page,'Reference');assert.equal(await page.$eval('input[aria-label="Optional reference label"]',node=>node.disabled),true);assert.equal(await page.$$eval('.reference-tools button',nodes=>nodes.find(node=>node.textContent==='Update reference').disabled),true);await click(page,'Go to target');
 assert.equal(await page.$eval('.ProseMirror',node=>node.getAttribute('contenteditable')),'false');await page.setViewport({width:320,height:900});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
}));
