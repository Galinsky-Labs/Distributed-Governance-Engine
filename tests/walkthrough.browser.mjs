// DCE-031 real-browser walkthrough checks on the standalone editor build:
// desktop and mobile, 200% browser zoom (a 1280×900 screen at 2× is a
// 640×450 CSS viewport), reduced motion, attachment on scroll/resize,
// Escape with focus return and a persisted step across reload.
import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import puppeteer from "puppeteer-core";

const binary = process.env.DGE_BROWSER_EXECUTABLE;
if (!binary) throw Error("DGE_BROWSER_EXECUTABLE is required for walkthrough checks");
const url = pathToFileURL(resolve("dist/offline/CivicQuill.html")).href;

const geometry = (page) => page.evaluate(() => {
  const tour = document.querySelector(".tour")?.getBoundingClientRect();
  const target = document.querySelector(".tour-target")?.getBoundingClientRect();
  return tour && target && { tour: { left: tour.left, top: tour.top, right: tour.right, bottom: tour.bottom }, target: { left: target.left, bottom: target.bottom },
    viewport: { width: innerWidth, height: innerHeight }, step: document.querySelector(".tour .eyebrow").textContent,
    focused: document.activeElement?.id || document.activeElement?.textContent };
});
const openTour = async (page) => {
  await page.waitForSelector(".ProseMirror");
  const opener = await page.waitForSelector("xpath/.//button[normalize-space()='Take a tour']");
  await opener.focus();
  await page.keyboard.press("Enter");
  await page.waitForSelector(".tour");
};

test("walkthrough stays attached and usable on desktop, mobile and 200% zoom with reduced motion", { timeout: 120000 }, async () => {
  const browser = await puppeteer.launch({ executablePath: binary, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--allow-file-access-from-files"] });
  try {
    for (const [name, viewport, zoom] of [["desktop", { width: 1280, height: 900 }, 1], ["mobile", { width: 375, height: 740, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }, 1], ["zoom-200", { width: 640, height: 450, deviceScaleFactor: 2 }, 1]]) {
      const page = await browser.newPage();
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.setViewport(viewport);
      await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
      await page.goto(url, { waitUntil: "load" });
      await page.evaluate(() => localStorage.clear());
      await page.reload({ waitUntil: "load" });
      if (zoom !== 1) await page.evaluate((z) => { document.documentElement.style.zoom = String(z); }, zoom);
      await openTour(page);
      let g = await geometry(page);
      assert.match(g.step, /STEP 1 OF/, name);
      assert.equal(g.focused, "walkthrough-title", name + ": focus moves to the step heading");
      assert.ok(g.tour.left >= 0 && g.tour.right <= g.viewport.width + 1, name + ": balloon fits horizontally " + JSON.stringify(g));
      for (let i = 0; i < 2; i++) await page.keyboard.press("Tab");
      const next = await page.$("xpath/.//aside[contains(@class,'tour')]//button[normalize-space()='Next']");
      await next.click();
      g = await geometry(page);
      assert.match(g.step, /STEP 2 OF/);
      // Scroll and resize keep the balloon next to its target.
      await page.evaluate(() => window.scrollBy(0, 120));
      await page.setViewport({ ...viewport, height: viewport.height - 100 });
      await new Promise((r) => setTimeout(r, 100));
      g = await geometry(page);
      assert.ok(Math.abs(g.tour.top - Math.min(Math.max(12, g.target.bottom + 14), g.viewport.height - 280)) <= 2, name + ": reattached after scroll/resize " + JSON.stringify(g));
      // Escape closes and returns focus to the opener; the step is remembered.
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => !document.querySelector(".tour"));
      assert.equal(await page.evaluate(() => document.activeElement?.textContent), "Take a tour");
      await page.reload({ waitUntil: "load" });
      await openTour(page);
      assert.match((await geometry(page)).step, /STEP 2 OF/, name + ": resumes the saved step");
      await (await page.$("xpath/.//aside[contains(@class,'tour')]//button[normalize-space()='Start over']")).click();
      assert.match((await geometry(page)).step, /STEP 1 OF/);
      assert.deepEqual(errors, []);
      await page.close();
    }
  } finally { await browser.close(); }
});
