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
async function field(page,selector,text){await page.click(selector);await page.keyboard.down('Control');await page.keyboard.press('KeyA');await page.keyboard.up('Control');await page.keyboard.type(text);}
async function post(page,path,body){return page.evaluate(async({path,body})=>{const csrf=document.cookie.split('; ').find(value=>value.startsWith('__Host-dge_csrf=')).split('=')[1];const result=await fetch(path,{method:'POST',headers:{'content-type':'application/json','x-dge-csrf':csrf},body:JSON.stringify(body)});if(!result.ok)throw Error('Numbering fixture API rejected');return result.json();},{path,body});}
test('authenticated numbering preview applies, undoes, reloads and respects live/frozen source',{timeout:90000},async()=>{
 const fixture=await accountFixture({publicCollaboration:true});let browser;
 try{
  browser=await puppeteer.launch({executablePath:binary,headless:true,acceptInsecureCerts:true,args:['--no-sandbox','--disable-dev-shm-usage']});const page=await browser.newPage();page.setDefaultTimeout(15000);
  await page.goto(fixture.origin+'/account');await page.click('a[href="/auth/start"]');await page.waitForSelector('input[name="subject"]');await page.type('input[name="subject"]','numberauthor');await click(page,'Continue fixture login');await page.waitForSelector('.account-id');await click(page,'Create workspace');await page.waitForFunction(()=>document.querySelector('select[aria-label="Your workspace"]')?.value,{polling:100});
  const tenantId=await page.$eval('select[aria-label="Your workspace"]',node=>node.value),id=randomUUID();
  const d=structuredClone(createLegalDocument({id,tenantId,title:'Numbering acceptance'}));
  d.content=[{kind:'section',id:'reports',title:'Reports',children:[{kind:'paragraph',id:'reports-body',inlines:[{kind:'text',text:'Report annually.',marks:['bold']}]}]},{kind:'section',id:'review',title:'Review',children:[{kind:'paragraph',id:'review-body',inlines:[{kind:'text',text:'See '},{kind:'reference',targetId:'reports'}]}]}];
  await post(page,`/api/workspaces/${tenantId}/documents`,{document:d,commandId:randomUUID(),disclosure:'publish-all-revisions-v1'});
  await click(page,'Documents');await page.waitForSelector('.document-list button');await page.click('.document-list button');await saved(page,1);
  const before=await page.evaluate(async id=>(await(await fetch('/api/public/documents/'+id)).json()).document.content,id);
  await page.select('.numbering-tools select','corporate-v1');await field(page,'.numbering-tools input[type=number]','4');await field(page,'.numbering-tools input:not([type=number])','5');await click(page,'Preview numbering');
  assert.match(await page.$eval('.ProseMirror h2',node=>node.textContent),/^SEC\. 1\./);
  assert.deepEqual(await page.$$eval('.numbering-preview tbody tr',rows=>rows.map(row=>[...row.cells].map(cell=>cell.textContent))),[['Reports','SEC. 1.','(IV)'],['Review','SEC. 2.','(VI)']]);
  assert.match(await page.$eval('.numbering-tools',node=>node.textContent),/1 dependent references/);
  await click(page,'Apply numbering');await page.waitForFunction(()=>document.querySelector('.ProseMirror h2')?.textContent.startsWith('(IV)'),{polling:100});await saved(page,2);
  const after=await page.evaluate(async id=>(await(await fetch('/api/public/documents/'+id)).json()).document.content,id);assert.deepEqual(after,before);
  await click(page,'Undo');await page.waitForFunction(()=>document.querySelector('.ProseMirror h2')?.textContent.startsWith('SEC. 1.'),{polling:100});await saved(page,3);
  assert.equal(await page.evaluate(async id=>Object.hasOwn((await(await fetch('/api/public/documents/'+id)).json()).document.metadata,'numberingRules'),id),false);
  await click(page,'Redo');await saved(page,4);await click(page,'Documents');await page.waitForSelector('.document-list button');await page.click('.document-list button');await saved(page,4);assert.match(await page.$eval('.ProseMirror h2',node=>node.textContent),/^\(IV\)/);
  await field(page,'.numbering-tools input:not([type=number])','9, 8');await click(page,'Preview numbering');assert.match(await page.$eval('.numbering-tools [role=status]',node=>node.textContent),/strictly increasing/);assert.equal(await page.$('.numbering-preview'),null);
  await field(page,'.numbering-tools input:not([type=number])','5');await click(page,'Preview numbering');await page.click('.ProseMirror p');await page.keyboard.press('Home');await page.keyboard.type('Updated ');await page.waitForFunction(()=>!document.querySelector('.numbering-preview'),{polling:100});await saved(page,5);
  await click(page,'Join live editing');await page.waitForFunction(()=>document.querySelector('.save-controls')?.textContent.includes('Public collaboration connected'),{polling:100});
  assert.equal(await page.$$eval('.numbering-tools input,.numbering-tools select,.numbering-tools button',nodes=>nodes.every(node=>node.disabled)),true);
  page.once('dialog',dialog=>dialog.accept());await click(page,'Exit live editing');await page.waitForFunction(()=>document.querySelector('.save-controls')?.textContent.includes('Saved version'),{polling:100});assert.match(await page.$eval('.ProseMirror h2',node=>node.textContent),/^\(IV\)/);
  await page.setViewport({width:320,height:900});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.setViewport({width:1360,height:1000});
  await page.click('.side-panel section input[type=checkbox]');await click(page,'Freeze source for public input');await page.waitForFunction(()=>document.querySelector('.ProseMirror')?.getAttribute('contenteditable')==='false',{polling:100});
  assert.equal(await page.$$eval('.numbering-tools input,.numbering-tools select,.numbering-tools button',nodes=>nodes.every(node=>node.disabled)),true);
 }finally{await browser?.close();await fixture.close();}
});
