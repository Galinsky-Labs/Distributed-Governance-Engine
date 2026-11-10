import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import puppeteer from 'puppeteer-core';
import {createLegalDocument} from '../src/legal-structure.mjs';
import {accountFixture} from './support/account-fixture.mjs';
const binary=process.env.DGE_BROWSER_EXECUTABLE;
if(!binary)throw Error('DGE_BROWSER_EXECUTABLE is required');
async function click(page,text){await page.bringToFront();await page.waitForFunction(text=>[...document.querySelectorAll('button')].some(button=>button.textContent===text&&!button.disabled),{polling:100},text);const handle=await page.evaluateHandle(text=>[...document.querySelectorAll('button')].find(button=>button.textContent===text),text);await handle.asElement().click();await handle.dispose();}
async function saved(page,version){await page.waitForFunction(version=>document.querySelector('.save-controls')?.textContent.includes('Saved version '+version),{polling:100},version);}
async function post(page,path,body){return page.evaluate(async({path,body})=>{const csrf=document.cookie.split('; ').find(value=>value.startsWith('__Host-dge_csrf=')).split('=')[1];const result=await fetch(path,{method:'POST',headers:{'content-type':'application/json','x-dge-csrf':csrf},body:JSON.stringify(body)});if(!result.ok)throw Error('Section fixture API rejected');return result.json();},{path,body});}
const ids=page=>page.$$eval('.ProseMirror [data-block-id]',nodes=>nodes.map(node=>node.dataset.blockId).sort());
test('authenticated section previews preserve IDs, undo and saved source while rejecting stale/live/frozen moves',{timeout:90000},async()=>{
 const fixture=await accountFixture({publicCollaboration:true});let browser;
 try{
  browser=await puppeteer.launch({executablePath:binary,headless:true,acceptInsecureCerts:true,args:['--no-sandbox','--disable-dev-shm-usage']});const page=await browser.newPage();page.setDefaultTimeout(15000);
  await page.goto(fixture.origin+'/account');await page.click('a[href="/auth/start"]');await page.waitForSelector('input[name="subject"]');await page.type('input[name="subject"]','sectionauthor');await click(page,'Continue fixture login');await page.waitForSelector('.account-id');await click(page,'Create workspace');await page.waitForFunction(()=>document.querySelector('select[aria-label="Your workspace"]')?.value,{polling:100});
  const tenantId=await page.$eval('select[aria-label="Your workspace"]',node=>node.value),id=randomUUID();
  const d=structuredClone(createLegalDocument({id,tenantId,title:'Section acceptance'}));
  const paragraph=(id,text)=>({kind:'paragraph',id,inlines:[{kind:'text',text,marks:['bold']}]});
  d.content=[{kind:'section',id:'reports',title:'Reports',children:[paragraph('reports-body','Report annually.')]},{kind:'section',id:'review',title:'Review',children:[paragraph('review-body','Review reports.')]},{kind:'section',id:'records',title:'Records',children:[{kind:'paragraph',id:'records-body',inlines:[{kind:'reference',targetId:'review'}]}]}];
  await post(page,`/api/workspaces/${tenantId}/documents`,{document:d,commandId:randomUUID(),disclosure:'publish-all-revisions-v1'});
  await click(page,'Documents');await page.waitForSelector('.document-list button');await page.click('.document-list button');await saved(page,1);
  const originalIds=await ids(page);await page.click('.ProseMirror [data-block-id="review-body"]');await click(page,'Preview indent');
  assert.equal(await page.$('.ProseMirror [data-block-id="reports"] [data-block-id="review"]'),null);
  assert.deepEqual(await page.$$eval('.section-tools tbody tr',rows=>rows.map(row=>[...row.cells].map(cell=>cell.textContent))),[['Review','SEC. 2.','(a)'],['Records','SEC. 3.','SEC. 2.']]);
  assert.match(await page.$eval('.section-tools',node=>node.textContent),/1 dependent references/);
  assert.match(await page.$eval('.section-tools',node=>node.textContent),/Indent “Review” inside “Reports”/);
  await click(page,'Apply section move');await page.waitForSelector('.ProseMirror [data-block-id="reports"] [data-block-id="review"]');await saved(page,2);assert.deepEqual(await ids(page),originalIds);assert.equal(await page.$eval('.ProseMirror [data-block-id="review-body"]',node=>node.textContent),'Review reports.');
  await click(page,'Undo');await page.waitForSelector('.ProseMirror > [data-block-id="review"]');await saved(page,3);
  await click(page,'Redo');await page.waitForSelector('.ProseMirror [data-block-id="reports"] [data-block-id="review"]');await saved(page,4);
  await click(page,'Preview outdent');await click(page,'Apply section move');await page.waitForSelector('.ProseMirror > [data-block-id="review"]');await saved(page,5);
  const restored=await page.evaluate(async id=>(await(await fetch('/api/public/documents/'+id)).json()).document.content,id);assert.deepEqual(restored,d.content);assert.deepEqual(await ids(page),originalIds);
  await click(page,'Documents');await page.waitForSelector('.document-list button');await page.click('.document-list button');await saved(page,5);assert.deepEqual(await ids(page),originalIds);
  await page.click('.ProseMirror [data-block-id="review-body"]');await click(page,'Preview indent');await page.click('.ProseMirror [data-block-id="review-body"]');await page.keyboard.type('Changed ');await page.waitForFunction(()=>!document.querySelector('.section-tools table'),{polling:100});await saved(page,6);
  await click(page,'Join live editing');await page.waitForFunction(()=>document.querySelector('.save-controls')?.textContent.includes('Public collaboration connected'),{polling:100});await page.click('.ProseMirror [data-block-id="review-body"]');
  assert.equal(await page.$$eval('.section-tools button',nodes=>nodes.every(node=>node.disabled)),true);
  page.once('dialog',dialog=>dialog.accept());await click(page,'Exit live editing');await page.waitForFunction(()=>document.querySelector('.save-controls')?.textContent.includes('Saved version'),{polling:100});
  await page.setViewport({width:320,height:900});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.setViewport({width:1360,height:1000});
  await page.click('.side-panel section input[type=checkbox]');await click(page,'Freeze source for public input');await page.waitForFunction(()=>document.querySelector('.ProseMirror')?.getAttribute('contenteditable')==='false',{polling:100});assert.equal(await page.$$eval('.section-tools button',nodes=>nodes.every(node=>node.disabled)),true);
 }finally{await browser?.close();await fixture.close();}
});
