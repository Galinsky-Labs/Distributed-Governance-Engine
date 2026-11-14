// Postmark transactional email adapter (POST https://api.postmarkapp.com/email).
// Email delivery adapter interface: { id, send({to, subject, text, headers?, tag?}) → {messageId} }.
// send() resolves only after the provider accepted the message and throws
// EmailDeliveryError otherwise; nothing is reported as sent on failure.
// Errors carry codes only, never the recipient address or message text.

export class EmailDeliveryError extends Error {
  constructor(code, { permanent = false } = {}) {
    super(code);
    this.name = "EmailDeliveryError";
    this.code = code;
    this.permanent = permanent;
  }
}

const SAFE_HEADER = /^[A-Za-z][A-Za-z0-9-]{0,60}$/;

export function createPostmarkAdapter({
  serverToken, from, messageStream = "outbound", fetch: fetcher = globalThis.fetch,
  endpoint = "https://api.postmarkapp.com/email", timeoutMs = 10000,
}) {
  if (typeof serverToken !== "string" || !/^[A-Za-z0-9-]{20,100}$/.test(serverToken)) throw Error("Postmark server token required");
  if (typeof from !== "string" || from.length > 254 || !/@/.test(from) || /[\r\n]/.test(from)) throw Error("Postmark sender address required");
  if (!/^[a-z0-9-]{1,60}$/.test(messageStream)) throw Error("Invalid Postmark message stream");
  if (typeof fetcher !== "function" || new URL(endpoint).protocol !== "https:") throw Error("HTTPS fetch required");
  return Object.freeze({
    id: "postmark",
    async send({ to, subject, text, headers = {}, tag = null }) {
      if (typeof to !== "string" || /[\r\n,;]/.test(to) || typeof subject !== "string" || /[\r\n]/.test(subject) || typeof text !== "string")
        throw new EmailDeliveryError("invalid-message", { permanent: true });
      const body = {
        From: from, To: to, Subject: subject, TextBody: text, MessageStream: messageStream, TrackOpens: false, TrackLinks: "None",
        Headers: Object.entries(headers).filter(([name, value]) => SAFE_HEADER.test(name) && typeof value === "string" && !/[\r\n]/.test(value))
          .map(([Name, Value]) => ({ Name, Value })),
        ...(tag ? { Tag: String(tag).slice(0, 1000) } : {}),
      };
      let response;
      try {
        response = await fetcher(endpoint, {
          method: "POST",
          headers: { accept: "application/json", "content-type": "application/json", "x-postmark-server-token": serverToken },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        throw new EmailDeliveryError("provider-unreachable");
      }
      let result = null;
      try { result = await response.json(); } catch { /* status code decides below */ }
      if (response.ok && result?.ErrorCode === 0 && typeof result.MessageID === "string") return { messageId: result.MessageID };
      if (response.status === 429 || response.status >= 500) throw new EmailDeliveryError("provider-" + response.status);
      if (response.status === 401) throw new EmailDeliveryError("provider-auth");
      // 406: inactive recipient; 422 with other codes: rejected message. Retrying cannot help.
      const code = Number.isSafeInteger(result?.ErrorCode) ? result.ErrorCode : response.status;
      throw new EmailDeliveryError("provider-rejected-" + code, { permanent: response.status === 406 || response.status === 422 });
    },
  });
}

/** Adapter from POSTMARK_SERVER_TOKEN / NOTIFICATION_EMAIL_FROM, or null when unconfigured. */
export function postmarkFromEnvironment(env = process.env, options = {}) {
  if (!env.POSTMARK_SERVER_TOKEN) return null;
  return createPostmarkAdapter({
    serverToken: env.POSTMARK_SERVER_TOKEN, from: env.NOTIFICATION_EMAIL_FROM,
    messageStream: env.POSTMARK_MESSAGE_STREAM || "outbound", ...options,
  });
}
