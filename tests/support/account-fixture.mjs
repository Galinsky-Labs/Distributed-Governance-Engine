// Synthetic provider and database, only for browser/integration tests. Not imported by production.
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  generateKeyPairSync,
  randomBytes,
  createHash,
  sign,
} from "node:crypto";
import { createServer } from "node:https";
import { PGlite } from "@electric-sql/pglite";
import * as oidc from "openid-client";
import {
  createIdentityStore,
  applyIdentityMigrations,
} from "../../server/identity-store.mjs";
import { createOIDCLogin } from "../../server/oidc-login.mjs";
import { createDiscussionStore } from "../../server/discussion-store.mjs";
import {
  createDiscussionRoutes,
  discussionBodyLimit,
} from "../../server/discussion-http.mjs";
import { createProposalStore } from "../../server/proposal-store.mjs";
import {
  createProposalRoutes,
  proposalBodyLimit,
} from "../../server/proposal-http.mjs";
import { createAccountHandler } from "../../server/account-http.mjs";
import { createDocumentStore } from "../../server/document-store.mjs";
import {
  createDocumentRoutes,
  documentBodyLimit,
} from "../../server/document-http.mjs";
import {
  createEngineApplication,
  nodeListener,
} from "../../server/application.mjs";

const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (ch) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        ch
      ],
  );
export async function accountFixture({
  proposalListDelayMs = 0,
  documentListDelayMs = 0,
} = {}) {
  for (const delay of [proposalListDelayMs, documentListDelayMs])
    if (!Number.isSafeInteger(delay) || delay < 0 || delay > 1000)
      throw Error("Invalid fixture delay");
  const temporary = await mkdtemp(join(tmpdir(), "dge-fixture-tls-"));
  let key, cert;
  try {
    const certificate = spawnSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        join(temporary, "key.pem"),
        "-out",
        join(temporary, "cert.pem"),
        "-subj",
        "/CN=localhost",
        "-addext",
        "subjectAltName=DNS:localhost,IP:127.0.0.1",
        "-days",
        "1",
      ],
      { stdio: "ignore" },
    );
    if (certificate.status !== 0)
      throw Error("Fixture TLS certificate generation failed");
    [key, cert] = await Promise.all([
      readFile(join(temporary, "key.pem")),
      readFile(join(temporary, "cert.pem")),
    ]);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  const signing = generateKeyPairSync("rsa", { modulusLength: 2048 }),
    codes = new Map();
  const db = await PGlite.create();
  await applyIdentityMigrations((fn) => db.transaction(fn));
  let listener;
  const server = createServer(
    { key, cert, minVersion: "TLSv1.3", ALPNProtocols: ["http/1.1"] },
    (req, res) => {
      if (listener) listener(req, res);
      else {
        res.statusCode = 503;
        res.end();
      }
    },
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = "https://127.0.0.1:" + server.address().port,
    issuer = origin + "/fixture",
    clientId = "engine-browser-fixture",
    clientSecret = "fixture-only-client-secret";
  const transaction = (fn) =>
    db.transaction(async (tx) => {
      await tx.exec("SET LOCAL ROLE dge_identity_runtime");
      return fn(tx);
    });
  const store = createIdentityStore({
    transaction,
    origin,
    sessionKey: randomBytes(32),
    stateKey: randomBytes(32),
  });
  const config = new oidc.Configuration(
    {
      issuer,
      authorization_endpoint: issuer + "/authorize",
      token_endpoint: issuer + "/token",
      jwks_uri: issuer + "/jwks",
      code_challenge_methods_supported: ["S256"],
      id_token_signing_alg_values_supported: ["RS256"],
      response_types_supported: ["code"],
    },
    clientId,
    clientSecret,
  );
  config[oidc.customFetch] = async (url, options) => {
    if (String(url) === issuer + "/jwks")
      return Response.json({
        keys: [
          {
            ...signing.publicKey.export({ format: "jwk" }),
            alg: "RS256",
            kid: "fixture-key",
            use: "sig",
          },
        ],
      });
    if (String(url) !== issuer + "/token")
      throw Error("Unexpected fixture provider endpoint");
    const form = new URLSearchParams(options.body),
      record = codes.get(form.get("code"));
    codes.delete(form.get("code"));
    if (
      !record ||
      record.expiresAt < Date.now() ||
      form.get("client_id") !== clientId ||
      form.get("client_secret") !== clientSecret ||
      createHash("sha256")
        .update(form.get("code_verifier") ?? "")
        .digest("base64url") !== record.challenge
    )
      return Response.json({ error: "invalid_grant" }, { status: 400 });
    const now = Math.floor(Date.now() / 1000),
      payload = {
        iss: issuer,
        sub: record.subject,
        aud: clientId,
        iat: now,
        exp: now + 300,
        auth_time: now,
        amr: ["pwd", "mfa"],
        nonce: record.nonce,
      };
    const unsigned =
      Buffer.from(
        JSON.stringify({ alg: "RS256", kid: "fixture-key" }),
      ).toString("base64url") +
      "." +
      Buffer.from(JSON.stringify(payload)).toString("base64url");
    const id_token =
      unsigned +
      "." +
      sign("RSA-SHA256", Buffer.from(unsigned), signing.privateKey).toString(
        "base64url",
      );
    return Response.json({
      access_token: "discarded-fixture-token",
      token_type: "Bearer",
      expires_in: 300,
      id_token,
    });
  };
  const login = createOIDCLogin({
    store,
    configuration: config,
    redirectUri: origin + "/auth/callback",
  });
  const accounts = createAccountHandler({
      store,
      login,
      origin,
      extensions: [
        createDiscussionRoutes({
          discussion: createDiscussionStore({
            identity: store,
            transaction: transaction,
          }),
        }),
        createProposalRoutes({
          proposals: createProposalStore({
            identity: store,
            transaction: transaction,
          }),
        }),
        createDocumentRoutes({
          documents: createDocumentStore({ identity: store, transaction }),
        }),
      ],
    }),
    application = createEngineApplication({ accounts, origin });
  listener = nodeListener({
    origin,
    bodyLimit: (path) =>
      Math.max(
        documentBodyLimit(path),
        proposalBodyLimit(path),
        discussionBodyLimit(path),
      ),
    application: async (request, context) => {
      const url = new URL(request.url);
      if (url.pathname !== "/fixture/authorize") {
        if (
          documentListDelayMs &&
          request.method === "GET" &&
          /^\/api\/workspaces\/[a-f0-9-]{36}\/documents$/.test(url.pathname)
        )
          await new Promise((resolve) =>
            setTimeout(resolve, documentListDelayMs),
          );
        if (
          proposalListDelayMs &&
          request.method === "GET" &&
          /^\/api\/public\/documents\/[a-f0-9-]{36}\/proposals$/.test(
            url.pathname,
          )
        )
          await new Promise((resolve) =>
            setTimeout(resolve, proposalListDelayMs),
          );
        return application(request, context);
      }
      const params = url.searchParams;
      if (
        params.get("client_id") !== clientId ||
        params.get("redirect_uri") !== origin + "/auth/callback" ||
        params.get("code_challenge_method") !== "S256"
      )
        return new Response("Invalid fixture flow", { status: 400 });
      if (!params.has("subject"))
        return new Response(
          '<!doctype html><html><body><h1>Local test identity provider</h1><form method="GET">' +
            [...params]
              .map(
                ([name, value]) =>
                  '<input type="hidden" name="' +
                  escape(name) +
                  '" value="' +
                  escape(value) +
                  '">',
              )
              .join("") +
            '<label>Test subject<input name="subject" required pattern="[a-z]{1,16}"></label><button>Continue fixture login</button></form></body></html>',
          {
            headers: {
              "content-type": "text/html; charset=utf-8",
              "cache-control": "no-store",
            },
          },
        );
      if (!/^[a-z]{1,16}$/.test(params.get("subject")))
        return new Response("Invalid fixture subject", { status: 400 });
      const code = randomBytes(32).toString("base64url");
      codes.set(code, {
        subject: params.get("subject"),
        nonce: params.get("nonce"),
        challenge: params.get("code_challenge"),
        expiresAt: Date.now() + 60000,
      });
      return new Response(null, {
        status: 303,
        headers: {
          location:
            origin +
            "/auth/callback?" +
            new URLSearchParams({ code, state: params.get("state") }),
        },
      });
    },
  });
  return {
    origin,
    db,
    store,
    close: async () => {
      await new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      });
      await db.close();
    },
  };
}
