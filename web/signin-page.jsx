import React, { useState } from "react";
import { startRegistration, startAuthentication } from "@simplewebauthn/browser";

const post = async (path, body = {}) => {
  const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, credentials: "same-origin", body: JSON.stringify(body) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(Error(result.error ?? "SIGNIN_FAILED"), { code: result.error });
  return result;
};
const explain = (error) => error?.name === "NotAllowedError"
  ? "The passkey prompt was cancelled or timed out. Nothing was changed."
  : { SIGNIN_EXPIRED: "That sign-in attempt expired. Try again.", PASSKEY_NOT_VERIFIED: "This passkey could not be verified for this site." }[error?.code]
    ?? "Sign-in could not be completed. Nothing was changed.";

/** Passkeys are bound to this site, so they cannot be phished by look-alike domains. */
export function SigninPage() {
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  async function ceremony(kind) {
    setBusy(true); setStatus(kind === "register" ? "Follow your device's prompt to create a passkey…" : "Follow your device's prompt…");
    try {
      const optionsJSON = await post(`/auth/passkey/${kind === "register" ? "register" : "login"}/options`);
      const response = kind === "register" ? await startRegistration({ optionsJSON }) : await startAuthentication({ optionsJSON });
      await post(`/auth/passkey/${kind === "register" ? "register" : "login"}/verify`, { response });
      setStatus("Signed in.");
      window.location.assign(kind === "register" ? "/account?welcome=1" : "/governance");
    } catch (error) { setStatus(explain(error)); } finally { setBusy(false); }
  }
  return (
    <section className="console-card signin-card">
      <h2>Sign in with a passkey</h2>
      <p>Your device (phone, laptop or security key) holds the key; we never receive a password or your biometrics. After creating an account, save the recovery codes offered on your account page.</p>
      <p><button disabled={busy} onClick={() => ceremony("authenticate")}>Sign in with a passkey</button></p>
      <p><button disabled={busy} onClick={() => ceremony("register")}>Create an account with a new passkey</button></p>
      <p role="status" aria-live="polite">{status}</p>
      <p className="console-description">Accounts are pseudonymous. An account is not proof of a unique person; verified tiers are issued separately.</p>
    </section>
  );
}
