import { before, after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import {
  createIdentityStore,
  applyIdentityMigrations,
  verifyIdentityRuntime,
} from "../server/identity-store.mjs";
import {
  createAccountHandler,
  createRequestBudget,
  requestCookies,
} from "../server/account-http.mjs";
import {
  createAccountAPI,
  invitationPackage,
  readInvitationPackage,
} from "../web/account-api.mjs";

const origin = "https://quill.example",
  sessionKey = randomBytes(32),
  stateKey = randomBytes(32);
let db, store, handler, clock;
const transaction = (fn) =>
  db.transaction(async (tx) => {
    await tx.exec("SET LOCAL ROLE dge_identity_runtime");
    return fn(tx);
  });
before(async () => {
  db = await PGlite.create();
  await applyIdentityMigrations((fn) => db.transaction(fn));
});
after(async () => {
  await db?.close();
});
beforeEach(async () => {
  await db.exec(
    "TRUNCATE dge_identity.accounts,dge_identity.tenants,dge_identity.login_challenges CASCADE",
  );
  clock = Date.now();
  store = createIdentityStore({
    transaction,
    sessionKey,
    stateKey,
    origin,
    clock: () => clock,
    passkeyAttestationPolicy: {
      id: "consumer-v1",
      allowedFormats: ["none"],
      allowedAaguids: ["00000000-0000-0000-0000-000000000000"],
    },
    verifyPasskeyRegistration: async ({ response }) => ({
      verified: response?.accepted === true,
      credential: {
        id: response?.credentialId,
        publicKey: randomBytes(32).toString("base64url"),
        counter: 0,
        transports: ["internal"],
        backedUp: false,
        attestationFormat: "none",
        aaguid: "00000000-0000-0000-0000-000000000000",
      },
    }),
    verifyPasskeyAuthentication: async ({ response }) => ({
      verified: response?.accepted === true,
      userVerified: response?.userVerified === true,
      credentialId: response?.credentialId,
      newCounter: response?.newCounter,
    }),
  });
  handler = createAccountHandler({
    store,
    origin,
    login: {
      start: async () => ({
        authorizationUrl: "https://provider.example/authorize",
        cookie:
          "__Host-dge_login=" +
          randomBytes(32).toString("base64url") +
          "; Path=/; Secure; HttpOnly",
      }),
    },
  });
});
const user = async (subject) => ({
  ...(await store.establishSession({
    issuer: "https://provider.example",
    subject,
    authenticatedAt: clock,
    authenticationMethods: ['pwd', 'mfa'],
  })),
  origin,
});
const call = (path, { who, method = "GET", body, headers = {} } = {}) =>
  handler(
    new Request(origin + path, {
      method,
      headers: {
        ...(who
          ? {
              cookie: "__Host-dge_session=" + who.sessionToken,
              origin,
              "x-dge-csrf": who.csrfToken,
            }
          : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
    { peerAddress: "127.0.0.1" },
  );

test("request runtime verification rejects administrators and accepts only expected scoped migrations", async () => {
  await assert.rejects(verifyIdentityRuntime(db), /Unprivileged/);
  assert.equal(await transaction(verifyIdentityRuntime), true);
});
test("own workspace directory exposes no other account membership and resets transaction context", async () => {
  const a = await user("a"),
    b = await user("b"),
    first = await store.createTenant(a),
    second = await store.createTenant(b);
  const response = await call("/api/workspaces", { who: a });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).items, [
    { tenantId: first.tenantId, role: "owner" },
  ]);
  await transaction(async (tx) => {
    assert.equal(
      (await tx.query("SELECT * FROM dge_identity.memberships")).rows.length,
      0,
    );
    await tx.query("SELECT set_config('dge.account_id',$1,true)", [
      a.accountId,
    ]);
    assert.equal(
      (
        await tx.query(
          "SELECT * FROM dge_identity.memberships WHERE tenant_id=$1",
          [second.tenantId],
        )
      ).rows.length,
      0,
    );
  });
});
test("own directory SELECT policy cannot be reused to insert or change another tenant membership", async () => {
  const a = await user("a"),
    b = await user("b"),
    room = await store.createTenant(b);
  await assert.rejects(
    transaction(async (tx) => {
      await tx.query("SELECT set_config('dge.account_id',$1,true)", [
        a.accountId,
      ]);
      await tx.query(
        "INSERT INTO dge_identity.memberships(tenant_id,account_id,role,updated_at) VALUES($1,$2,$3,$4)",
        [room.tenantId, a.accountId, "owner", new Date(clock)],
      );
    }),
    /row-level security/,
  );
});
test("session endpoint returns account metadata without usable session or CSRF credentials", async () => {
  const who = await user("a"),
    response = await call("/api/session", { who });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("access-control-allow-origin"), null);
  const body = await response.text();
  assert.ok(body.includes(who.accountId));
  assert.ok(!body.includes(who.sessionToken));
  assert.ok(!body.includes(who.csrfToken));
  assert.equal((await call("/api/session")).status, 401);
  assert.equal(
    (
      await call("/api/session", {
        who,
        headers: { "sec-fetch-site": "cross-site" },
      })
    ).status,
    403,
  );
});
test("recovery routes rotate codes and issue only restricted cookies", async () => {
  const who = await user("recovery-owner");
  const issued = await call("/api/recovery-codes", {
    who,
    method: "POST",
    body: {},
  });
  assert.equal(issued.status, 201);
  const { accountId, recoveryCodes } = await issued.json();
  assert.equal(accountId, who.accountId);
  assert.equal(recoveryCodes.length, 8);
  assert.equal(
    (
      await call("/api/recovery-session", {
        method: "POST",
        body: { accountId, recoveryCode: recoveryCodes[0] },
      })
    ).status,
    403,
  );
  const recovered = await call("/api/recovery-session", {
    method: "POST",
    body: { accountId, recoveryCode: recoveryCodes[0] },
    headers: { origin },
  });
  assert.equal(recovered.status, 200);
  assert.deepEqual(await recovered.json(), {
    recovered: true,
    recoveryRestricted: true,
  });
  const cookies = recovered.headers.getSetCookie().join("\n");
  assert.match(cookies, /__Host-dge_session=/);
  assert.match(cookies, /__Host-dge_csrf=/);
  assert.ok(!cookies.includes(recoveryCodes[0]));
  assert.equal(
    (
      await call("/api/recovery-session", {
        method: "POST",
        body: { accountId, recoveryCode: recoveryCodes[0] },
        headers: { origin },
      })
    ).status,
    403,
  );
  assert.equal((await call("/api/session", { who })).status, 401);
});
test("passkey step-up is required before an encrypted-device thumbprint is authorized", async () => {
  const who = await user("passkey-owner"), credentialId = randomBytes(32).toString("base64url");
  let response = await call("/api/passkeys/enrollment/options", { who, method: "POST", body: {} });
  assert.equal(response.status, 201);
  const enrollment = await response.json();
  response = await call("/api/passkeys/enrollment/verify", {
    who,
    method: "POST",
    body: { challenge: enrollment.challenge, response: { accepted: true, credentialId } },
  });
  assert.equal(response.status, 201);
  assert.equal((await call("/api/devices", { who, method: "POST", body: { keyThumbprint: "a".repeat(64) } })).status, 403);
  response = await call("/api/passkeys/authentication/options", { who, method: "POST", body: {} });
  const authentication = await response.json();
  response = await call("/api/passkeys/authentication/verify", {
    who,
    method: "POST",
    body: { challenge: authentication.challenge, response: { accepted: true, userVerified: true, credentialId, newCounter: 1 } },
  });
  assert.equal(response.status, 200);
  response = await call("/api/devices", { who, method: "POST", body: { keyThumbprint: "a".repeat(64) } });
  assert.equal(response.status, 201);
  const devices = await (await call("/api/devices", { who })).json();
  assert.equal(devices.items.length, 1);
  const passkeys = await (await call("/api/passkeys", { who })).json();
  assert.equal(passkeys.items.length, 1);
  response = await call(`/api/passkeys/${passkeys.items[0].id}`, { who, method: "DELETE", body: {} });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { revoked: true, devicesRevoked: 1 });
  assert.equal((await (await call("/api/devices", { who })).json()).items.length, 0);
  assert.equal((await call("/api/devices", { who, method: "POST", body: { keyThumbprint: "b".repeat(64) } })).status, 403);
});
test("workspace creation is protected at the HTTP boundary and does not accept caller identity fields", async () => {
  const who = await user("a");
  for (const headers of [
    { origin: "https://attacker.example" },
    { "x-dge-csrf": "" },
    { "x-dge-csrf": randomBytes(32).toString("base64url") },
  ])
    assert.equal(
      (
        await call("/api/workspaces", {
          who,
          method: "POST",
          body: {},
          headers,
        })
      ).status,
      403,
    );
  assert.equal(
    (
      await call("/api/workspaces", {
        who,
        method: "POST",
        body: { accountId: randomUUID() },
      })
    ).status,
    400,
  );
  const good = await call("/api/workspaces", { who, method: "POST", body: {} });
  assert.equal(good.status, 201);
  assert.match((await good.json()).tenantId, /^[a-f0-9-]{36}$/);
});
test("real HTTP member routes enforce account-bound invitation, authority and immediate removal", async () => {
  const owner = await user("owner"),
    member = await user("member"),
    impostor = await user("impostor"),
    { tenantId } = await store.createTenant(owner);
  const invite = await call(`/api/workspaces/${tenantId}/invitations`, {
    who: owner,
    method: "POST",
    body: { accountId: member.accountId, role: "editor" },
  });
  assert.equal(invite.status, 201);
  const { invitationToken } = await invite.json();
  assert.equal(
    (
      await call(`/api/workspaces/${tenantId}/join`, {
        who: impostor,
        method: "POST",
        body: { invitationToken },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await call(`/api/workspaces/${tenantId}/join`, {
        who: member,
        method: "POST",
        body: { invitationToken },
      })
    ).status,
    200,
  );
  const page = await call(`/api/workspaces/${tenantId}/members`, {
    who: member,
  });
  assert.equal((await page.json()).viewerRole, "editor");
  assert.equal(
    (
      await call(`/api/workspaces/${tenantId}/members/${owner.accountId}`, {
        who: member,
        method: "PATCH",
        body: { role: "viewer" },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await call(`/api/workspaces/${tenantId}/members/${member.accountId}`, {
        who: owner,
        method: "PATCH",
        body: { role: null },
      })
    ).status,
    200,
  );
  assert.equal(
    (await call(`/api/workspaces/${tenantId}/members`, { who: member })).status,
    403,
  );
});
test("expired recent-login allowance is reported without logging the user out of reads", async () => {
  const who = await user("a");
  clock += 300001;
  const response = await call("/api/workspaces", {
    who,
    method: "POST",
    body: {},
  });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error, "REAUTHENTICATION_REQUIRED");
  assert.equal((await call("/api/session", { who })).status, 200);
});
test("pending invitations can be inspected and cancelled without revealing their secret token", async () => {
  const owner = await user("owner"),
    target = await user("target"),
    { tenantId } = await store.createTenant(owner);
  const invite = await store.invite(
    owner,
    tenantId,
    target.accountId,
    "editor",
  );
  const response = await call(`/api/workspaces/${tenantId}/invitations`, {
      who: owner,
    }),
    text = await response.text();
  assert.ok(!text.includes(invite.invitationToken));
  assert.equal(JSON.parse(text).items[0].id, invite.invitationId);
  assert.equal(
    (
      await call(
        `/api/workspaces/${tenantId}/invitations/${invite.invitationId}`,
        { who: target, method: "DELETE", body: {} },
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await call(
        `/api/workspaces/${tenantId}/invitations/${invite.invitationId}`,
        { who: owner, method: "DELETE", body: {} },
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await call(`/api/workspaces/${tenantId}/join`, {
        who: target,
        method: "POST",
        body: { invitationToken: invite.invitationToken },
      })
    ).status,
    403,
  );
});
test("logout clears cookies only after a protected write and revoked sessions cannot replay", async () => {
  const who = await user("a"),
    another = await user("a");
  const denied = await call("/api/logout-all", {
    who,
    method: "POST",
    body: {},
    headers: { origin: "https://attacker.example" },
  });
  assert.equal(denied.status, 403);
  assert.deepEqual(denied.headers.getSetCookie(), []);
  const response = await call("/api/logout-all", {
    who,
    method: "POST",
    body: {},
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.getSetCookie().length, 3);
  assert.equal((await call("/api/session", { who: another })).status, 401);
});
test("callback issues secure separate cookies, removes the authorization query and never returns credentials as JSON", async () => {
  const who = await user("callback");
  handler = createAccountHandler({
    store,
    origin,
    login: {
      complete: async () => ({
        ...who,
        clearLoginCookie:
          "__Host-dge_login=; Path=/; Secure; HttpOnly; Max-Age=0",
      }),
    },
  });
  const response = await call("/auth/callback?code=one-use-code&state=fixture");
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), origin + "/account");
  const cookies = response.headers.getSetCookie();
  assert.equal(cookies.length, 3);
  assert.match(cookies[0], /HttpOnly; Secure; SameSite=Lax/);
  assert.match(cookies[1], /Secure; SameSite=Strict/);
  assert.doesNotMatch(cookies[1], /HttpOnly/);
  assert.equal(await response.text(), "");
});
test("unexpected provider errors redirect generically without leaking errors or credentials", async () => {
  handler = createAccountHandler({
    store,
    origin,
    login: {
      complete: async () => {
        throw Error("private-provider-detail");
      },
    },
  });
  const response = await call("/auth/callback?code=secret-code");
  assert.equal(response.status, 303);
  assert.equal(
    response.headers.get("location"),
    origin + "/account?login=failed",
  );
  assert.ok(!(await response.text()).includes("private-provider-detail"));
});
test("invalid routes, cookies, duplicate parameters, content type and large bodies fail before writes", async () => {
  const who = await user("a");
  assert.throws(() =>
    requestCookies(
      "__Host-dge_session=" +
        who.sessionToken +
        "; __Host-dge_session=" +
        who.sessionToken,
    ),
  );
  assert.equal(
    (
      await call("/api/session", {
        who,
        headers: { cookie: "__Host-dge_session=broken" },
      })
    ).status,
    400,
  );
  assert.equal(
    (await call("/api/workspaces?limit=1&limit=2", { who })).status,
    400,
  );
  assert.equal(
    (
      await call("/api/workspaces", {
        who,
        method: "POST",
        body: {},
        headers: { "content-type": "text/plain" },
      })
    ).status,
    415,
  );
  assert.equal(
    (
      await call("/api/workspaces", {
        who,
        method: "POST",
        body: { padding: "x".repeat(9000) },
      })
    ).status,
    413,
  );
  assert.equal(
    (
      await call("/api/establish-session", {
        who,
        method: "POST",
        body: { issuer: "https://provider.example", subject: "admin" },
      })
    ).status,
    404,
  );
  assert.equal(
    (await call("/api/session", { who, method: "POST", body: {} })).status,
    405,
  );
});
test("bounded request budget limits both a single peer and a flood of new peers", () => {
  let time = 0;
  const budget = createRequestBudget({
    clock: () => time,
    perPeer: 2,
    globalLimit: 5,
    maxKeys: 2,
    windowMs: 1000,
  });
  assert.equal(budget("a"), true);
  assert.equal(budget("a"), true);
  assert.equal(budget("a"), false);
  assert.equal(budget("b"), true);
  assert.equal(budget("c"), false);
  assert.equal(budget("b"), false);
  time = 1001;
  assert.equal(budget("a"), true);
});
test("browser API uses header proof, rejects missing proof and packages private invitations safely", async () => {
  const csrf = randomBytes(32).toString("base64url");
  let called;
  const api = createAccountAPI({
    cookie: () => "__Host-dge_csrf=" + csrf,
    fetcher: async (path, options) => {
      called = { path, options };
      return Response.json({ ok: true });
    },
  });
  await api("/api/workspaces", { method: "POST", body: {} });
  assert.equal(called.options.headers["x-dge-csrf"], csrf);
  assert.equal(called.options.credentials, "same-origin");
  const denied = createAccountAPI({
    cookie: () => "",
    fetcher: () => {
      throw Error("must not call");
    },
  });
  await assert.rejects(
    denied("/api/workspaces", { method: "POST", body: {} }),
    /SIGN_IN_AGAIN/,
  );
  const values = {
    tenantId: randomUUID(),
    invitationToken: randomBytes(32).toString("base64url"),
  };
  assert.deepEqual(
    readInvitationPackage(
      invitationPackage(values.tenantId, values.invitationToken),
    ),
    values,
  );
  assert.throws(() => readInvitationPackage("invalid"));
});
test("configured workspace, pending-invitation and active-session budgets are enforced", async () => {
  const limited = createIdentityStore({
    transaction,
    sessionKey,
    stateKey,
    origin,
    clock: () => clock,
    maxOwnedWorkspaces: 1,
    maxPendingInvitations: 1,
    maxSessions: 1,
  });
  const first = await limited.establishSession({
    issuer: "https://provider.example",
    subject: "limited",
    authenticatedAt: clock,
  });
  clock += 1;
  const second = {
    ...(await limited.establishSession({
      issuer: "https://provider.example",
      subject: "limited",
      authenticatedAt: clock,
    })),
    origin,
  };
  await assert.rejects(limited.account(first.sessionToken));
  const room = await limited.createTenant(second);
  await assert.rejects(limited.createTenant(second), /WORKSPACE_LIMIT_REACHED/);
  const target = await user("target");
  await limited.invite(second, room.tenantId, target.accountId, "viewer");
  await assert.rejects(
    limited.invite(second, room.tenantId, target.accountId, "editor"),
    /INVITATION_LIMIT_REACHED/,
  );
});

test('restoration start accepts no provider claims, requires same-origin CSRF POST and sets only login cookie', async () => {
  const who = await user('restore'), calls = [];
  handler = createAccountHandler({store, origin, login: {startRestoration: async credentials => {
    calls.push(credentials);
    return {authorizationUrl: 'https://provider.example/authorize', cookie: '__Host-dge_login=' + randomBytes(32).toString('base64url') + '; Path=/; HttpOnly; Secure; SameSite=Lax'};
  }}});
  assert.equal((await call('/api/provider-restoration')).status, 405);
  assert.equal((await call('/api/provider-restoration', {method:'POST', body:{}})).status, 403);
  assert.equal((await call('/api/provider-restoration', {who, method:'POST', body:{}, headers:{origin:'https://attacker.example'}})).status,403);
  assert.equal((await call('/api/provider-restoration', {who, method:'POST', body:{issuer:'https://attacker.example', subject:'owner'}})).status,400);
  assert.equal(calls.length,0);
  const result = await call('/api/provider-restoration', {who, method:'POST', body:{}});
  assert.equal(result.status,200);
  assert.deepEqual(await result.json(),{authorizationUrl:'https://provider.example/authorize'});
  assert.deepEqual(calls,[{sessionToken:who.sessionToken,csrfToken:who.csrfToken,origin}]);
  assert.equal(result.headers.getSetCookie().length,1);
  assert.match(result.headers.get('set-cookie'),/^__Host-dge_login=/);
});
test('restoration unavailable does not fall back to ordinary sign-in', async () => {
  const who = await user('restore');
  const result=await call('/api/provider-restoration',{who,method:'POST',body:{}});
  assert.equal(result.status,503);assert.equal((await result.json()).error,'PROVIDER_RESTORATION_UNAVAILABLE');
});
test('browser recovery sends codes only in a same-origin POST body and reports generic rejection',async()=>{
  const {recoverWithCode}=await import('../web/account-api.mjs');
  const accountId=randomUUID(),recoveryCode=randomBytes(32).toString('base64url');
  let count=0;
  const fetcher=async(path,init)=>{
    count++;assert.equal(path,'/api/recovery-session');assert.equal(init.method,'POST');
    assert.equal(init.credentials,'same-origin');assert.equal(init.cache,'no-store');
    assert.deepEqual(JSON.parse(init.body),{accountId,recoveryCode});
    assert.equal(init.headers['x-dge-csrf'],undefined);
    return Response.json({error:'ACCESS_DENIED'},{status:403});
  };
  await assert.rejects(recoverWithCode(accountId,recoveryCode,fetcher),e=>e.code==='RECOVERY_NOT_ACCEPTED');
  await assert.rejects(recoverWithCode(accountId,'bad-code',fetcher),e=>e.code==='RECOVERY_NOT_ACCEPTED');
  assert.equal(count,1);
});
