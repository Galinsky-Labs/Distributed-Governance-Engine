import { readFile } from "node:fs/promises";
import pg from "pg";
import { createDocumentStore } from "./document-store.mjs";
import { createDocumentRoutes, documentBodyLimit } from "./document-http.mjs";
import {
  createIdentityStore,
  pgTransactions,
  verifyIdentityRuntime,
} from "./identity-store.mjs";
import { discoverIdentityProvider, createOIDCLogin } from "./oidc-login.mjs";
import { createDiscussionStore } from "./discussion-store.mjs";
import {
  createDiscussionRoutes,
  discussionBodyLimit,
} from "./discussion-http.mjs";
import { createProposalStore } from "./proposal-store.mjs";
import { createProposalRoutes, proposalBodyLimit } from "./proposal-http.mjs";
import { createAccountHandler } from "./account-http.mjs";
import { createEngineApplication, createEngineServer } from "./application.mjs";
import { attachPublicCollaborationHub } from "./public-collaboration-hub.mjs";

const required = (name) => {
  const value = process.env[name];
  if (!value) throw Error("Missing configuration: " + name);
  return value;
};
try {
  const origin = required("PUBLIC_ORIGIN"),
    url = new URL(required("DATABASE_URL"));
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname)
    throw Error("Invalid database configuration");
  for (const name of ["sslmode", "sslcert", "sslkey", "sslrootcert"])
    url.searchParams.delete(name);
  const pool = new pg.Pool({
    connectionString: url.href,
    max: 4,
    connectionTimeoutMillis: 10000,
    statement_timeout: 10000,
    ssl: {
      rejectUnauthorized: true,
      minVersion: "TLSv1.3",
      servername: url.hostname,
    },
  });
  pool.on("error", () => {}); // No credential-bearing pg error objects enter logs.
  await verifyIdentityRuntime(pool);
  const decode = (name) => {
    const raw = required(name);
    if (!/^[a-f0-9]{64}$/.test(raw))
      throw Error("Identity keys must be 32-byte lowercase hexadecimal values");
    return Buffer.from(raw, "hex");
  };
  const store = createIdentityStore({
    transaction: pgTransactions(pool),
    sessionKey: decode("SESSION_KEY"),
    stateKey: decode("OIDC_STATE_KEY"),
    origin,
  });
  // Each pass deletes at most 500 expired challenges; the timer is not a
  // credential or session validity boundary, and it must not keep shutdown alive.
  const loginPruneTimer = setInterval(() => {
    store.pruneExpiredLogins().catch(() =>
      console.error("Expired login challenge cleanup failed."),
    );
  }, 60000);
  loginPruneTimer.unref();
  const configuration = await discoverIdentityProvider({
    issuer: required("OIDC_ISSUER"),
    clientId: required("OIDC_CLIENT_ID"),
    clientSecret: required("OIDC_CLIENT_SECRET"),
  });
  const documents = createDocumentStore({
    identity: store,
    transaction: pgTransactions(pool),
  });
  const redirectUri = origin + "/auth/callback";
  const login = createOIDCLogin({ store, configuration, redirectUri }),
    accounts = createAccountHandler({
      store,
      login,
      origin,
      extensions: [
        createDiscussionRoutes({
          discussion: createDiscussionStore({
            identity: store,
            transaction: pgTransactions(pool),
          }),
        }),
        createProposalRoutes({
          proposals: createProposalStore({
            identity: store,
            transaction: pgTransactions(pool),
          }),
        }),
        createDocumentRoutes({ documents }),
      ],
    });
  const application = createEngineApplication({
    accounts,
    origin,
    product: process.env.QUILL_PRODUCT ?? "civic",
  });
  const key = await readFile(required("TLS_KEY_FILE")),
    cert = await readFile(required("TLS_CERT_FILE"));
  const server = createEngineServer({
    application,
    origin,
    key,
    cert,
    bodyLimit: (path) =>
      Math.max(
        documentBodyLimit(path),
        proposalBodyLimit(path),
        discussionBodyLimit(path),
      ),
  });
  const collaboration = attachPublicCollaborationHub({server, origin, documents});
  const port = Number(process.env.PORT ?? 8443);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw Error("Invalid port");
  server.listen(port, process.env.BIND_ADDRESS ?? "127.0.0.1", () =>
    console.log(
      "Governance account service listening; configured origin and credentials are not logged.",
    ),
  );
  const stop = () => {
    clearInterval(loginPruneTimer);
    collaboration.close();
    server.close(() => {
      pool.end().finally(() => process.exit());
    });
    server.closeIdleConnections();
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
} catch {
  console.error(
    "Account service startup failed. Check configured origin, identity provider, migrations, runtime permissions, TLS and secret references. No credential details were logged.",
  );
  process.exit(1);
}

