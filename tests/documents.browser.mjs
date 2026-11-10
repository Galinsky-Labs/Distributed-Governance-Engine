import test from "node:test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import puppeteer from "puppeteer-core";
import { accountFixture } from "./support/account-fixture.mjs";
const binary = process.env.DGE_BROWSER_EXECUTABLE;
if (!binary) throw Error("DGE_BROWSER_EXECUTABLE is required");
async function click(page, label) {
  await page.bringToFront();
  await page.waitForFunction(
    (label) =>
      [...document.querySelectorAll("button")].some(
        (button) => button.textContent === label && !button.disabled,
      ),
    { polling: 100 },
    label,
  );
  const handle = await page.evaluateHandle(
    (label) =>
      [...document.querySelectorAll("button")].find(
        (button) => button.textContent === label,
      ),
    label,
  );
  await handle.asElement().click();
  await handle.dispose();
}
async function openCurrent(page) {
  await click(page, "Documents");
  await page.waitForSelector(".document-list button");
  await page.click(".document-list button");
  await page.waitForSelector(".save-controls");
}
async function prepend(page, text) {
  await page.bringToFront();
  await page.click(".ProseMirror p");
  await page.keyboard.press("Home");
  await page.keyboard.type(text);
}
async function saved(page, version) {
  await page.bringToFront();
  try {
    await page.waitForFunction(
      (version) =>
        document
          .querySelector(".save-controls")
          ?.textContent.includes("Saved version " + version),
      { polling: 100 },
      version,
    );
  } catch (cause) {
    console.log(
      "Synthetic save diagnostic:",
      await page.evaluate(() => ({
        save: document.querySelector(".save-controls")?.textContent,
        status: document.querySelector(".status")?.textContent,
        editable: document
          .querySelector(".ProseMirror")
          ?.getAttribute("contenteditable"),
      })),
    );
    throw cause;
  }
}
test(
  "Chrome publishes, saves, reopens and shares public legal text, preserves conflicting work and freezes public-input source",
  { timeout: 90000 },
  async () => {
    const fixture = await accountFixture({
      proposalListDelayMs: 200,
      documentListDelayMs: 200,
    });
    let browser;
    try {
      browser = await puppeteer.launch({
        executablePath: binary,
        headless: true,
        acceptInsecureCerts: true,
        args: ["--no-sandbox", "--disable-dev-shm-usage"],
      });
      const context = await browser.createBrowserContext(),
        owner = await context.newPage();
      owner.setDefaultTimeout(15000);
      await owner.setViewport({ width: 1440, height: 1050 });
      await owner.goto(fixture.origin + "/account");
      await owner.click('a[href="/auth/start"]');
      await owner.waitForSelector('input[name="subject"]');
      await owner.type('input[name="subject"]', "author");
      await click(owner, "Continue fixture login");
      await owner.waitForSelector(".account-id");
      await click(owner, "Create workspace");
      await owner.waitForSelector('select[aria-label="Your workspace"]');
      await click(owner, "Documents");
      await owner.waitForSelector(".public-create");
      assert.equal(
        await owner.$eval(".public-create button", (b) => b.disabled),
        true,
      );
      await owner.type(
        '.public-create input:not([type="checkbox"])',
        " — reviewed",
      );
      assert.equal(
        await owner.$eval(
          '.public-create input:not([type="checkbox"])',
          (element) => element.value,
        ),
        "Community Reporting Act — reviewed",
        "Background document loading must not drop title keystrokes.",
      );
      await owner.click('.public-create input[type="checkbox"]');
      await click(owner, "Publish current text");
      await saved(owner, 1);
      assert.deepEqual(
        await owner.evaluate(() => {
          const toolbar = document.querySelector(".toolbar"),
            editor = document.querySelector(".ProseMirror");
          return {
            toolbarRole: toolbar?.getAttribute("role"),
            toolbarLabel: toolbar?.getAttribute("aria-label"),
            editorRole: editor?.getAttribute("role"),
            editorLabel: editor?.getAttribute("aria-label"),
            editorMultiline: editor?.getAttribute("aria-multiline"),
          };
        }),
        {
          toolbarRole: "toolbar",
          toolbarLabel: "Legal editor tools",
          editorRole: "textbox",
          editorLabel: "Legal document text",
          editorMultiline: "true",
        },
      );
      await owner.keyboard.press("Tab");
      await owner.$eval(".ProseMirror", (editor) => editor.focus());
      assert.deepEqual(
        await owner.$eval(".ProseMirror", (editor) => {
          const style = getComputedStyle(editor);
          return {
            focusVisible: editor.matches(":focus-visible"),
            outlineStyle: style.outlineStyle,
            outlineWidth: style.outlineWidth,
          };
        }),
        { focusVisible: true, outlineStyle: "solid", outlineWidth: "3px" },
        "Keyboard focus on the legal textbox must be visible.",
      );
      const link = await owner.$eval(".save-controls a", (a) => a.href),
        id = new URL(link).searchParams.get("document");
      assert.ok(id);
      await prepend(owner, "Saved through the actual browser. ");
      await saved(owner, 2);
      assert.ok(
        (await owner.$eval(".ProseMirror", (el) => el.textContent)).includes(
          "Saved through the actual browser.",
        ),
      );

      const composed = "法令🧑🏽‍⚖️ é ";
      await owner.click(".ProseMirror p");
      await owner.keyboard.press("Home");
      await owner.evaluate(() =>
        document.activeElement.dispatchEvent(
          new CompositionEvent("compositionstart", { bubbles: true, data: "" }),
        ),
      );
      await owner.keyboard.sendCharacter(composed);
      await owner.evaluate((text) =>
        document.activeElement.dispatchEvent(
          new CompositionEvent("compositionend", { bubbles: true, data: text }),
        ), composed);
      await saved(owner, 3);
      assert.ok(
        (await owner.$eval(".ProseMirror", (el) => el.textContent)).includes(
          composed,
        ),
        "Committed IME text must preserve CJK, emoji sequences and combining marks.",
      );

      let droppedSave = false;
      const dropNextSave = (request) => {
        const path = new URL(request.url()).pathname;
        if (
          !droppedSave &&
          request.method() === "PUT" &&
          path.startsWith("/api/workspaces/") &&
          path.endsWith(`/documents/${id}`)
        ) {
          droppedSave = true;
          request.abort("internetdisconnected");
        } else request.continue();
      };
      await owner.setRequestInterception(true);
      owner.on("request", dropNextSave);
      await prepend(owner, "Recovered after an interrupted save. ");
      await owner.waitForFunction(() =>
        document.querySelector(".save-controls")?.textContent.includes("Save failed"),
      );
      assert.equal(droppedSave, true);
      assert.ok(
        (await owner.$eval(".ProseMirror", (el) => el.textContent)).includes(
          "Recovered after an interrupted save.",
        ),
        "An uncertain save must leave the local wording visible.",
      );
      owner.off("request", dropNextSave);
      await owner.setRequestInterception(false);
      await click(owner, "Save now");
      await saved(owner, 4);
      await owner.reload();
      await click(owner, "Documents");
      await owner.waitForSelector(".document-list button");
      await owner.click(".document-list button");
      await saved(owner, 4);
      assert.ok(
        (await owner.$eval(".ProseMirror", (el) => el.textContent)).includes(
          "Recovered after an interrupted save.",
        ),
      );
      const publicContext = await browser.createBrowserContext(),
        reader = await publicContext.newPage();
      await reader.bringToFront();
      await reader.goto(link);
      await reader.waitForFunction(() =>
        document
          .querySelector(".save-controls")
          ?.textContent.includes("Read only"),
      );
      assert.equal(
        await reader.$eval(".ProseMirror", (el) =>
          el.getAttribute("contenteditable"),
        ),
        "false",
      );
      assert.equal(
        await reader.$eval(".toolbar button", (b) => b.disabled),
        true,
      );
      await click(reader, "Load version history");
      await reader.waitForSelector(".version-history li");
      await click(reader, "Version 1");
      await reader.waitForFunction(() =>
        document
          .querySelector(".save-controls")
          ?.textContent.includes("Version 1"),
      );
      assert.ok(
        !(await reader.$eval(".ProseMirror", (el) => el.textContent)).includes(
          "Saved through the actual browser.",
        ),
      );
      const other = await context.newPage();
      other.setDefaultTimeout(15000);
      await other.goto(fixture.origin + "/");
      await openCurrent(other);
      await saved(other, 4);
      await prepend(owner, "First author wins this version. ");
      await saved(owner, 5);
      await prepend(other, "Keep this conflicting local wording. ");
      await other.waitForFunction(() =>
        document
          .querySelector(".save-controls")
          ?.textContent.includes("Saving stopped"),
      );
      assert.ok(
        (await other.$eval(".ProseMirror", (el) => el.textContent)).includes(
          "Keep this conflicting local wording.",
        ),
      );
      await mkdir("artifacts", { recursive: true });
      await owner.bringToFront();
      await owner.screenshot({
        path: "artifacts/document-desktop.png",
        fullPage: true,
      });
      await owner.setViewport({ width: 390, height: 844 });
      await owner.screenshot({
        path: "artifacts/document-mobile.png",
        fullPage: true,
      });
      assert.equal(
        await owner.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        true,
      );
      await owner.setViewport({ width: 320, height: 720 });
      assert.equal(
        await owner.evaluate(() => {
          const paper = document.querySelector(".paper").getBoundingClientRect();
          return (
            document.documentElement.scrollWidth <= innerWidth &&
            paper.left >= 0 &&
            paper.right <= innerWidth
          );
        }),
        true,
        "The document must reflow at 320 CSS pixels without page-level horizontal scrolling.",
      );
      await owner.setViewport({ width: 1440, height: 1050 });
      await owner.click('.side-panel section input[type="checkbox"]');
      await click(owner, "Freeze source for public input");
      await owner.waitForFunction(() =>
        document
          .querySelector(".edition")
          ?.textContent.includes("Fixed source"),
      );
      assert.equal(
        await owner.$eval(".ProseMirror", (el) =>
          el.getAttribute("contenteditable"),
        ),
        "false",
      );
      const forged = await owner.evaluate(async (id) => {
        const current = await (
          await fetch("/api/public/documents/" + id)
        ).json();
        const doc = {
          ...current.document,
          mode: "collaboration",
          lifecycle: "draft",
          revision: current.document.revision + 1,
        };
        return (
          await fetch(`/api/workspaces/${doc.tenantId}/documents/${id}`, {
            method: "PUT",
            headers: {
              "content-type": "application/json",
              "x-dge-csrf": document.cookie
                .split("; ")
                .find((v) => v.startsWith("__Host-dge_csrf="))
                .split("=")[1],
            },
            body: JSON.stringify({
              document: doc,
              expectedVersion: current.version,
              commandId: crypto.randomUUID(),
            }),
          })
        ).status;
      }, id);
      assert.equal(forged, 409);
      await owner.type(".search-tools label:first-child input", "annually");
      await click(owner, "Find next");
      await click(owner, "Suggest replacement");
      await owner.waitForSelector(".proposal-composer");
      await owner.type(".proposal-composer textarea", "quarterly");
      await owner.type(
        ".proposal-composer textarea[required]",
        "More frequent reporting improves accountability.",
      );
      assert.equal(
        await owner.$eval(
          ".proposal-composer textarea",
          (element) => element.value,
        ),
        "quarterly",
        "Background suggestion loading must not drop replacement keystrokes.",
      );
      assert.equal(
        await owner.$eval(
          ".proposal-composer textarea[required]",
          (element) => element.value,
        ),
        "More frequent reporting improves accountability.",
        "Background loading must not disable the rationale field.",
      );
      await owner.click('.proposal-composer input[type="checkbox"]');
      await click(owner, "Publish suggestion");
      await owner.waitForFunction(() =>
        document
          .querySelector(".proposal-detail")
          ?.textContent.includes("quarterly"),
      );
      assert.equal(
        await owner.$eval(".ProseMirror", (el) =>
          el.textContent.includes("quarterly"),
        ),
        false,
      );
      await owner.screenshot({
        path: "artifacts/proposal-panel-desktop.png",
        fullPage: true,
      });
      await owner.setViewport({ width: 390, height: 844 });
      await owner.screenshot({
        path: "artifacts/proposal-panel-mobile.png",
        fullPage: true,
      });
      assert.equal(
        await owner.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        true,
      );
      await owner.setViewport({ width: 1440, height: 1050 });
      await click(owner, "Close suggestions");
      await owner.screenshot({
        path: "artifacts/proposal-source.png",
        fullPage: true,
      });
      await reader.bringToFront();
      await reader.goto(link);
      await reader.waitForFunction(() =>
        document
          .querySelector(".edition")
          ?.textContent.includes("Fixed source"),
      );
      assert.ok(
        (await reader.$eval(".ProseMirror", (el) => el.textContent)).includes(
          "First author wins this version.",
        ),
      );
      assert.ok(
        !(await reader.$eval(".ProseMirror", (el) => el.textContent)).includes(
          "Keep this conflicting local wording.",
        ),
      );
      await click(reader, "Suggested changes");
      await reader.waitForFunction(() =>
        document
          .querySelector(".proposal-list")
          ?.textContent.includes("quarterly"),
      );
      assert.equal(await reader.$(".proposal-composer"), null);
    } finally {
      await browser?.close();
      await fixture.close();
    }
  },
);
