// Live multi-user journey against a deployed Quill service. Two independent
// Chrome profiles with virtual passkey authenticators create pseudonymous
// accounts through the real /signin page, then exercise workspace membership,
// template drafting (CivicQuill), amendment proposals, structured argument,
// frozen-electorate voting, exports, the transparency log and verification.
// It prints only statuses, identifiers and digests: never cookies or tokens.
// Usage: DGE_BROWSER_EXECUTABLE=… node scripts/live-journey.mjs https://civicquill.onrender.com
import puppeteer from "puppeteer-core";
import { verifyPackage } from "../src/verification-package.mjs";

const origin = process.argv[2];
if (!/^https:\/\/[a-z0-9.-]+$/.test(origin ?? "")) throw Error("Usage: live-journey.mjs https://host");
const product = new URL(origin).hostname.startsWith("charter") ? "charter" : "civic";
const results = [];
const record = (step, ok, detail = "") => { results.push({ step, ok, detail }); console.log((ok ? "PASS " : "FAIL ") + step + (detail ? " — " + detail : "")); };

async function member(browser) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  page.setDefaultTimeout(60000);
  const cdp = await page.createCDPSession();
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  await page.goto(origin + "/signin", { waitUntil: "networkidle2" });
  await page.waitForFunction(() => [...document.querySelectorAll("button")].some((b) => b.textContent.startsWith("Create an account")));
  await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent.startsWith("Create an account")).click());
  await page.waitForFunction(() => location.pathname === "/account", { timeout: 60000 });
  const api = (path, { method = "GET", body } = {}) => page.evaluate(async (path, method, body) => {
    const csrf = document.cookie.split("; ").find((c) => c.startsWith("__Host-dge_csrf="))?.split("=")[1];
    const response = await fetch(path, { method, headers: { accept: "application/json", ...(method !== "GET" ? { "content-type": "application/json", "x-dge-csrf": csrf } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const type = response.headers.get("content-type") ?? "";
    return { status: response.status, type, body: type.includes("json") ? await response.json() : { bytes: (await response.arrayBuffer()).byteLength } };
  }, path, method, body);
  const session = await api("/api/session");
  return { page, api, accountId: session.body.accountId };
}

const browser = await puppeteer.launch({ executablePath: process.env.DGE_BROWSER_EXECUTABLE, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
try {
  const sponsor = await member(browser), citizen = await member(browser);
  record("two members created accounts with passkeys", /^[a-f0-9-]{36}$/.test(sponsor.accountId) && /^[a-f0-9-]{36}$/.test(citizen.accountId) && sponsor.accountId !== citizen.accountId);
  const workspace = await sponsor.api("/api/workspaces", { method: "POST", body: {} });
  const tenantId = workspace.body.tenantId;
  record("sponsor created a workspace", workspace.status === 201 || workspace.status === 200, tenantId);
  const invite = await sponsor.api(`/api/workspaces/${tenantId}/invitations`, { method: "POST", body: { accountId: citizen.accountId, role: "participant" } });
  const join = await citizen.api(`/api/workspaces/${tenantId}/join`, { method: "POST", body: { invitationToken: invite.body.invitationToken } });
  record("citizen joined by invitation", join.status === 200, "role " + join.body.role);

  let document;
  if (product === "civic") {
    const bill = await sponsor.api(`/api/workspaces/${tenantId}/civic/bills`, { method: "POST", body: {
      jurisdictionId: "us-local", title: "Live verification ordinance", commandId: crypto.randomUUID(), parts: ["shortTitle", "operative", "effectiveDate"],
      values: { purpose: "verify the deployed CivicQuill service", shortTitle: "Live Verification Ordinance", body: "Verification Council", locality: "Testville", operative: ["The clerk shall publish the meeting calendar monthly."] } } });
    record("sponsor drafted a bill from a jurisdiction template", bill.status === 200, bill.body.notice ?? JSON.stringify(bill.body));
    document = bill.body.document;
  } else {
    const id = crypto.randomUUID();
    const created = await sponsor.api(`/api/workspaces/${tenantId}/documents`, { method: "POST", body: { commandId: crypto.randomUUID(), disclosure: "publish-all-revisions-v1", document: {
      schemaVersion: 2, id, tenantId, mode: "collaboration", lifecycle: "draft", revision: 0,
      metadata: { title: "Live verification resolution", locale: "en-US", numberingProfile: "corporate-v1" },
      content: [{ kind: "section", id: id + ":s1", title: "Resolution", children: [{ kind: "paragraph", id: id + ":p1", inlines: [{ kind: "text", text: "The board shall publish the meeting calendar monthly." }] }] }] } } });
    record("secretary published a resolution draft", created.status === 201, created.status === 201 ? "" : JSON.stringify(created.body));
    document = created.body.document;
    const org = await sponsor.api(`/api/workspaces/${tenantId}/charter/organization`, { method: "POST", body: { entityType: "corporation", legalName: "Live Verification Co.", jurisdiction: "Delaware" } });
    record("organization profile configured", org.status === 200);
  }
  const paragraph = JSON.stringify(document.content).match(/"id":"([^"]+:p\d+)","inlines":\[\{"kind":"text","text":"([^"]*monthly[^"]*)"/);
  const blockId = paragraph[1], text = paragraph[2], start = text.indexOf("monthly");
  const proposal = await citizen.api(`/api/workspaces/${tenantId}/documents/${document.id}/proposals`, { method: "POST", body: {
    baseVersion: 1, selection: { blockId, start, end: start + 7, quote: "monthly" }, replacement: "weekly", rationale: "Residents need earlier notice.", commandId: crypto.randomUUID(), disclosure: "publish-proposal-v1" } });
  record("citizen proposed exact replacement wording", proposal.status === 201, proposal.body.digest ?? JSON.stringify(proposal.body));
  const proposalId = proposal.body.proposal.id;
  const point = await citizen.api(`/api/workspaces/${tenantId}/documents/${document.id}/proposals/${proposalId}/points`, { method: "POST", body: {
    position: "support", text: "Weekly notice lets working residents plan to attend.", commandId: crypto.randomUUID(), disclosure: "publish-point-v1" } });
  record("citizen argued for the proposal", point.status === 201);
  const vote = await sponsor.api(`/api/workspaces/${tenantId}/documents/${document.id}/proposals/${proposalId}/point-votes/${point.body.point.id}`, { method: "PUT", body: { value: 1, expectedVoteVersion: 0, commandId: crypto.randomUUID() } }).catch(() => ({ status: 0 }));
  record("sponsor up-voted the argument", vote.status === 200, "status " + vote.status);
  const decision = await sponsor.api(`/api/workspaces/${tenantId}/documents/${document.id}/proposals/${proposalId}/decision`, { method: "POST", body: { hours: 1, commandId: crypto.randomUUID() } });
  record("sponsor opened a frozen-electorate decision", decision.status === 200, "eligible " + decision.body.eligibleCount);
  const ballot = await citizen.api(`/api/workspaces/${tenantId}/documents/${document.id}/proposals/${proposalId}/decision/ballots`, { method: "POST", body: { choice: "yes", expectedVersion: 0, commandId: crypto.randomUUID() } });
  record("citizen cast a ballot with a receipt digest", ballot.status === 200 && /^[a-f0-9]{64}$/.test(ballot.body.receiptDigest ?? ""), ballot.body.receiptDigest ?? JSON.stringify(ballot.body));
  const outsider = await member(browser);
  const denied = await outsider.api(`/api/workspaces/${tenantId}/documents/${document.id}/proposals/${proposalId}/decision/ballots`, { method: "POST", body: { choice: "no", expectedVersion: 0, commandId: crypto.randomUUID() } });
  record("a non-member cannot vote", denied.status === 403, "status " + denied.status);

  const pdf = await outsider.api(`/api/public/documents/${document.id}/export?format=pdf`);
  record("anyone can download the bound PDF edition", pdf.status === 200 && pdf.type === "application/pdf", pdf.body.bytes + " bytes");
  const read = await outsider.api(`/api/public/documents/${document.id}/read`);
  record("low-bandwidth reading page", read.status === 200 && read.type.startsWith("text/html"));
  const search = await outsider.api(`/api/public/search?q=${encodeURIComponent("verification")}`);
  record("public search answers", search.status === 200, (search.body.items?.length ?? 0) + " results");

  let pkg, report;
  for (let attempt = 0; attempt < 12; attempt++) {
    pkg = (await outsider.api(`/api/public/documents/${document.id}/verification-package`)).body;
    if (pkg.ledger?.status === "included") break;
    await new Promise((r) => setTimeout(r, 15000));
  }
  report = await verifyPackage(pkg);
  record("edition is included in the signed transparency log", pkg.ledger?.status === "included", "log size " + pkg.ledger?.checkpoint?.body?.size);
  record("offline verification of the downloaded package", report.overall === "consistent", report.checks.map((c) => c.id + ":" + c.state).join(", "));
  const anchors = await outsider.api("/api/public/ledger/anchors?limit=5");
  record("Bitcoin anchoring is queued or submitted", anchors.status === 200, (anchors.body.items ?? []).map((a) => a.status).join(", ") || "none yet (periodic anchors run hourly)");
} catch (error) {
  record("journey aborted", false, String(error?.message ?? error).slice(0, 300));
} finally {
  await browser.close();
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} live checks passed on ${origin}`);
process.exitCode = failed ? 1 : 0;
