import { HttpError } from "./account-http.mjs";
import { DocumentError } from "./document-store.mjs";

const PARAMETERS = ["q", "mode", "workspace", "product", "kind", "cursor", "limit"];
/** Search routes are GET-only and read no body, so they keep the default budget. */
export const searchBodyLimit = () => 8192;

function searchParameters(url) {
  for (const key of url.searchParams.keys())
    if (!PARAMETERS.includes(key) || url.searchParams.getAll(key).length !== 1) throw new HttpError(400, "INVALID_QUERY");
  const get = (key) => url.searchParams.get(key);
  return {
    query: get("q") ?? "",
    mode: get("mode"),
    workspace: get("workspace"),
    product: get("product"),
    kind: get("kind") ?? "all",
    cursor: get("cursor"),
    limit: url.searchParams.has("limit") ? Number(get("limit")) : 20,
  };
}

/** GET /api/public/search (anyone) and GET /api/search (own workspaces). */
export function createSearchRoutes({ search }) {
  return async ({ url, credentials, method }) => {
    const scope = url.pathname === "/api/public/search" ? "public" : url.pathname === "/api/search" ? "member" : null;
    if (!scope) return null;
    method(["GET"]);
    try {
      const parameters = searchParameters(url);
      return scope === "public" ? await search.publicSearch(parameters) : await search.memberSearch(credentials, parameters);
    } catch (cause) {
      if (cause instanceof DocumentError) throw new HttpError(cause.status, cause.code);
      throw cause;
    }
  };
}
