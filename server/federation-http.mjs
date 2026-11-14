// DCE-037 federation routes. Peer-to-peer traffic (/api/federation/inbox) is
// authenticated only by Ed25519-signed requests from operator-pinned peers,
// never by session cookies. Ballot envelopes and key rotations are
// self-authenticating signed objects. Workspace actions use the normal
// session + CSRF protections.
import { boundedJson, HttpError } from "./account-http.mjs";
import { DocumentError } from "./document-store.mjs";
import { createFederationStore } from "./federation-store.mjs";

const UUID = "[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}";
const documentRoute = new RegExp(`^/api/workspaces/(${UUID})/documents/(${UUID})/federation$`);
const decisionRoute = new RegExp(`^/api/workspaces/(${UUID})/documents/(${UUID})/proposals/(${UUID})/decision/(federation|federation/keys|close)$`);
const PEER_BODY_LIMIT = 4 * 1024 * 1024;
export const federationBodyLimit = (path) =>
  path === "/api/federation/inbox" ? PEER_BODY_LIMIT : path.startsWith("/api/federation/") ? 65536 : 8192;

async function rawBody(request, limit) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") ?? "")) throw new HttpError(415, "JSON_REQUIRED");
  if (Number(request.headers.get("content-length") ?? 0) > limit) throw new HttpError(413, "BODY_TOO_LARGE");
  const chunks = [];
  let size = 0;
  const reader = request.body?.getReader();
  if (reader) {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limit) { await reader.cancel(); throw new HttpError(413, "BODY_TOO_LARGE"); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
  }
  return new Uint8Array(Buffer.concat(chunks));
}
const parse = (bytes) => {
  try {
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw Error();
    return value;
  } catch { throw new HttpError(400, "INVALID_JSON"); }
};
const noQuery = (url) => { if (url.search) throw new HttpError(400, "INVALID_QUERY"); };

export function createFederationRoutes({ federation, isPlatformAdmin = async () => false }) {
  return async ({ request, url, credentials, write, method }) => {
    const path = url.pathname;
    const claim = path.match(documentRoute), scoped = path.match(decisionRoute);
    if (!path.startsWith("/api/federation/") && !claim && !scoped) return null;
    try {
      if (claim) {
        method(["POST"]); write(); noQuery(url);
        return await federation.claimAuthority(credentials, claim[1], claim[2], await boundedJson(request, ["replicas"], []));
      }
      if (scoped) {
        const [, tenantId, documentId, proposalId, operation] = scoped;
        if (operation === "close") {
          // Runs before the decision routes; falls through unless the disclosed cutoff is still ahead.
          if (request.method === "POST" && await federation.cutoffPending(tenantId, documentId, proposalId))
            throw new HttpError(409, "FEDERATED_CUTOFF_PENDING");
          return null;
        }
        method(["POST"]); write(); noQuery(url);
        if (operation === "federation")
          return await federation.federateDecision(credentials, tenantId, documentId, proposalId, await boundedJson(request, ["delayClass"]));
        return await federation.bindVoterKey(credentials, tenantId, documentId, proposalId, await boundedJson(request, ["publicKey"]));
      }
      if (path === "/api/federation/instance") { method(["GET"]); noQuery(url); return federation.instance(); }
      if (path === "/api/federation/inbox") {
        method(["POST"]); noQuery(url);
        const bytes = await rawBody(request, PEER_BODY_LIMIT);
        const sender = await federation.authenticatePeer({ method: "POST", path, headers: request.headers, body: bytes });
        const body = parse(bytes);
        if (Object.keys(body).join() !== "messages") throw new HttpError(400, "INVALID_FIELDS");
        return await federation.receive(sender, body.messages);
      }
      if (path === "/api/federation/ballots") {
        method(["POST"]); noQuery(url);
        return await federation.submitEnvelope(parse(await rawBody(request, 65536)));
      }
      if (path === "/api/federation/rotations") {
        method(["POST"]); noQuery(url);
        return await federation.applyRotation(parse(await rawBody(request, 65536)));
      }
      if (path === "/api/federation/evidence") {
        method(["GET"]);
        for (const key of url.searchParams.keys()) if (key !== "limit") throw new HttpError(400, "INVALID_QUERY");
        const limit = url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : 50;
        return await federation.evidence({ limit });
      }
      if (path === "/api/federation/peers") {
        method(["POST"]); write(); noQuery(url);
        if (!(await isPlatformAdmin(credentials))) throw new HttpError(403, "ACCESS_DENIED");
        return await federation.registerPeer(await boundedJson(request, ["instanceId", "origin", "publicKey", "maxDelayMs"], ["instanceId", "origin", "publicKey"]));
      }
      const peerStatus = path.match(/^\/api\/federation\/peers\/([a-z0-9][a-z0-9.-]{2,80})\/status$/);
      if (peerStatus) {
        method(["POST"]); write(); noQuery(url);
        if (!(await isPlatformAdmin(credentials))) throw new HttpError(403, "ACCESS_DENIED");
        return await federation.setPeerStatus(peerStatus[1], (await boundedJson(request, ["status"])).status);
      }
      const item = path.match(new RegExp(`^/api/federation/(decisions|documents)/(${UUID})$`));
      if (item) {
        method(["GET"]); noQuery(url);
        return await (item[1] === "decisions" ? federation.descriptor(item[2]) : federation.document(item[2]));
      }
      const receipt = path.match(/^\/api\/federation\/receipts\/([a-f0-9]{64})$/);
      if (receipt) { method(["GET"]); noQuery(url); return await federation.receipt(receipt[1]); }
      throw new HttpError(404, "NOT_FOUND");
    } catch (cause) {
      if (cause instanceof DocumentError) throw new HttpError(cause.status, cause.code);
      throw cause;
    }
  };
}

/**
 * Platform extension (see docs/INTEGRATION-federation.md). The instance
 * identity is the ledger's log id and key, so createPlatform must be given
 * logId and logSigningKey; `signingKey` here is that same loaded key.
 */
export function createFederationExtension({ origin, signingKey, fetch, intervalMs = 10_000, maxMergeDelayMs }) {
  let store = null;
  const get = (services) => {
    if (!services.ledger) throw Error("Federation requires the transparency ledger (logId and logSigningKey)");
    return (store ??= createFederationStore({
      transaction: services.transaction, identity: services.identity, clock: services.clock,
      instanceId: services.ledger.logId, origin, signingKey, ...(fetch ? { fetch } : {}), ...(maxMergeDelayMs ? { maxMergeDelayMs } : {}),
    }));
  };
  return Object.freeze({
    id: "federation",
    createRoutes: (services) => [{
      routes: createFederationRoutes({ federation: get(services), isPlatformAdmin: (c) => services.isPlatformAdmin?.(c) ?? false }),
      bodyLimit: federationBodyLimit,
    }],
    createWorkers: (services) => [{ name: "federation", intervalMs, tick: () => get(services).tick() }],
  });
}
