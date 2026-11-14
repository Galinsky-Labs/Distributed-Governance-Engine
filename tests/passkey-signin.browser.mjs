import test from "node:test";
import assert from "node:assert/strict";
import puppeteer from "puppeteer-core";
import { accountFixture } from "./support/account-fixture.mjs";

const binary = process.env.DGE_BROWSER_EXECUTABLE;
if (!binary) throw Error("DGE_BROWSER_EXECUTABLE is required");
const click = async (page, text) => {
  await page.waitForFunction((t) => [...document.querySelectorAll("button")].some((b) => b.textContent === t && !b.disabled), {}, text);
  const el = await page.evaluateHandle((t) => [...document.querySelectorAll("button")].find((b) => b.textContent === t), text);
  await el.asElement().click(); await el.dispose();
};

test("a new member creates an account with a passkey, signs out and signs back in to the same account", { timeout: 90000 }, async () => {
  const fixture = await accountFixture({ hostname: "localhost" });
  let browser;
  try {
    browser = await puppeteer.launch({ executablePath: binary, headless: true, acceptInsecureCerts: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
    const page = await browser.newPage(); page.setDefaultTimeout(15000);
    const cdp = await page.createCDPSession();
    await cdp.send("WebAuthn.enable");
    await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
    await page.goto(fixture.origin + "/signin");
    await click(page, "Create an account with a new passkey");
    await page.waitForFunction(() => location.pathname === "/account");
    const first = await page.evaluate(async () => (await (await fetch("/api/session")).json()).accountId);
    assert.match(first, /^[a-f0-9-]{36}$/);
    await page.evaluate(async () => {
      const csrf = document.cookie.split("; ").find((c) => c.startsWith("__Host-dge_csrf=")).split("=")[1];
      await fetch("/api/logout", { method: "POST", headers: { "content-type": "application/json", "x-dge-csrf": csrf }, body: "{}" });
    });
    assert.equal(await page.evaluate(async () => (await fetch("/api/session")).status), 401);
    await page.goto(fixture.origin + "/signin");
    await click(page, "Sign in with a passkey");
    await page.waitForFunction(() => location.pathname === "/governance");
    assert.equal(await page.evaluate(async () => (await (await fetch("/api/session")).json()).accountId), first, "the same passkey returns to the same account");
    const forged = await page.evaluate(async () => {
      const options = await (await fetch("/auth/passkey/login/options", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json();
      const clientDataJSON = btoa(JSON.stringify({ type: "webauthn.get", challenge: options.challenge, origin: location.origin })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      const response = { id: "AAAAAAAAAAAAAAAAAAAAAA", rawId: "AAAAAAAAAAAAAAAAAAAAAA", type: "public-key", clientExtensionResults: {}, response: { clientDataJSON, authenticatorData: "AAAA", signature: "AAAA" } };
      const r = await fetch("/auth/passkey/login/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ response }) });
      return [r.status, (await r.json()).error];
    });
    assert.deepEqual(forged, [403, "PASSKEY_NOT_VERIFIED"]);
    const crossOrigin = await page.evaluate(async () => (await fetch("/auth/passkey/login/options", { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" })).status);
    assert.notEqual(crossOrigin, 200);
  } finally { await browser?.close(); await fixture.close(); }
});
