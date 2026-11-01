import test from "node:test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import puppeteer from "puppeteer-core";
import { accountFixture } from "./support/account-fixture.mjs";

const binary = process.env.DGE_BROWSER_EXECUTABLE;
if (!binary)
  throw Error(
    "DGE_BROWSER_EXECUTABLE is required; browser validation cannot be skipped",
  );
async function click(page, text) {
  await page.waitForFunction(
    (text) =>
      [...document.querySelectorAll("button")].some(
        (b) => b.textContent === text && !b.disabled,
      ),
    {},
    text,
  );
  const handle = await page.evaluateHandle(
    (text) =>
      [...document.querySelectorAll("button")].find(
        (b) => b.textContent === text,
      ),
    text,
  );
  await handle.asElement().click();
  await handle.dispose();
}
async function fillLabel(page, label, value) {
  const handle = await page.evaluateHandle(
    (label) =>
      [...document.querySelectorAll("label")]
        .find((el) => el.childNodes[0]?.textContent.trim() === label)
        ?.querySelector("input,textarea"),
    label,
  );
  const element = handle.asElement();
  assert.ok(element, "Input label missing: " + label);
  await element.type(value);
  await handle.dispose();
}
async function login(context, origin, subject) {
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  await page.setViewport({ width: 1360, height: 1000 });
  await page.goto(origin + "/account");
  await page.waitForSelector('a.button-link[href="/auth/start"]');
  await page.click('a.button-link[href="/auth/start"]');
  await page.waitForSelector('input[name="subject"]');
  await page.type('input[name="subject"]', subject);
  await click(page, "Continue fixture login");
  await page.waitForSelector(".account-id");
  return page;
}
test(
  "Chrome runs OIDC sign-in, workspace invitation, role controls, removal and session revocation through the actual app",
  { timeout: 90000 },
  async () => {
    const fixture = await accountFixture();
    let browser;
    try {
      browser = await puppeteer.launch({
        executablePath: binary,
        headless: true,
        acceptInsecureCerts: true,
        args: ["--no-sandbox", "--disable-dev-shm-usage"],
      });
      console.log(
        "Browser fixture: " +
          (await browser.version()) +
          "; synthetic provider; no production credentials.",
      );
      const ownerContext = await browser.createBrowserContext(),
        memberContext = await browser.createBrowserContext();
      const owner = await login(ownerContext, fixture.origin, "owner"),
        member = await login(memberContext, fixture.origin, "member");
      const memberId = await member.$eval(
        ".account-id",
        (element) => element.textContent,
      );
      const cookieView = await owner.evaluate(() => document.cookie);
      assert.ok(!cookieView.includes("__Host-dge_session="));
      assert.ok(cookieView.includes("__Host-dge_csrf="));
      const originalCookies = await ownerContext.cookies();
      assert.equal(
        originalCookies.find((c) => c.name === "__Host-dge_session").httpOnly,
        true,
      );
      await click(owner, "Issue recovery codes");
      await owner.waitForFunction(
        () => document.querySelectorAll(".recovery-codes li").length === 8,
      );
      const issuedCodes = await owner.$$eval(
        ".recovery-codes li",
        (items) => items.map((item) => item.textContent),
      );
      assert.equal(new Set(issuedCodes).size, 8);
      await click(owner, "Close account panel");
      await click(owner, "Account & workspaces");
      assert.equal(await owner.$(".recovery-codes"), null);
      const primaryContext = await browser.createBrowserContext(),
        primary = await login(primaryContext, fixture.origin, "primaryonly");
      await click(primary, "Issue recovery codes");
      await primary.waitForFunction(
        () => document.querySelector('.account-panel [role="status"]')
          ?.textContent === "Sign in with multifactor authentication before issuing recovery codes.",
      );
      assert.equal(await primary.$(".recovery-codes"), null);
      await click(owner, "Create workspace");
      await owner.waitForSelector('input[maxlength="36"]');
      await fillLabel(owner, "Invitee account ID", memberId);
      await click(owner, "Create invitation");
      await owner.waitForSelector("textarea[readonly]");
      const code = await owner.$eval(
        "textarea[readonly]",
        (element) => element.value,
      );
      assert.ok(code.startsWith("quill1."));
      await fillLabel(member, "Invitation code", code);
      await click(member, "Accept invitation");
      await member.waitForFunction(() => document.querySelector(".member-row"));
      const tenantId = await owner.$eval(
        'select[aria-label="Your workspace"]',
        (element) => element.value,
      );
      await owner.reload();
      await owner.waitForFunction(
        (id) =>
          [...document.querySelectorAll(".member-row")].some((row) =>
            row.textContent.includes(id),
          ),
        {},
        memberId,
      );
      const row = await owner.evaluateHandle(
        (id) =>
          [...document.querySelectorAll(".member-row")].find((row) =>
            row.textContent.includes(id),
          ),
        memberId,
      );
      const select = await row.asElement().$("select");
      await select.select("viewer");
      const save = await row.asElement().$("button");
      await save.click();
      await owner.waitForFunction(
        () =>
          document.querySelector('.account-panel [role="status"]')
            .textContent === "Role updated.",
      );
      const forged = await member.evaluate(
        async ({ tenantId, memberId }) => {
          const csrf = document.cookie
            .split(";")
            .find((s) => s.trim().startsWith("__Host-dge_csrf="))
            .trim()
            .split("=")[1];
          return (
            await fetch(`/api/workspaces/${tenantId}/members/${memberId}`, {
              method: "PATCH",
              headers: {
                "content-type": "application/json",
                "x-dge-csrf": csrf,
              },
              body: JSON.stringify({ role: "owner" }),
            })
          ).status;
        },
        { tenantId, memberId },
      );
      assert.equal(forged, 403);
      const remove = await owner.evaluateHandle(
        (id) =>
          [...document.querySelectorAll(".member-row")]
            .find((row) => row.textContent.includes(id))
            ?.querySelectorAll("button")[1],
        memberId,
      );
      await remove.asElement().click();
      await owner.waitForFunction(
        () =>
          document.querySelector('.account-panel [role="status"]')
            .textContent === "Member removed.",
      );
      const denied = await member.evaluate(
        async (tenantId) =>
          (await fetch(`/api/workspaces/${tenantId}/members`)).status,
        tenantId,
      );
      assert.equal(denied, 403);
      await mkdir("artifacts", { recursive: true });
      await owner.screenshot({
        path: "artifacts/account-desktop.png",
        fullPage: true,
      });
      await owner.setViewport({ width: 390, height: 844 });
      assert.equal(
        await owner.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
        true,
      );
      await owner.screenshot({
        path: "artifacts/account-mobile.png",
        fullPage: true,
      });
      await click(owner, "Sign out everywhere");
      await owner.waitForSelector('a.button-link[href="/auth/start"]');
      // Replay a formerly usable token through the real handler after revocation.
      const token = originalCookies.find(
        (c) => c.name === "__Host-dge_session",
      ).value;
      await ownerContext.setCookie({
        name: "__Host-dge_session",
        value: token,
        url: fixture.origin,
        httpOnly: true,
        secure: true,
        sameSite: "Lax",
      });
      const revoked = await owner.evaluate(
        async () => (await fetch("/api/session")).status,
      );
      assert.equal(revoked, 401);
    } finally {
      await browser?.close();
      await fixture.close();
    }
  },
);
