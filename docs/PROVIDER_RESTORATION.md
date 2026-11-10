# Provider sign-in restoration — partial DCE-002

Save your account ID together with one-time recovery codes outside the app. From
the account panel, choose **Use a recovery code**. Redemption invalidates existing
sessions and creates a limited session. It can inspect account/passkey metadata,
verify an existing passkey and sign out; it cannot open workspace content, change
membership, issue codes, enroll a passkey or authorize an encryption device.

Verify with a passkey enrolled before the loss, then choose **Restore provider
sign-in**. The configured provider requires fresh sign-in to the account whose
issuer/subject will replace the old binding. Email addresses never link accounts.
A provider account already bound to another engine account cannot be substituted.
Without the old passkey or an unused code, this flow fails closed; no operator,
email, session-only or new-passkey override is provided.

`POST /api/provider-restoration` accepts an empty JSON object, the exact Origin,
current limited session cookie and its CSRF header. It cannot accept identity
claims or a provider URL. The OIDC adapter stores a distinct restoration purpose,
account ID, keyed session binding and CSRF proof inside encrypted, browser-bound,
one-use login state, together with PKCE and nonce. It requests `prompt=login` and
`max_age=300`. Ordinary `/auth/start` does not restore an old account.

On the fixed callback, the adapter requires the original recovery session cookie
and rechecks its CSRF binding, restricted method, five-minute passkey proof and
active credential before token exchange. The atomic restoration transaction checks
these again after real signature/issuer/audience/nonce/PKCE/auth-time validation.
Proof from a future clock time fails. A switched or replacement recovery session,
revocation, expiry or replay cannot fall back to creating or linking an account.
The callback GET uses the server-sealed CSRF proof from the protected start;
it does not require the browser to add an Origin or custom header to navigation.

Success preserves the internal account and workspace IDs, changes only the
provider binding, revokes earlier sessions and issues a fresh ordinary OIDC
session with only the assurance proven by the new provider. It carries no local
passkey step-up or encryption-device authority. Recovery inputs stay in request
bodies/component memory, are cleared on submission/close, and are never written
to URLs or browser storage. Recovery codes are shown once with a reminder to save
the account ID.

No schema migration or deployment credential is added. Roll out the matching
server/UI together after existing migration 012; rollback disables the new browser
entry point without rewriting identity/audit history. Restore the previous binding
only through a fresh authorized flow, never a destructive data rollback.

`tests/identity.test.mjs` tests bindings, proof expiry/revocation/clock rollback,
one-use callbacks, provider assurance and account/workspace continuity with real
openid-client validation and synthetic signed tokens. HTTP tests enforce exact
input/method/protection. `tests/passkeys.browser.mjs` runs the full UI with native
WebAuthn, pinned SimpleWebAuthn and Chromium's virtual authenticator. Separate
Keycloak integration tests exercise genuine upstream password/OTP and TLS.
These local/CI tests do not establish a hosted recovery drill, physical-device
interoperability, private-content recovery, fleet-wide abuse protection, operator
recovery, independent review or complete DCE-002 acceptance.
