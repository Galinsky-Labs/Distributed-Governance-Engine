import { boundedJson, HttpError } from "./account-http.mjs";
import { DocumentError } from "./document-store.mjs";

const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const ROUTE = /^\/api\/(?:public\/)?notifications(?:\/|$)/;
export const NOTIFICATION_BODY_LIMIT = 8192;
export const notificationBodyLimit = (path) => (ROUTE.test(path) ? NOTIFICATION_BODY_LIMIT : 8192);

const query = (url, allowed) => {
  for (const key of url.searchParams.keys())
    if (!allowed.includes(key) || url.searchParams.getAll(key).length !== 1) throw new HttpError(400, "INVALID_QUERY");
};
const integer = (url, key, fallback) => (url.searchParams.has(key) ? Number(url.searchParams.get(key)) : fallback);
const created = (value) => Response.json(value, { status: 201 });

/**
 * Account routes under /api/notifications and token routes under
 * /api/public/notifications. Token routes need no session but do require a
 * same-origin request, like the recovery-session route.
 */
export function createNotificationRoutes({ notifications, origin }) {
  if (typeof origin !== "string" || !origin.startsWith("https://")) throw Error("Canonical HTTPS origin required");
  return async ({ request, url, credentials, write, method }) => {
    if (!ROUTE.test(url.pathname)) return null;
    try {
      const path = url.pathname;
      if (path === "/api/public/notifications/unsubscribe") {
        // POST only, so tokens never appear in URLs or request logs.
        method(["POST"]);
        if (credentials.origin !== origin) throw new HttpError(403, "REQUEST_PROTECTION_REQUIRED");
        const body = await boundedJson(request, ["token", "preview"], ["token"]);
        if (body.preview !== undefined && typeof body.preview !== "boolean") throw new HttpError(400, "INVALID_FIELDS");
        return body.preview ? notifications.describeUnsubscribe(body) : await notifications.applyUnsubscribe(body);
      }
      if (path === "/api/public/notifications/email-verification") {
        method(["POST"]);
        if (credentials.origin !== origin) throw new HttpError(403, "REQUEST_PROTECTION_REQUIRED");
        return await notifications.verifyEmail(await boundedJson(request, ["token"]));
      }
      if (path === "/api/notifications/subscriptions") {
        method(["GET", "POST"]);
        if (request.method === "GET") {
          query(url, ["after", "limit"]);
          return await notifications.subscriptions(credentials, { after: url.searchParams.get("after"), limit: integer(url, "limit", 50) });
        }
        write();
        return created(await notifications.subscribe(credentials, await boundedJson(request, ["targetKind", "targetId"])));
      }
      const subscription = path.match(/^\/api\/notifications\/subscriptions\/([a-f0-9-]{36})$/);
      if (subscription && UUID.test(subscription[1])) {
        method(["DELETE"]);
        write();
        await boundedJson(request, []);
        return await notifications.unsubscribe(credentials, subscription[1]);
      }
      if (path === "/api/notifications/preferences") {
        method(["GET", "PUT"]);
        if (request.method === "GET") {
          query(url, []);
          return await notifications.preferences(credentials);
        }
        write();
        return await notifications.updatePreferences(credentials, await boundedJson(request, ["inApp", "email", "locale"]));
      }
      if (path === "/api/notifications/email") {
        method(["PUT", "DELETE"]);
        write();
        if (request.method === "DELETE") {
          await boundedJson(request, []);
          return await notifications.removeEmailAddress(credentials);
        }
        return await notifications.setEmailAddress(credentials, await boundedJson(request, ["address"]));
      }
      if (path === "/api/notifications/inbox") {
        method(["GET"]);
        query(url, ["before", "limit"]);
        return await notifications.inbox(credentials, { before: url.searchParams.get("before"), limit: integer(url, "limit", 30) });
      }
      if (path === "/api/notifications/inbox/read") {
        method(["POST"]);
        write();
        return await notifications.markInbox(credentials, await boundedJson(request, ["ids", "read"]));
      }
      if (path === "/api/notifications/inbox/read-all") {
        method(["POST"]);
        write();
        await boundedJson(request, []);
        return await notifications.markAllRead(credentials);
      }
      throw new HttpError(404, "NOT_FOUND");
    } catch (cause) {
      if (cause instanceof DocumentError) throw new HttpError(cause.status, cause.code);
      throw cause;
    }
  };
}
