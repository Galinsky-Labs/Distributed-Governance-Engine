import { boundedJson, HttpError } from "./account-http.mjs";
import { DocumentError } from "./document-store.mjs";

const workspaceRoute = /^\/api\/workspaces\/([a-f0-9-]{36})\/documents\/([a-f0-9-]{36})\/editions$/;
const publicRoute = /^\/api\/public\/editions(?:\/([a-f0-9-]{36}))?$/;
export const editionBodyLimit = () => 8192;
const query = (url, allowed) => {
  for (const key of url.searchParams.keys())
    if (!allowed.includes(key) || url.searchParams.getAll(key).length !== 1) throw new HttpError(400, "INVALID_QUERY");
};
const integer = (url, key, fallback) => {
  if (!url.searchParams.has(key)) return fallback;
  const value = url.searchParams.get(key);
  if (!/^(0|[1-9][0-9]{0,9})$/.test(value)) throw new HttpError(400, "INVALID_PAGE");
  return Number(value);
};

/** Final edition routes, mounted inside the common account handler boundary. */
export function createEditionRoutes({ editions }) {
  return async ({ request, url, credentials, write, method }) => {
    try {
      const open = url.pathname.match(publicRoute);
      if (open) {
        method(["GET"]);
        if (open[1]) {
          query(url, []);
          return await editions.publicRead(open[1]);
        }
        query(url, ["documentId", "after", "limit"]);
        return await editions.publicList(url.searchParams.get("documentId"), {
          after: integer(url, "after", null), limit: integer(url, "limit", 50),
        });
      }
      const match = url.pathname.match(workspaceRoute);
      if (!match) return null;
      const [, tenantId, documentId] = match;
      method(["GET", "POST"]);
      if (request.method === "GET") {
        query(url, ["after", "limit"]);
        return await editions.list(credentials, tenantId, documentId, {
          after: integer(url, "after", null), limit: integer(url, "limit", 50),
        });
      }
      write();
      const body = await boundedJson(request,
        ["commandId", "kind", "sourceVersion", "sourceDigest", "decisionId", "certificateDigest", "artifact"],
        ["commandId", "kind", "sourceVersion", "sourceDigest"]);
      return await editions.freeze(credentials, tenantId, documentId, body);
    } catch (cause) {
      if (cause instanceof DocumentError) throw new HttpError(cause.status, cause.code);
      throw cause;
    }
  };
}
