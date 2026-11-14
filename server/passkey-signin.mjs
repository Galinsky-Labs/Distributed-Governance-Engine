// First-party passkey sign-in. When no external OIDC provider is configured,
// discoverable WebAuthn credentials (verified with the pinned SimpleWebAuthn
// library, user verification required) establish ordinary engine sessions
// under the issuer `${origin}/passkey`. Recovery codes remain the account
// recovery path. No password, email address or personal data is collected.
import { randomBytes, createHash } from "node:crypto";
import {
  generateRegistrationOptions, generateAuthenticationOptions,
  verifyRegistrationResponse, verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import { boundedJson, HttpError } from "./account-http.mjs";
import { sessionCookie } from "./identity-store.mjs";

const CHALLENGE_TTL_MS = 300000;
const digest = (value) => createHash("sha256").update("quill-signin-v1\0" + value).digest("hex");
const token = () => randomBytes(32).toString("base64url");
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const LOGIN_COOKIE = "__Host-dge_signin";

export const passkeySigninBodyLimit = (path) => (path.startsWith("/auth/passkey/") ? 65536 : 8192);

export function createPasskeySignin({ identity, transaction, origin, rpName = "Quill", clock = Date.now }) {
  const site = new URL(origin);
  if (site.protocol !== "https:" || site.origin !== origin) throw Error("An exact HTTPS origin is required");
  const issuer = origin + "/passkey";
  const rpID = site.hostname;
  const worker = (fn) => transaction(async (db) => { await db.query("SELECT set_config('dge.worker','signin',true)"); return fn(db); });

  async function storeChallenge(purpose, userHandle = null) {
    const browserToken = token();
    return { browserToken, put: (challenge) => worker(async (db) => {
      await db.query("DELETE FROM dge_identity.signin_challenges WHERE expires_at<$1", [new Date(clock())]);
      await db.query("INSERT INTO dge_identity.signin_challenges(challenge_digest,browser_digest,purpose,user_handle,expires_at) VALUES($1,$2,$3,$4,$5)",
        [digest(challenge), digest(browserToken), purpose, userHandle, new Date(clock() + CHALLENGE_TTL_MS)]);
    }) };
  }
  /** One use: the challenge row is deleted whether or not verification succeeds. */
  async function consumeChallenge(db, response, purpose, browserToken) {
    if (!TOKEN.test(browserToken ?? "")) throw new HttpError(403, "SIGNIN_EXPIRED");
    let clientData;
    try { clientData = JSON.parse(Buffer.from(response?.response?.clientDataJSON ?? "", "base64url").toString("utf8")); }
    catch { throw new HttpError(400, "INVALID_CEREMONY"); }
    if (typeof clientData?.challenge !== "string" || clientData.challenge.length > 200) throw new HttpError(400, "INVALID_CEREMONY");
    const row = (await db.query(
      "DELETE FROM dge_identity.signin_challenges WHERE challenge_digest=$1 AND browser_digest=$2 AND purpose=$3 RETURNING user_handle,expires_at",
      [digest(clientData.challenge), digest(browserToken), purpose])).rows[0];
    if (!row || new Date(row.expires_at).getTime() < clock()) throw new HttpError(403, "SIGNIN_EXPIRED");
    return { challenge: clientData.challenge, userHandle: row.user_handle };
  }
  const established = async (session) => {
    const maxAge = Math.max(0, Math.min(86400, Math.floor((Date.parse(session.expiresAt) - clock()) / 1000)));
    const response = Response.json({ signedIn: true, accountId: session.accountId }, { status: 200 });
    for (const cookie of [
      sessionCookie(session.sessionToken, { maxAge }),
      `__Host-dge_csrf=${session.csrfToken}; Path=/; Secure; SameSite=Strict; Max-Age=${maxAge}`,
      `${LOGIN_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`,
    ]) response.headers.append("set-cookie", cookie);
    return response;
  };
  const withLoginCookie = (body, browserToken) => {
    const response = Response.json(body);
    response.headers.append("set-cookie", `${LOGIN_COOKIE}=${browserToken}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=300`);
    return response;
  };

  return {
    issuer,
    /** Satisfies the account handler's login contract: /auth/start opens the sign-in page. */
    login: Object.freeze({
      start: async () => ({ authorizationUrl: origin + "/signin", cookie: `${LOGIN_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0` }),
      complete: async () => { throw new HttpError(404, "NOT_FOUND"); },
    }),
    routes: async ({ request, url, credentials, method }) => {
      if (!url.pathname.startsWith("/auth/passkey/")) return null;
      method(["POST"]);
      // Pre-session requests: require the exact origin instead of a CSRF token.
      if (credentials.origin !== origin) throw new HttpError(403, "REQUEST_PROTECTION_REQUIRED");
      const browserToken = (request.headers.get("cookie") ?? "").split(";").map((c) => c.trim())
        .find((c) => c.startsWith(LOGIN_COOKIE + "="))?.slice(LOGIN_COOKIE.length + 1);
      switch (url.pathname) {
        case "/auth/passkey/register/options": {
          await boundedJson(request, []);
          const userHandle = token();
          const options = await generateRegistrationOptions({
            rpName, rpID, userName: "Quill member", userDisplayName: "Quill member",
            userID: Buffer.from(userHandle, "base64url"), attestationType: "none",
            authenticatorSelection: { residentKey: "required", userVerification: "required" },
            supportedAlgorithmIDs: [-7, -257], timeout: CHALLENGE_TTL_MS,
          });
          const pending = await storeChallenge("register", userHandle);
          await pending.put(options.challenge);
          return withLoginCookie(options, pending.browserToken);
        }
        case "/auth/passkey/register/verify": {
          const { response } = await boundedJson(request, ["response"], ["response"], 65536);
          const { challenge, userHandle } = await worker((db) => consumeChallenge(db, response, "register", browserToken));
          const credential = await (async () => {
            let result;
            try {
              result = await verifyRegistrationResponse({ response, expectedChallenge: challenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true, supportedAlgorithmIDs: [-7, -257] });
            } catch { throw new HttpError(403, "PASSKEY_NOT_VERIFIED"); }
            if (!result.verified || !result.registrationInfo.userVerified) throw new HttpError(403, "PASSKEY_NOT_VERIFIED");
            return { userHandle, info: result.registrationInfo };
          })();
          const session = await identity.establishSession({ issuer, subject: credential.userHandle, authenticatedAt: clock(), authenticationMethods: ["passkey", "mfa"] });
          await worker((db) => db.query(
            "INSERT INTO dge_identity.signin_credentials(credential_id,account_id,user_handle,public_key,counter,transports,backed_up,created_at,last_used_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8)",
            [credential.info.credential.id, session.accountId, credential.userHandle, Buffer.from(credential.info.credential.publicKey).toString("base64url"),
              credential.info.credential.counter, credential.info.credential.transports ?? [], credential.info.credentialBackedUp, new Date(clock())]));
          return established(session);
        }
        case "/auth/passkey/login/options": {
          await boundedJson(request, []);
          const options = await generateAuthenticationOptions({ rpID, userVerification: "required", timeout: CHALLENGE_TTL_MS });
          const pending = await storeChallenge("authenticate");
          await pending.put(options.challenge);
          return withLoginCookie(options, pending.browserToken);
        }
        case "/auth/passkey/login/verify": {
          const { response } = await boundedJson(request, ["response"], ["response"], 65536);
          const { challenge } = await worker((db) => consumeChallenge(db, response, "authenticate", browserToken));
          const subject = await worker(async (db) => {
            const stored = typeof response?.id === "string" && response.id.length <= 1366
              ? (await db.query("SELECT * FROM dge_identity.signin_credentials WHERE credential_id=$1 AND revoked_at IS NULL", [response.id])).rows[0] : null;
            if (!stored) throw new HttpError(403, "PASSKEY_NOT_VERIFIED");
            let result;
            try {
              result = await verifyAuthenticationResponse({
                response, expectedChallenge: challenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true,
                credential: { id: stored.credential_id, publicKey: new Uint8Array(Buffer.from(stored.public_key, "base64url")), counter: Number(stored.counter), transports: stored.transports },
              });
            } catch { throw new HttpError(403, "PASSKEY_NOT_VERIFIED"); }
            if (!result.verified || !result.authenticationInfo.userVerified) throw new HttpError(403, "PASSKEY_NOT_VERIFIED");
            // A user handle presented by the authenticator must match the stored one.
            if (response.response.userHandle && response.response.userHandle !== stored.user_handle) throw new HttpError(403, "PASSKEY_NOT_VERIFIED");
            await db.query("UPDATE dge_identity.signin_credentials SET counter=$2,last_used_at=$3 WHERE credential_id=$1", [stored.credential_id, result.authenticationInfo.newCounter, new Date(clock())]);
            return stored.user_handle;
          });
          return established(await identity.establishSession({ issuer, subject, authenticatedAt: clock(), authenticationMethods: ["passkey", "mfa"] }));
        }
        default: throw new HttpError(404, "NOT_FOUND");
      }
    },
  };
}
