import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import puppeteer from "puppeteer-core";
import { createLocalWorkingCopy } from "../web/local-drafts.mjs";

const binary = process.env.DGE_BROWSER_EXECUTABLE;
if (!binary) throw Error("DGE_BROWSER_EXECUTABLE is required for offline checks");

test("standalone CivicQuill and CharterQuill draft and import without HTTP", { timeout: 90000 }, async () => {
  const folder = await mkdtemp(join(tmpdir(), "quill-offline-test-"));
  let browser;
  try {
    browser = await puppeteer.launch({executablePath: binary,headless:true,args:["--no-sandbox","--disable-dev-shm-usage"]});
    for (const brand of ["CivicQuill", "CharterQuill"]) {
      const product = brand === "CivicQuill" ? "civic" : "charter";
      const page = await browser.newPage();
      const external = [];
      page.on("request", request => {
        if (/^https?:/.test(request.url())) external.push(request.url());
      });
      await page.goto(pathToFileURL(resolve("dist/offline/" + brand + ".html")).href, {waitUntil:"load"});
      await page.waitForSelector(".ProseMirror");
      assert.match(await page.$eval(".brand", el => el.textContent), new RegExp(brand));
      assert.equal(await page.evaluate(() => document.documentElement.dataset.accountEnabled === "true"), false);
      assert.equal(await page.$eval(".ProseMirror", el => el.getAttribute("contenteditable")), "true");
      page.once("dialog", dialog => dialog.accept("Independent local draft"));
      await page.evaluate(() => [...document.querySelectorAll("button")].find(b => b.textContent === "New document").click());
      await page.waitForFunction(() => document.querySelector("h1")?.textContent === "Independent local draft");
      const draft = createLocalWorkingCopy(product, "Imported public draft");
      const path = join(folder, product + ".json");
      await writeFile(path, JSON.stringify(draft), "utf8");
      const upload = await page.$('input[aria-label="Import public working-copy JSON"]');
      assert.ok(upload, "Import control missing");
      await upload.uploadFile(path);
      await page.waitForFunction(() => document.querySelector("h1")?.textContent === "Imported public draft");
      assert.equal(external.length, 0, "Offline draft unexpectedly reached an HTTP endpoint");
      await page.close();
    }
  } finally {
    await browser?.close();
    await rm(folder, {recursive:true,force:true});
  }
});
