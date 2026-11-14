import { boundedJson, HttpError } from "./account-http.mjs";
import { DocumentError } from "./document-store.mjs";

const query = (url, allowed) => {
  for (const key of url.searchParams.keys())
    if (!allowed.includes(key) || url.searchParams.getAll(key).length !== 1)
      throw new HttpError(400, "INVALID_QUERY");
};
const integer = (url, key, fallback = null) => {
  if (!url.searchParams.has(key)) return fallback;
  const raw = url.searchParams.get(key);
  if (!/^(0|[1-9][0-9]{0,14})$/.test(raw)) throw new HttpError(400, "INVALID_QUERY");
  return Number(raw);
};
export const ledgerBodyLimit = (path) => (path.startsWith("/api/public/ledger/") ? 4096 : 8192);

/** Public, unauthenticated transparency endpoints; they expose digests only. */
export function createLedgerRoutes({ ledger, isPlatformAdmin = async () => false }) {
  return async ({ request, url, credentials, write, method }) => {
    const path = url.pathname;
    if (!path.startsWith("/api/public/ledger") && !path.startsWith("/api/ledger/")) return null;
    try {
      if (path === "/api/public/ledger/checkpoint") {
        method(["GET"]); query(url, ["size"]);
        return await (url.searchParams.has("size") ? ledger.checkpoint(integer(url, "size")) : ledger.latestCheckpoint());
      }
      if (path === "/api/public/ledger/checkpoints") {
        method(["GET"]); query(url, ["before", "limit"]);
        return await ledger.checkpoints({ before: integer(url, "before"), limit: integer(url, "limit", 50) });
      }
      if (path === "/api/public/ledger/consistency") {
        method(["GET"]); query(url, ["first", "second"]);
        return await ledger.consistency(integer(url, "first"), integer(url, "second"));
      }
      if (path === "/api/public/ledger/proof") {
        method(["GET"]); query(url, ["digest", "kind", "size"]);
        return await ledger.proof({ eventDigest: url.searchParams.get("digest"), kind: url.searchParams.get("kind"), size: integer(url, "size") });
      }
      const subject = path.match(/^\/api\/public\/ledger\/subjects\/([a-f0-9-]{36})\/entries$/);
      if (subject) {
        method(["GET"]); query(url, ["after", "limit"]);
        return await ledger.entries({ subjectId: subject[1], after: integer(url, "after"), limit: integer(url, "limit", 100) });
      }
      if (path === "/api/public/ledger/anchors") {
        method(["GET"]); query(url, ["limit"]);
        return await ledger.anchors({ limit: integer(url, "limit", 50) });
      }
      if (path === "/api/public/ledger/cosignatures") {
        // Witnesses authenticate with their registered Ed25519 key, not a session.
        method(["POST"]);
        const body = await boundedJson(request, ["size", "keyId", "signature"]);
        return await ledger.cosign(body);
      }
      if (path === "/api/ledger/witnesses") {
        method(["POST"]); write();
        if (!(await isPlatformAdmin(credentials))) throw new HttpError(403, "ACCESS_DENIED");
        return await ledger.registerWitness(await boundedJson(request, ["name", "publicKey"]));
      }
      throw new HttpError(404, "NOT_FOUND");
    } catch (cause) {
      if (cause instanceof DocumentError) throw new HttpError(cause.status, cause.code);
      throw cause;
    }
  };
}
