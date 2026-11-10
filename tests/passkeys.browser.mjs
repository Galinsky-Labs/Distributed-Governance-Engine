import test from 'node:test';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import {accountFixture} from './support/account-fixture.mjs';
import {createPasskeyVerifiers} from '../server/passkey-verifier.mjs';

const binary = process.env.DGE_BROWSER_EXECUTABLE;
if (!binary) throw Error('DGE_BROWSER_EXECUTABLE is required');
// Chromium's virtual CTAP2 model; never a production hardware policy.
const policy = {id: 'virtual-authenticator-test-only', allowedFormats: ['none'], allowedAaguids: ['01020304-0506-0708-0102-030405060708']};
async function click(page, text) {
  await page.waitForFunction(text => [...document.querySelectorAll('button')].some(x => x.textContent === text && !x.disabled), {}, text);
  const element = await page.evaluateHandle(text => [...document.querySelectorAll('button')].find(x => x.textContent === text), text);
  await element.asElement().click(); await element.dispose();
}
test('real verifier and virtual browser authenticator enroll, step up and revoke through account UI', {timeout: 60000}, async () => {
  const fixture = await accountFixture({hostname: 'localhost', passkeyConfiguration: {...createPasskeyVerifiers(), passkeyAttestationPolicy: policy}});
  let browser, page;
  const responses = [];
  try {
    browser = await puppeteer.launch({executablePath: binary, headless: true, acceptInsecureCerts: true, args: ['--no-sandbox', '--disable-dev-shm-usage']});
    page = await browser.newPage(); page.setDefaultTimeout(10000);
    page.on('response', async response => {
      if (new URL(response.url()).pathname.startsWith('/api/passkeys')) {
        const body = await response.json().catch(() => ({}));
        responses.push({path: new URL(response.url()).pathname, status: response.status(), error: body.error});
      }
    });
    const cdp = await page.createCDPSession();
    await cdp.send('WebAuthn.enable');
    await cdp.send('WebAuthn.addVirtualAuthenticator', {options: {
      protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true,
      isUserVerified: true, automaticPresenceSimulation: true,
    }});
    await page.goto(fixture.origin + '/account');
    await page.click('a.button-link[href="/auth/start"]');
    await page.waitForSelector('input[name="subject"]');
    await page.type('input[name="subject"]', 'passkeyowner');
    await click(page, 'Continue fixture login');
    await page.waitForSelector('.account-id');
    await click(page, 'Add a passkey');
    await page.waitForFunction(() => [...document.querySelectorAll('[role="status"]')].some(x => x.textContent === 'Passkey added.'));
    await click(page, 'Verify with a passkey');
    await page.waitForFunction(() => [...document.querySelectorAll('[role="status"]')].some(x => x.textContent === 'Account verified for five minutes.'));
    assert.equal(await page.evaluate(async () => (await (await fetch('/api/session')).json()).authenticationMethod), 'oidc');
    await click(page, 'Revoke passkey');
    await page.waitForFunction(() => [...document.querySelectorAll('[role="status"]')].some(x => x.textContent === 'Passkey revoked.'));
    assert.equal(await page.evaluate(async () => (await (await fetch('/api/passkeys')).json()).items.length), 0);
    assert.equal(await page.evaluate(async () => (await (await fetch('/api/session')).json()).passkeyStepUpExpiresAt), null);
  } catch (error) {
    console.error('Passkey workflow failure:', responses, await page?.$$eval('[role="status"]', nodes => nodes.map(x => x.textContent)));
    throw error;
  } finally {await browser?.close(); await fixture.close();}
});
