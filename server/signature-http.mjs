import { boundedJson, HttpError } from "./account-http.mjs";
import { DocumentError } from "./document-store.mjs";

const ID = "([a-f0-9-]{36})";
const workspaceRoute = new RegExp(`^/api/workspaces/${ID}/editions/${ID}/(signatories|intents|signatures|manifests)(?:/(mine|[a-f0-9-]{36}))?(?:/(decline|withdraw|dispute|receipt))?$`);
const publicRoute = new RegExp(`^/api/public/editions/${ID}/(directory|manifests|receipts)(?:/([a-z]+|[a-f0-9]{64}))?(?:/([1-9][0-9]{0,9}))?(?:/(entries\\.json|entries\\.csv))?$`);
/** Signing bodies carry bounded ink strokes and a WebAuthn assertion. */
export const SIGNATURE_BODY_LIMIT = 98304;
export const signatureBodyLimit = (path) =>
  /^\/api\/workspaces\/[a-f0-9-]{36}\/editions\/[a-f0-9-]{36}\/signatures$/.test(path) ? SIGNATURE_BODY_LIMIT : 8192;
const query = (url, allowed) => {
  for (const key of url.searchParams.keys())
    if (!allowed.includes(key) || url.searchParams.getAll(key).length !== 1) throw new HttpError(400, "INVALID_QUERY");
};
const integer = (url, key, fallback) => {
  if (!url.searchParams.has(key)) return fallback;
  const value = url.searchParams.get(key);
  if (!/^(0|[1-9][0-9]{0,15})$/.test(value)) throw new HttpError(400, "INVALID_PAGE");
  return Number(value);
};
const text = (url, key) => url.searchParams.has(key) ? url.searchParams.get(key) : null;

/** Streams an export generator; the first chunk is read before headers so lookups can still 404. */
function download(iterator, first, { editionId, kind, version, format }) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) { controller.enqueue(encoder.encode(first)); },
    async pull(controller) {
      try {
        const { value, done } = await iterator.next();
        if (done) controller.close();
        else controller.enqueue(encoder.encode(value));
      } catch { controller.error(new Error("Manifest export interrupted")); }
    },
    cancel() { return iterator.return(); },
  });
  return new Response(stream, { status: 200, headers: {
    "content-type": format === "csv" ? "text/csv; charset=utf-8" : "application/json; charset=utf-8",
    "content-disposition": `attachment; filename="signature-manifest-${editionId}-${kind}-v${version}.${format}"`,
  } });
}

/** Signing, signer directory and manifest routes inside the account handler boundary. */
export function createSignatureRoutes({ signatures }) {
  return async ({ request, url, credentials, write, method }) => {
    try {
      const open = url.pathname.match(publicRoute);
      if (open) {
        method(["GET"]);
        const [, editionId, area, segment, version, file] = open;
        if (area === "directory" && !segment && !version && !file) {
          query(url, ["kind", "q", "after", "limit"]);
          return await signatures.directory(editionId, {
            kind: text(url, "kind"), q: text(url, "q"), after: text(url, "after"), limit: integer(url, "limit", 50),
          });
        }
        if (area === "receipts" && segment && !version && !file) {
          query(url, []);
          return await signatures.publicReceipt(editionId, segment);
        }
        if (area === "manifests" && !segment && !version && !file) {
          query(url, ["kind", "before", "limit"]);
          return await signatures.manifests(editionId, {
            kind: text(url, "kind"), before: integer(url, "before", null), limit: integer(url, "limit", 50),
          });
        }
        if (area === "manifests" && segment && version) {
          query(url, []);
          if (!file) return await signatures.manifest(editionId, segment, Number(version));
          const format = file.endsWith(".csv") ? "csv" : "json";
          const iterator = signatures.exportManifest(editionId, segment, Number(version), format);
          const first = await iterator.next();
          return download(iterator, first.value, { editionId, kind: segment, version, format });
        }
        throw new HttpError(404, "NOT_FOUND");
      }
      const match = url.pathname.match(workspaceRoute);
      if (!match) return null;
      const [, tenantId, editionId, area, sub, action] = match;
      const post = async (allowed, required = allowed, limit = 8192) => {
        method(["POST"]);
        query(url, []);
        write();
        return boundedJson(request, allowed, required, limit);
      };
      if (area === "signatories" && !sub && !action) {
        method(["GET", "POST"]);
        if (request.method === "GET") {
          query(url, []);
          return await signatures.signatories(credentials, tenantId, editionId);
        }
        return await signatures.configureSignatories(credentials, tenantId, editionId, await post(["signatories"]));
      }
      if (area === "intents" && !sub && !action)
        return await signatures.createIntent(credentials, tenantId, editionId, await post(["kind", "capacity"], ["kind"]));
      if (area === "intents" && sub && sub !== "mine" && action === "decline") {
        await post([]);
        return await signatures.declineIntent(credentials, tenantId, editionId, sub);
      }
      if (area === "manifests" && !sub && !action)
        return await signatures.freezeManifest(credentials, tenantId, editionId, await post(["kind"]));
      if (area === "signatures" && !sub && !action) {
        method(["GET", "POST"]);
        if (request.method === "GET") {
          query(url, ["kind", "after", "limit"]);
          return await signatures.list(credentials, tenantId, editionId, {
            kind: text(url, "kind"), after: integer(url, "after", null), limit: integer(url, "limit", 100),
          });
        }
        return await signatures.sign(credentials, tenantId, editionId, await post(
          ["intentId", "signingDigest", "consent", "mark", "display", "passkey"],
          ["intentId", "signingDigest", "consent", "mark", "display"], SIGNATURE_BODY_LIMIT));
      }
      if (area === "signatures" && sub === "mine" && !action) {
        method(["GET"]);
        query(url, []);
        return await signatures.mine(credentials, tenantId, editionId);
      }
      if (area === "signatures" && sub && sub !== "mine") {
        if (action === "receipt") {
          method(["GET"]);
          query(url, []);
          return await signatures.receipt(credentials, tenantId, editionId, sub);
        }
        if (action === "withdraw") {
          await post([]);
          return await signatures.withdraw(credentials, tenantId, editionId, sub);
        }
        if (action === "dispute") return await signatures.dispute(credentials, tenantId, editionId, sub, await post(["reason"]));
      }
      throw new HttpError(404, "NOT_FOUND");
    } catch (cause) {
      if (cause instanceof DocumentError) throw new HttpError(cause.status, cause.code);
      throw cause;
    }
  };
}
