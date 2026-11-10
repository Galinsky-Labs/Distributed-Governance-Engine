import test from 'node:test';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import {accountFixture} from './support/account-fixture.mjs';
const binary=process.env.DGE_BROWSER_EXECUTABLE;
if(!binary)throw Error('DGE_BROWSER_EXECUTABLE is required');
async function click(page,text){await page.bringToFront();await page.waitForFunction(text=>[...document.querySelectorAll('button')].some(button=>button.textContent===text&&!button.disabled),{polling:100},text);const handle=await page.evaluateHandle(text=>[...document.querySelectorAll('button')].find(button=>button.textContent===text),text);await handle.asElement().click();await handle.dispose();}
test('live typing coalesces behind durable acknowledgments instead of overflowing the bounded server queue',{timeout:60000},async()=>{
 const fixture=await accountFixture({publicCollaboration:true,collaborationSaveDelayMs:100});let browser;let sent=0,outstanding=0,peak=0;
 try{
  browser=await puppeteer.launch({executablePath:binary,headless:true,acceptInsecureCerts:true,args:['--no-sandbox','--disable-dev-shm-usage']});const page=await browser.newPage();page.setDefaultTimeout(15000);
  const protocol=await page.createCDPSession();await protocol.send('Network.enable');
  protocol.on('Network.webSocketFrameSent',event=>{if(event.response.opcode===2&&Buffer.from(event.response.payloadData,'base64')[0]===2){sent++;outstanding++;peak=Math.max(peak,outstanding);}});
  protocol.on('Network.webSocketFrameReceived',event=>{if(event.response.opcode===2&&Buffer.from(event.response.payloadData,'base64')[0]===4)outstanding--;});
  await page.goto(fixture.origin+'/account');await page.click('a[href="/auth/start"]');await page.waitForSelector('input[name="subject"]');await page.type('input[name="subject"]','flowauthor');await click(page,'Continue fixture login');await page.waitForSelector('.account-id');await click(page,'Create workspace');await page.waitForFunction(()=>document.querySelector('select[aria-label="Your workspace"]')?.value,{polling:100});
  await click(page,'Documents');await page.waitForSelector('.public-create');await page.click('.public-create input[type=checkbox]');await click(page,'Publish current text');await page.waitForFunction(()=>document.querySelector('.save-controls')?.textContent.includes('Saved version 1'),{polling:100});
  const id=await page.$eval('.save-controls a',node=>new URL(node.href).searchParams.get('document'));
  await click(page,'Join live editing');await page.waitForFunction(()=>document.querySelector('.save-controls')?.textContent.includes('Public collaboration connected'),{polling:100});
  const burst='Rapid public editing must survive delayed durable acknowledgments. '.repeat(3);
  await page.click('.ProseMirror p');await page.keyboard.press('Home');await page.keyboard.type(burst);
  await page.waitForFunction(()=>{const text=document.querySelector('.save-controls')?.textContent??'';return text.includes('Live edit acknowledged')||text.includes('ended')||text.includes('paused');},{polling:100});
  const status=await page.$eval('.save-controls',node=>node.textContent);
  assert.match(status,/Live edit acknowledged/,'The connection must stay usable while commits are slow.');
  const record=await page.evaluate(async id=>(await(await fetch('/api/public/documents/'+id)).json()),id);
  const words=record.document.content[0].children[0].inlines.map(run=>run.text??'').join('');assert.ok(words.includes(burst),'The complete burst must reach an immutable saved version.');
  assert.ok(sent>0);assert.equal(peak,1,'Only one unacknowledged client update may be in flight.');assert.equal(outstanding,0);
  assert.deepEqual(fixture.collaborationStats(),{rooms:1,connections:1});
 }finally{await browser?.close();await fixture.close();}
});
