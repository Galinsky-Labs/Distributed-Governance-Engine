# WebAuthn verifier and account controls — DCE-002 contribution

The production bootstrap can use pinned `@simplewebauthn/server` 14.1.0 and the
browser uses `@simplewebauthn/browser` 14.0.0. The adapter verifies registration and
assertion signatures, exact HTTPS origin, RP ID, server challenge, user presence
and user verification. It allows ES256/RS256 enrollment. Cross-origin/embedded
ceremonies are rejected even when a browser omits `topOrigin`. Invalid upstream
responses become a bounded failed-verification result; upstream exception text
and credential material are not logged.

Passkeys remain unavailable when `PASSKEY_ATTESTATION_POLICY` is absent. To enable
them, set a bounded JSON object with exactly `id`, `allowedFormats` and
`allowedAaguids`. The existing identity store validates and freezes that explicit
allowlist and records it with each credential. A changed policy requires a new
configuration/restart and should use a new policy ID. The repository supplies no
default production AAGUID. In particular, `none` attestation and an AAGUID do not
prove a physical model, secure element, non-exportability or hardware assurance;
selecting a stronger policy also requires authentic vendor/metadata evidence.

The account panel provides add, verify and revoke controls using the existing
same-origin, CSRF-protected endpoints. Enrollment/revocation require a recent
multifactor provider login. Verification records only a five-minute local session
step-up. Credential revocation clears linked device authorization and step-up
state through the existing store transaction. Recovery sessions cannot enroll or
revoke a passkey. Their existing-passkey verification remains restricted and does
not itself restore a provider or open a private workspace.

No database migration or credential shape changes are introduced. Existing
credentials remain subject to the store's recorded policy and counter checks.
Removing the optional policy disables enrollment/verification without deleting
credential or security-event records. The existing request/body limits and
session-bound, expiring, consumed challenges remain in force.

Validation: `node --test tests/passkey-verifier.test.mjs` exercises real ES256
signatures, tampering, UV, RP/origin/challenge binding, cross-origin refusal,
unknown credentials and stale counters. `tests/passkeys.browser.mjs` exercises
native browser registration, verified assertion and revocation through the
account UI with a CDP virtual authenticator and the real verifier/store over TLS.
Its explicit virtual-model allowlist is test-only. It is not physical-device,
production identity-provider, recovery-drill, E2EE or certification evidence.

Run `npm run build` before that browser test, then
`DGE_BROWSER_EXECUTABLE=/path/to/chrome node --test tests/passkeys.browser.mjs`.
CI uses the repository-pinned browser. Local evidence also uses managed system
Chromium; its version must be recorded with results. Full DCE-002 acceptance,
hosted provider-restoration drills and real deployment remain outstanding.

The browser provider-restoration contribution now connects limited code redemption,
already-enrolled passkey verification and a purpose/session-bound fresh OIDC
callback. See PROVIDER_RESTORATION.md for current behavior, rollback and evidence.
Hosted recovery drills, physical devices, private-content
recovery and full DCE-002 acceptance remain unverified. No new deployment
credential is required beyond the configured issuer/client, independent session
and state keys, database/TLS credentials and explicit passkey policy.
