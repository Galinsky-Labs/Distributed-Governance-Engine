// DCE-034: edge-cacheable reads of exact public editions. A request that names
// a version (/api/public/documents/:id?version=N) addresses an append-only,
// digest-bound edition, so the response may be cached by browsers and CDNs
// for a year and revalidated by digest. Unversioned "current" reads, history
// and lists keep the default no-store policy because they change.
import { HttpError } from "./account-http.mjs";
import { DocumentError } from "./document-store.mjs";

const route = /^\/api\/public\/documents\/([a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12})$/;
export const IMMUTABLE_EDITION_CACHE = "public, max-age=31536000, immutable";
export const editionCacheBodyLimit = () => 0;

/** Platform extension; extension routes are matched before the document routes. */
export const createImmutableEditionExtension = () => Object.freeze({
  id: "edition-cache",
  createRoutes: (services) => [{ routes: createImmutableEditionRoutes({ documents: services.documents }), bodyLimit: editionCacheBodyLimit }],
});

/** Mount before the document routes; anything it does not handle falls through unchanged. */
export function createImmutableEditionRoutes({ documents }) {
  return async ({ request, url }) => {
    const match = url.pathname.match(route);
    if (!match || request.method !== "GET" || [...url.searchParams.keys()].join() !== "version") return null;
    const raw = url.searchParams.get("version");
    if (!/^[1-9][0-9]{0,6}$/.test(raw)) return null; // The document route reports the validation error.
    let edition;
    try { edition = await documents.publicRead(match[1], { version: Number(raw) }); }
    catch (cause) {
      if (cause instanceof DocumentError) throw new HttpError(cause.status, cause.code);
      throw cause;
    }
    const etag = `"${edition.digest}"`;
    const headers = { "cache-control": IMMUTABLE_EDITION_CACHE, etag, vary: "accept-encoding" };
    if (request.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
    return new Response(JSON.stringify(edition), { status: 200, headers: { ...headers, "content-type": "application/json" } });
  };
}
