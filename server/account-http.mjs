import { AccessError, sessionCookie } from "./identity-store.mjs";

export class HttpError extends Error {
  constructor(status, code, headers = {}) {
    super(code);
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}
const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const token = /^[A-Za-z0-9_-]{43}$/;
const headers = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "content-security-policy":
    "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  "cross-origin-resource-policy": "same-origin",
};
const json = (value, status = 200, extra = {}) =>
  Response.json(value, { status, headers: { ...headers, ...extra } });
const error = (status, code, headers = {}) =>
  json({ error: code }, status, headers);
export function requestCookies(header = "") {
  if (header.length > 8192) throw new HttpError(400, "INVALID_COOKIES");
  const result = new Map();
  for (const part of header.split(";")) {
    const at = part.indexOf("=");
    if (at < 0) continue;
    const name = part.slice(0, at).trim(),
      value = part.slice(at + 1).trim();
    if (!["__Host-dge_session", "__Host-dge_login"].includes(name)) continue;
    if (result.has(name) || !token.test(value))
      throw new HttpError(400, "INVALID_COOKIES");
    result.set(name, value);
  }
  return result;
}
function rejectDuplicateJsonKeys(text) {
  let i = 0;
  const space = () => { while (/\s/.test(text[i] ?? "" ) && i < text.length) i++; };
  const quoted = () => {
    const start = i++;
    while (i < text.length) {
      if (text[i] === "\\") { i += 2; continue; }
      if (text[i++] === '"') return JSON.parse(text.slice(start, i));
    }
    throw Error("Unterminated JSON string");
  };
  const value = (depth = 0) => {
    if (depth > 64) throw Error("JSON nesting limit exceeded");
    space();
    if (text[i] === "{") {
      i++; space();
      const keys = new Set();
      while (i < text.length && text[i] !== "}") {
        if (text[i] !== '"') throw Error("Invalid JSON key");
        const key = quoted();
        if (keys.has(key)) throw Error("Duplicate JSON key");
        keys.add(key); space();
        if (text[i++] !== ":") throw Error("Invalid JSON member");
        value(depth + 1); space();
        if (text[i] === ",") { i++; space(); }
        else if (text[i] !== "}") throw Error("Invalid JSON object");
      }
      if (text[i++] !== "}") throw Error("Invalid JSON object");
    } else if (text[i] === "[") {
      i++; space();
      while (i < text.length && text[i] !== "]") {
        value(depth + 1); space();
        if (text[i] === ",") { i++; space(); }
        else if (text[i] !== "]") throw Error("Invalid JSON array");
      }
      if (text[i++] !== "]") throw Error("Invalid JSON array");
    } else if (text[i] === '"') quoted();
    else {
      const start = i;
      while (i < text.length && !/[\s,}\]]/.test(text[i])) i++;
      if (i === start) throw Error("Invalid JSON value");
    }
  };
  value();
}
export async function boundedJson(
  request,
  allowed,
  required = allowed,
  maxBytes = 8192,
) {
  if (
    !/^application\/json(?:\s*;|$)/i.test(
      request.headers.get("content-type") ?? "",
    )
  )
    throw new HttpError(415, "JSON_REQUIRED");
  if (Number(request.headers.get("content-length") ?? 0) > maxBytes)
    throw new HttpError(413, "BODY_TOO_LARGE");
  const reader = request.body?.getReader();
  let size = 0;
  const chunks = [];
  if (reader)
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) {
          await reader.cancel();
          throw new HttpError(413, "BODY_TOO_LARGE");
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
  let body;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
    rejectDuplicateJsonKeys(text);
    body = JSON.parse(
      text,
      (key, value) => {
        if (
          key.includes("\0") ||
          (typeof value === "string" && value.includes("\0"))
        )
          throw Error("Unsupported JSON character");
        return value;
      },
    );
  } catch {
    throw new HttpError(400, "INVALID_JSON");
  }
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).some((k) => !allowed.includes(k)) ||
    required.some((k) => !Object.hasOwn(body, k))
  )
    throw new HttpError(400, "INVALID_FIELDS");
  return body;
}

/** A bounded, per-process availability control; never a proof of unique human identity. */
export function createRequestBudget({
  clock = Date.now,
  windowMs = 60000,
  maxKeys = 4096,
  perPeer = 120,
  globalLimit = 2000,
} = {}) {
  const buckets = new Map();
  let global = { at: 0, count: 0 };
  return (peer) => {
    if (typeof peer !== "string" || peer.length > 128)
      throw new HttpError(503, "PEER_CONTEXT_REQUIRED");
    const now = clock();
    if (now - global.at >= windowMs) global = { at: now, count: 0 };
    if (++global.count > globalLimit) return false;
    for (const [key, bucket] of buckets)
      if (now - bucket.at >= windowMs) buckets.delete(key);
    if (!buckets.has(peer)) {
      if (buckets.size >= maxKeys) return false;
      buckets.set(peer, { at: now, count: 0 });
    }
    return ++buckets.get(peer).count <= perPeer;
  };
}
function page(url) {
  for (const key of url.searchParams.keys())
    if (
      !["after", "limit"].includes(key) ||
      url.searchParams.getAll(key).length !== 1
    )
      throw new HttpError(400, "INVALID_QUERY");
  const limit = Number(url.searchParams.get("limit") ?? 100),
    after = url.searchParams.get("after");
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 200 ||
    (after !== null && !uuid.test(after))
  )
    throw new HttpError(400, "INVALID_PAGE");
  return { after, limit };
}
export const clearIdentityCookies = () => [
  "__Host-dge_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0",
  "__Host-dge_csrf=; Path=/; Secure; SameSite=Strict; Max-Age=0",
  "__Host-dge_login=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0",
];

export function createAccountHandler({
  store,
  login,
  origin,
  budget = createRequestBudget(),
  extensions = [],
}) {
  if (new URL(origin).origin !== origin || !origin.startsWith("https://"))
    throw Error("Canonical HTTPS origin required");
  function cookiesResponse(response, values) {
    for (const value of values) response.headers.append("set-cookie", value);
    return response;
  }
  return async (request, { peerAddress } = {}) => {
    let url;
    try {
      url = new URL(request.url);
      if (url.origin !== origin) throw new HttpError(400, "ORIGIN_MISMATCH");
      if (request.method !== "GET" && url.search)
        throw new HttpError(400, "INVALID_QUERY");
      if (!budget(peerAddress)) return error(429, "RATE_LIMITED");
      if (
        request.headers.get("sec-fetch-site") === "cross-site" &&
        url.pathname !== "/auth/callback"
      )
        throw new HttpError(403, "CROSS_SITE_REQUEST");
      const cookies = requestCookies(request.headers.get("cookie") ?? "");
      const credentials = {
        sessionToken: cookies.get("__Host-dge_session"),
        csrfToken: request.headers.get("x-dge-csrf"),
        origin: request.headers.get("origin"),
      };
      const write = () => {
        if (
          credentials.origin !== origin ||
          !token.test(credentials.csrfToken ?? "")
        )
          throw new HttpError(403, "REQUEST_PROTECTION_REQUIRED");
      };
      const method = (allowed) => {
        if (!allowed.includes(request.method))
          throw new HttpError(405, "METHOD_NOT_ALLOWED", {
            allow: allowed.join(", "),
          });
      };
      for (const extension of extensions) {
        const result = await extension({
          request,
          url,
          credentials,
          write,
          method,
        });
        if (result !== null)
          return json(
            result,
            request.method === "POST" &&
              /\/(?:documents|proposals|points)$/.test(url.pathname)
              ? 201
              : 200,
          );
      }
      if (url.pathname === "/auth/start") {
        method(["GET"]);
        if (url.search) throw new HttpError(400, "INVALID_QUERY");
        const result = await login.start();
        return cookiesResponse(
          new Response(null, {
            status: 303,
            headers: { ...headers, location: result.authorizationUrl },
          }),
          [result.cookie],
        );
      }
      if (url.pathname === "/auth/callback") {
        method(["GET"]);
        try {
          const result = await login.complete(
            url.href,
            cookies.get("__Host-dge_login"),
          );
          const maxAge = Math.max(
            0,
            Math.min(
              86400,
              Math.floor((Date.parse(result.expiresAt) - Date.now()) / 1000),
            ),
          );
          return cookiesResponse(
            new Response(null, {
              status: 303,
              headers: { ...headers, location: origin + "/account" },
            }),
            [
              sessionCookie(result.sessionToken, { maxAge }),
              `__Host-dge_csrf=${result.csrfToken}; Path=/; Secure; SameSite=Strict; Max-Age=${maxAge}`,
              result.clearLoginCookie,
            ],
          );
        } catch {
          return cookiesResponse(
            new Response(null, {
              status: 303,
              headers: {
                ...headers,
                location: origin + "/account?login=failed",
              },
            }),
            [clearIdentityCookies()[2]],
          );
        }
      }
      if (url.pathname === "/api/session") {
        method(["GET"]);
        if (url.search) throw new HttpError(400, "INVALID_QUERY");
        return json(await store.sessionInfo(credentials.sessionToken));
      }
      if (url.pathname === "/api/recovery-codes") {
        method(["POST"]);
        write();
        await boundedJson(request, []);
        return json(await store.issueRecoveryCodes(credentials), 201);
      }
      if (url.pathname === "/api/recovery-session") {
        method(["POST"]);
        if (credentials.origin !== origin)
          throw new HttpError(403, "REQUEST_PROTECTION_REQUIRED");
        const body = await boundedJson(request, ["accountId", "recoveryCode"]);
        const result = await store.recoverAccount(
          body.accountId,
          body.recoveryCode,
        );
        const maxAge = Math.max(
          0,
          Math.min(
            900,
            Math.floor((Date.parse(result.expiresAt) - Date.now()) / 1000),
          ),
        );
        return cookiesResponse(
          json({ recovered: true, recoveryRestricted: true }),
          [
            sessionCookie(result.sessionToken, { maxAge }),
            `__Host-dge_csrf=${result.csrfToken}; Path=/; Secure; SameSite=Strict; Max-Age=${maxAge}`,
          ],
        );
      }
      if (url.pathname === "/api/passkeys/enrollment/options") {
        method(["POST"]);
        write();
        await boundedJson(request, []);
        return json(await store.beginPasskeyEnrollment(credentials), 201);
      }
      if (url.pathname === "/api/passkeys/enrollment/verify") {
        method(["POST"]);
        write();
        const body = await boundedJson(request, ["challenge", "response"], undefined, 65536);
        return json(await store.finishPasskeyEnrollment(credentials, body.challenge, body.response), 201);
      }
      if (url.pathname === "/api/passkeys/authentication/options") {
        method(["POST"]);
        write();
        await boundedJson(request, []);
        return json(await store.beginPasskeyAuthentication(credentials), 201);
      }
      if (url.pathname === "/api/passkeys/authentication/verify") {
        method(["POST"]);
        write();
        const body = await boundedJson(request, ["challenge", "response"], undefined, 65536);
        return json(await store.finishPasskeyAuthentication(credentials, body.challenge, body.response));
      }
      if (url.pathname === "/api/passkeys") {
        method(["GET"]);
        if (url.search) throw new HttpError(400, "INVALID_QUERY");
        return json(await store.passkeys(credentials));
      }
      const passkeyRoute = url.pathname.match(/^\/api\/passkeys\/([a-f0-9-]+)$/);
      if (passkeyRoute && uuid.test(passkeyRoute[1])) {
        method(["DELETE"]);
        write();
        await boundedJson(request, []);
        return json(await store.revokePasskey(credentials, passkeyRoute[1]));
      }
      if (url.pathname === "/api/devices") {
        method(["GET", "POST"]);
        if (request.method === "GET") return json(await store.devices(credentials));
        write();
        const body = await boundedJson(request, ["keyThumbprint"]);
        return json(await store.authorizeDevice(credentials, body.keyThumbprint), 201);
      }
      const deviceRoute = url.pathname.match(/^\/api\/devices\/([a-f0-9-]+)$/);
      if (deviceRoute && uuid.test(deviceRoute[1])) {
        method(["DELETE"]);
        write();
        await boundedJson(request, []);
        return json(await store.revokeDevice(credentials, deviceRoute[1]));
      }
      if (
        url.pathname === "/api/logout" ||
        url.pathname === "/api/logout-all"
      ) {
        method(["POST"]);
        write();
        await boundedJson(request, []);
        await store[
          url.pathname.endsWith("logout-all") ? "logoutAll" : "logout"
        ](credentials);
        return cookiesResponse(
          json({ signedOut: true }),
          clearIdentityCookies(),
        );
      }
      if (url.pathname === "/api/workspaces") {
        method(["GET", "POST"]);
        if (request.method === "GET")
          return json(await store.organizations(credentials, page(url)));
        write();
        await boundedJson(request, []);
        return json(await store.createTenant(credentials), 201);
      }
      const route = url.pathname.match(
        /^\/api\/workspaces\/([a-f0-9-]+)\/(members|invitations|join)(?:\/([a-f0-9-]+))?$/,
      );
      if (!route || !uuid.test(route[1])) return error(404, "NOT_FOUND");
      const [, tenantId, kind, accountId] = route;
      if (kind === "members") {
        if (accountId) {
          method(["PATCH"]);
          if (!uuid.test(accountId)) return error(404, "NOT_FOUND");
          write();
          const body = await boundedJson(request, ["role"]);
          return json(
            await store.changeMember(
              credentials,
              tenantId,
              accountId,
              body.role,
            ),
          );
        }
        method(["GET"]);
        return json(await store.members(credentials, tenantId, page(url)));
      }
      if (kind === "invitations") {
        if (accountId) {
          method(["DELETE"]);
          if (!uuid.test(accountId)) return error(404, "NOT_FOUND");
          write();
          await boundedJson(request, []);
          return json(
            await store.revokeInvitation(credentials, tenantId, accountId),
          );
        }
        method(["GET", "POST"]);
        if (request.method === "GET")
          return json(
            await store.invitations(credentials, tenantId, page(url)),
          );
        write();
        const body = await boundedJson(request, ["accountId", "role"]);
        return json(
          await store.invite(credentials, tenantId, body.accountId, body.role),
          201,
        );
      }
      if (accountId) return error(404, "NOT_FOUND");
      method(["POST"]);
      write();
      if (url.search) throw new HttpError(400, "INVALID_QUERY");
      const body = await boundedJson(request, ["invitationToken"]);
      return json(
        await store.acceptInvitation(
          credentials,
          tenantId,
          body.invitationToken,
        ),
      );
    } catch (cause) {
      if (cause instanceof HttpError)
        return error(cause.status, cause.code, cause.headers);
      if (cause instanceof AccessError)
        return error(
          cause.code === "AUTHENTICATION_REQUIRED"
            ? 401
            : cause.code === "INVITATION_ALREADY_USED"
              ? 409
              : cause.code.endsWith("_LIMIT_REACHED")
                ? 429
                : 403,
          cause.code,
        );
      return error(503, "SERVICE_UNAVAILABLE");
    }
  };
}
