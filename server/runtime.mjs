// Production runtime shared by the engine and the CivicQuill/CharterQuill
// application packages. Configuration comes only from the environment; no
// credential, origin or document content is ever logged.
import { readFile } from "node:fs/promises";
import pg from "pg";
import { createIdentityStore, pgTransactions, verifyIdentityRuntime } from "./identity-store.mjs";
import { discoverIdentityProvider, createOIDCLogin } from "./oidc-login.mjs";
import { createEngineServer, createEdgeServer } from "./application.mjs";
import { attachPublicCollaborationHub } from "./public-collaboration-hub.mjs";
import { configuredPasskeys } from "./passkey-verifier.mjs";
import { createPlatform, startWorkers, verifyExtensionMigrations } from "./platform.mjs";
import { loadLogSigningKey } from "./ledger.mjs";
import { postmarkFromEnvironment } from "./email-adapters/postmark.mjs";
import { stripeProviderFromEnvironment } from "./payment-providers/stripe.mjs";
import { manualProviderFromEnvironment } from "./payment-providers/manual.mjs";

const required = (env, name) => {
  const value = env[name];
  if (!value) throw Error("Missing configuration: " + name);
  return value;
};
const hexKey = (env, name) => {
  const raw = required(env, name);
  if (!/^[a-f0-9]{64}$/.test(raw)) throw Error("Identity keys must be 32-byte lowercase hexadecimal values");
  return Buffer.from(raw, "hex");
};

export function databasePool(rawUrl, { max = 4 } = {}) {
  const url = new URL(rawUrl);
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname) throw Error("Invalid database configuration");
  for (const name of ["sslmode", "sslcert", "sslkey", "sslrootcert", "channel_binding"]) url.searchParams.delete(name);
  const pool = new pg.Pool({
    connectionString: url.href, max, connectionTimeoutMillis: 10000, statement_timeout: 10000,
    idleTimeoutMillis: 30000,
    ssl: { rejectUnauthorized: true, minVersion: "TLSv1.3", servername: url.hostname },
  });
  pool.on("error", () => {}); // pg error objects can carry credentials.
  return pool;
}

async function anchorProvidersFrom(env) {
  const names = (env.ANCHOR_PROVIDERS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const providers = [];
  for (const name of names) {
    if (name !== "opentimestamps") throw Error("Unknown anchor provider");
    const { createOpenTimestampsProvider, esploraBlockSource } = await import("./anchor-providers/opentimestamps.mjs");
    providers.push(createOpenTimestampsProvider({
      fetch: globalThis.fetch,
      blockSources: ["https://blockstream.info/api", "https://mempool.space/api"].map((base) => esploraBlockSource(base, globalThis.fetch)),
      finalityDepth: Number(env.ANCHOR_FINALITY_DEPTH ?? 6),
    }));
  }
  return providers;
}

export async function runPlatform({ extensions = [], env = process.env, assetDirectory } = {}) {
  let pool;
  try {
    const origin = required(env, "PUBLIC_ORIGIN");
    const product = env.QUILL_PRODUCT ?? "civic";
    pool = databasePool(required(env, "DATABASE_URL"), { max: Number(env.DATABASE_POOL_MAX ?? 4) });
    await verifyIdentityRuntime(pool);
    for (const extension of extensions) await verifyExtensionMigrations(pool, extension);
    const transaction = pgTransactions(pool);
    const passkeys = configuredPasskeys(env.PASSKEY_ATTESTATION_POLICY);
    const identity = createIdentityStore({
      transaction, origin,
      sessionKey: hexKey(env, "SESSION_KEY"), stateKey: hexKey(env, "OIDC_STATE_KEY"),
      ...passkeys,
    });
    const configuration = await discoverIdentityProvider({
      issuer: required(env, "OIDC_ISSUER"), clientId: required(env, "OIDC_CLIENT_ID"), clientSecret: required(env, "OIDC_CLIENT_SECRET"),
    });
    const login = createOIDCLogin({ store: identity, configuration, redirectUri: origin + "/auth/callback" });
    const release = (env.QUILL_RELEASE ?? env.RENDER_GIT_COMMIT ?? "").slice(0, 64) || null;
    const { services, application, bodyLimit, workers } = createPlatform({
      identity, transaction, login, origin, product, extensions, release, assetDirectory,
      verifyPasskeyAuthentication: passkeys.verifyPasskeyAuthentication,
      notificationTokenKey: env.NOTIFICATION_TOKEN_KEY ? hexKey(env, "NOTIFICATION_TOKEN_KEY") : null,
      email: postmarkFromEnvironment(env),
      paymentProviders: [stripeProviderFromEnvironment(env), manualProviderFromEnvironment(env)],
      logId: env.LOG_ID ?? new URL(origin).hostname,
      logSigningKey: env.LOG_SIGNING_KEY ? loadLogSigningKey(env.LOG_SIGNING_KEY) : null,
      anchorProviders: await anchorProvidersFrom(env),
      readiness: async () => {
        const result = await pool.query("SELECT 1 AS ready");
        if (result.rows[0]?.ready !== 1) throw Error("Not ready");
      },
    });
    const mode = env.TRANSPORT_MODE ?? "tls";
    let server;
    if (mode === "edge-tls") server = createEdgeServer({ application, origin, bodyLimit });
    else if (mode === "tls") {
      const [key, cert] = await Promise.all([readFile(required(env, "TLS_KEY_FILE")), readFile(required(env, "TLS_CERT_FILE"))]);
      server = createEngineServer({ application, origin, key, cert, bodyLimit });
    } else throw Error("Invalid transport mode");
    const collaboration = attachPublicCollaborationHub({ server, origin, documents: services.documents });
    const background = env.WORKERS === "off" ? null : startWorkers(workers, {
      onError: (name) => console.error("Background worker pass failed: " + name + ". No content was logged."),
    });
    const port = Number(env.PORT ?? 8443);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error("Invalid port");
    server.listen(port, env.BIND_ADDRESS ?? "127.0.0.1", () =>
      console.log("Quill governance service listening (" + product + ", " + mode + "); configuration and credentials are not logged."));
    const stop = () => {
      background?.stop();
      collaboration.close();
      server.close(() => pool.end().finally(() => process.exit()));
      server.closeIdleConnections();
      setTimeout(() => process.exit(1), 10000).unref();
    };
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
    return { server, services, stop };
  } catch {
    await pool?.end().catch(() => {});
    console.error("Account service startup failed. Check configured origin, identity provider, migrations, runtime permissions, TLS and secret references. No credential details were logged.");
    process.exit(1);
  }
}
