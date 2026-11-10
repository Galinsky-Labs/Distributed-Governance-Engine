import { boundedJson, HttpError } from "./account-http.mjs";
import { DocumentError } from "./document-store.mjs";
import { LEGAL_LIMITS } from "../src/legal-structure.mjs";

export const DOCUMENT_BODY_LIMIT = LEGAL_LIMITS.bytes + 16384;
const route =
  /^\/api\/workspaces\/([a-f0-9-]{36})\/documents(?:\/([a-f0-9-]{36})(?:\/(freeze-input|restore))?)?$/;
export const documentBodyLimit = (path) =>
  route.test(path) ? DOCUMENT_BODY_LIMIT : 8192;
const query = (url, allowed) => {
  for (const key of url.searchParams.keys())
    if (!allowed.includes(key) || url.searchParams.getAll(key).length !== 1)
      throw new HttpError(400, "INVALID_QUERY");
};
const integer = (url, key, fallback) =>
  url.searchParams.has(key) ? Number(url.searchParams.get(key)) : fallback;
/** Runs inside the common account handler: same cookie/origin/header/budget boundary. */
export function createDocumentRoutes({ documents }) {
  return async ({ request, url, credentials, write, method }) => {
    try {
      if(url.pathname==="/api/public/documents"){
        method(["GET"]);
        query(url,["after","limit"]);
        return await documents.publicDirectory({
          after:url.searchParams.get("after"),
          limit:integer(url,"limit",30)
        });
      }
      const publicRoute = url.pathname.match(
        /^\/api\/public\/documents\/([a-f0-9-]{36})(?:\/(history))?$/,
      );
      if (publicRoute) {
        method(["GET"]);
        if (publicRoute[2]) {
          query(url, ["before", "limit"]);
          return await documents.history(publicRoute[1], {
            before: integer(url, "before", null),
            limit: integer(url, "limit", 50),
          });
        }
        query(url, ["version"]);
        return await documents.publicRead(publicRoute[1], {
          version: integer(url, "version", null),
        });
      }
      const match = url.pathname.match(route);
      if (!match) return null;
      const [, tenantId, documentId, action] = match;
      if (action) {
        method(["POST"]);
        query(url,[]);
        write();
        if(action==='restore'){
          const body=await boundedJson(request,['commandId','expectedVersion','sourceVersion','sourceDigest','disclosure']);
          return await documents.restore(credentials,tenantId,documentId,body);
        }
        const body = await boundedJson(request, [
          "commandId",
          "expectedVersion",
        ]);
        return await documents.freezeForInput(
          credentials,
          tenantId,
          documentId,
          body,
        );
      }
      if (documentId) {
        method(["GET", "PUT"]);
        if (request.method === "GET") {
          query(url, []);
          return await documents.read(credentials, tenantId, documentId);
        }
        write();
        const body = await boundedJson(
          request,
          ["document", "commandId", "expectedVersion"],
          undefined,
          DOCUMENT_BODY_LIMIT,
        );
        return await documents.save(credentials, tenantId, documentId, body);
      }
      method(["GET", "POST"]);
      if (request.method === "GET") {
        query(url, ["after", "limit"]);
        return await documents.list(credentials, tenantId, {
          after: url.searchParams.get("after"),
          limit: integer(url, "limit", 50),
        });
      }
      write();
      const body = await boundedJson(
        request,
        ["document", "commandId", "disclosure"],
        undefined,
        DOCUMENT_BODY_LIMIT,
      );
      return await documents.create(credentials, tenantId, body);
    } catch (cause) {
      if (cause instanceof DocumentError)
        throw new HttpError(cause.status, cause.code);
      throw cause;
    }
  };
}
