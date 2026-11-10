export class AccountAPIError extends Error {
  constructor(code, status) {
    super(code);
    this.code = code;
    this.status = status;
  }
}
export function browserCSRF(cookie) {
  const values = cookie
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.startsWith("__Host-dge_csrf="))
    .map((s) => s.slice("__Host-dge_csrf=".length));
  if (values.length !== 1 || !/^[A-Za-z0-9_-]{43}$/.test(values[0]))
    throw new AccountAPIError("SIGN_IN_AGAIN", 403);
  return values[0];
}
export function createAccountAPI({
  fetcher = (...args) => fetch(...args),
  cookie = () => document.cookie,
} = {}) {
  return async (path, { method = "GET", body, signal } = {}) => {
    if (
      !path.startsWith("/api/") ||
      path.includes("\\") ||
      path.startsWith("//")
    )
      throw Error("Same-origin API path required");
    const headers = { accept: "application/json" };
    if (method !== "GET") {
      headers["content-type"] = "application/json";
      headers["x-dge-csrf"] = browserCSRF(cookie());
    }
    const response = await fetcher(path, {
      method,
      headers,
      credentials: "same-origin",
      cache: "no-store",
      signal,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    let result;
    try {
      result = await response.json();
    } catch {
      throw new AccountAPIError("SERVICE_UNAVAILABLE", 503);
    }
    if (!response.ok)
      throw new AccountAPIError(
        result.error ?? "SERVICE_UNAVAILABLE",
        response.status,
      );
    return result;
  };
}
export function invitationPackage(tenantId, invitationToken) {
  return (
    "quill1." +
    btoa(JSON.stringify({ tenantId, invitationToken }))
      .replace(/=/g, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
  );
}
export function readInvitationPackage(value) {
  if (
    typeof value !== "string" ||
    value.length > 512 ||
    !/^quill1\.[A-Za-z0-9_-]+$/.test(value)
  )
    throw Error("Invalid invitation code");
  const result = JSON.parse(
    atob(value.slice(7).replace(/-/g, "+").replace(/_/g, "/")),
  );
  if (
    !result ||
    Object.keys(result).sort().join(",") !== "invitationToken,tenantId" ||
    !/^[a-f0-9-]{36}$/.test(result.tenantId) ||
    !/^[A-Za-z0-9_-]{43}$/.test(result.invitationToken)
  )
    throw Error("Invalid invitation code");
  return result;
}

// Recovery starts without an existing session or CSRF cookie. The server requires
// the browser's exact Origin and a single-use code; keep both inputs out of URLs.
export async function recoverWithCode(accountId, recoveryCode, fetcher = (...args) => fetch(...args)) {
  if (typeof accountId !== 'string' || typeof recoveryCode !== 'string' ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(accountId) ||
      !/^[A-Za-z0-9_-]{43}$/.test(recoveryCode))
    throw new AccountAPIError('RECOVERY_NOT_ACCEPTED', 403);
  const response = await fetcher('/api/recovery-session', {
    method: 'POST', credentials: 'same-origin', cache: 'no-store',
    headers: {accept: 'application/json', 'content-type': 'application/json'},
    body: JSON.stringify({accountId, recoveryCode}),
  });
  if (!response.ok) throw new AccountAPIError(
    response.status === 429 ? 'RATE_LIMITED' : response.status >= 500 ? 'SERVICE_UNAVAILABLE' : 'RECOVERY_NOT_ACCEPTED', response.status);
}
