import test from 'node:test';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import {accountFixture} from './support/account-fixture.mjs';
import {openSelectedSavedDocument} from './support/editor-browser.mjs';
const binary=process.env.DGE_BROWSER_EXECUTABLE;
if(!binary)throw Error('DGE_BROWSER_EXECUTABLE is required');
async function click(page,text){await page.bringToFront();await page.waitForFunction(text=>[...document.querySelectorAll('button')].some(button=>button.textContent===text&&!button.disabled),{polling:100},text);const handle=await page.evaluateHandle(text=>[...document.querySelectorAll('button')].find(button=>button.textContent===text),text);await handle.asElement().click();await handle.dispose();}
test('reopening the same saved version waits for the fetched editor rather than accepting the previous saved status',{timeout:60000},async()=>{
 const fixture=await accountFixture();let browser,release,previous;
 try{
  browser=await puppeteer.launch({executablePath:binary,headless:true,acceptInsecureCerts:true,args:['--no-sandbox','--disable-dev-shm-usage']});const page=await browser.newPage();page.setDefaultTimeout(15000);
  await page.goto(fixture.origin+'/account');await page.click('a[href="/auth/start"]');await page.waitForSelector('input[name="subject"]');await page.type('input[name="subject"]','readinessauthor');await click(page,'Continue fixture login');await page.waitForSelector('.account-id');await click(page,'Create workspace');await page.waitForFunction(()=>document.querySelector('select[aria-label="Your workspace"]')?.value,{polling:100});
  await click(page,'Documents');await page.waitForSelector('.public-create');await page.click('.public-create input[type=checkbox]');await click(page,'Publish current text');await page.waitForFunction(()=>document.querySelector('.save-controls')?.textContent.includes('Saved version 1'),{polling:100});
  const link=await page.$eval('.save-controls a',node=>node.href),id=new URL(link).searchParams.get('document');previous=await page.$('.ProseMirror');
  let requested;const observed=new Promise(resolve=>{requested=resolve;}),held=new Promise(resolve=>{release=resolve;});let intercepted=false,finished=false;
  await page.setRequestInterception(true);
  page.on('request',async request=>{
   if(!intercepted&&request.method()==='GET'&&new URL(request.url()).pathname.endsWith('/documents/'+id)){intercepted=true;requested();await held;}
   await request.continue();
  });
  await click(page,'Documents');await page.waitForSelector('.document-list button');
  const opening=openSelectedSavedDocument(page).then(()=>{finished=true;});
  await observed;
  assert.match(await page.$eval('.save-controls',node=>node.textContent),/Saved version 1/,'The earlier saved status is still visible while the new request is held.');
  assert.equal(await page.evaluate(node=>node.isConnected,previous),true);assert.equal(finished,false);
  release();await opening;
  assert.equal(finished,true);assert.equal(await page.evaluate(node=>node.isConnected,previous),false);
  assert.match(await page.$eval('.save-controls',node=>node.textContent),/Saved version 1/);assert.equal(await page.$('.document-library'),null);
 }finally{release?.();await previous?.dispose();await browser?.close();await fixture.close();}
});
