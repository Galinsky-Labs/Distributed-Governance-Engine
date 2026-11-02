import test from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import puppeteer from "puppeteer-core";
import {createLegalDocument} from "../src/legal-structure.mjs";
import {accountFixture} from "./support/account-fixture.mjs";

const binary = process.env.DGE_BROWSER_EXECUTABLE;
if (!binary) throw Error("DGE_BROWSER_EXECUTABLE is required");
const write = async (page, path, body) => page.evaluate(async ({path,body}) => {
  const csrf = document.cookie.split("; ").find(value=>value.startsWith("__Host-dge_csrf="))?.split("=")[1];
  if (!csrf) throw Error("Missing CSRF session cookie");
  const result = await fetch(path,{
    method:"POST",headers:{"content-type":"application/json","x-dge-csrf":csrf,"origin":location.origin},
    body:JSON.stringify(body)
  });
  const value = await result.json();
  if (!result.ok) throw Error("API rejected fixture workflow: " + result.status + " " + value.error);
  return value;
},{path,body});

test("real browser: two authenticated members publish, deliberate and vote on a frozen proposal", {timeout:90000}, async()=>{
  const fixture=await accountFixture();
  let browser;
  try {
    browser=await puppeteer.launch({executablePath:binary,headless:true,acceptInsecureCerts:true,
      args:["--no-sandbox","--disable-dev-shm-usage"]});
    const page=await browser.newPage();
    page.setDefaultTimeout(20000);
    await page.goto(fixture.origin+"/account");
    await page.click('a[href="/auth/start"]');
    await page.waitForSelector('input[name="subject"]');
    await page.type('input[name="subject"]',"alice");
    await page.evaluate(() => [...document.querySelectorAll("button")].find(b => b.textContent === "Continue fixture login").click());
    await page.waitForSelector(".account-id");
    const created=await write(page,"/api/workspaces",{});
    const tenantId=created.tenantId;
    const document=structuredClone(createLegalDocument({id:randomUUID(),tenantId,title:"Public oversight charter"}));
    document.content[0].inlines=[{kind:"text",text:"Publish annual reports."}];
    const record=await write(page,"/api/workspaces/"+tenantId+"/documents",{
      document,commandId:randomUUID(),disclosure:"publish-all-revisions-v1"
    });
    assert.equal(record.version,1);
    const proposed=await write(page,"/api/workspaces/"+tenantId+"/documents/"+document.id+"/proposals",{
      baseVersion:1,selection:{blockId:document.content[0].id,start:8,end:14,quote:"annual"},
      replacement:"quarterly",rationale:"Provide more frequent public accountability.",
      commandId:randomUUID(),disclosure:"publish-proposal-v1"
    });
    assert.equal(proposed.baseVersion,1);
    await write(page,"/api/workspaces/"+tenantId+"/documents/"+document.id+"/proposals/"+proposed.proposal.id+"/points",{
      position:"support",text:"Quarterly reporting exposes problems sooner.",
      commandId:randomUUID(),disclosure:"publish-point-v1"
    });
    // A separately signed-in account joins before the vote is opened. The
    // electorate is frozen from real memberships, not browser-local personas.
    const otherContext=await browser.createBrowserContext();
    const other=await otherContext.newPage();
    other.setDefaultTimeout(20000);
    await other.goto(fixture.origin+"/account");
    await other.click('a[href="/auth/start"]');
    await other.waitForSelector('input[name="subject"]');
    await other.type('input[name="subject"]',"bob");
    await other.evaluate(() => [...document.querySelectorAll("button")].find(b => b.textContent === "Continue fixture login").click());
    await other.waitForSelector(".account-id");
    const who=await other.evaluate(async()=>{
      const response=await fetch("/api/session");return response.json();
    });
    const invitation=await write(page,"/api/workspaces/"+tenantId+"/invitations",{
      accountId:who.accountId,role:"participant"
    });
    await write(other,"/api/workspaces/"+tenantId+"/join",{
      invitationToken:invitation.invitationToken
    });
    await page.goto(fixture.origin+"/governance");
    await page.waitForSelector(".governance-columns");
    await page.waitForFunction(()=>document.querySelector(".governance-list")?.textContent.includes("Public oversight charter"));
    assert.match(await page.$eval(".governance-page h1",x=>x.textContent),/Decisions start/);
    assert.match(await page.$eval(".governance-column",x=>x.textContent),/Public oversight charter/);
    await page.waitForFunction(()=>document.querySelectorAll(".governance-column")[1]?.textContent.includes("Provide more frequent public accountability."));
    await page.waitForFunction(()=>document.querySelector(".governance-column-debate")?.textContent.includes("Quarterly reporting exposes problems sooner."));
    const before=await page.$eval(".governance-change del",x=>x.textContent);
    const after=await page.$eval(".governance-change ins",x=>x.textContent);
    assert.equal(before,"annual");
    assert.equal(after,"quarterly");
    const links=await page.$$eval(".governance-page a",nodes=>nodes.map(x=>new URL(x.href).pathname));
    assert(links.includes("/account"));
    assert(links.includes("/"));
    await page.waitForSelector(".decision-open");
    const opening=await page.$(".decision-ack input");
    await opening.click();
    await page.click(".decision-open>button");
    await page.waitForSelector(".decision-tally");
    assert.match(await page.$eval(".decision-window",el=>el.textContent),/2 eligible members/);
    await page.evaluate(()=>[...document.querySelectorAll(".decision-ballot button")].find(x=>x.textContent==="Vote yes").click());
    await page.waitForFunction(()=>document.querySelector(".decision-state")?.textContent.includes("Your ballot: yes"));
    await other.goto(fixture.origin+"/governance");
    await other.waitForFunction(()=>document.querySelector(".decision-ballot button"));
    await other.evaluate(()=>[...document.querySelectorAll(".decision-ballot button")].find(x=>x.textContent==="Vote no").click());
    await other.waitForFunction(()=>document.querySelector(".decision-state")?.textContent.includes("Your ballot: no"));
    await page.click(".decision-heading button");
    await page.waitForFunction(()=>{
      const cells=[...document.querySelectorAll(".decision-tally strong")].map(x=>x.textContent);
      return cells[0]==="1"&&cells[1]==="1";
    });
    assert.match(await page.$eval(".decision-legal-note",el=>el.textContent),/not signed/);
    await other.close();
    await otherContext.close();
    await page.close();
  } finally {await browser?.close();await fixture.close();}
});
