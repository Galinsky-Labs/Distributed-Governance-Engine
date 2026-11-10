# ADR 0004 — bind provider restoration to the original limited session

Status: accepted for partial DCE-002 implementation, not production acceptance.

Recovery codes intentionally grant limited access. Exposing the existing trusted
restoration transaction to arbitrary issuer/subject JSON would permit identity
substitution. Reusing ordinary login state would risk switching accounts rather
than explicitly restoring the one whose recovery proof was supplied.

Use a protected POST with no identity fields to start a separate purpose in
server-encrypted OIDC state. Bind it to the exact account/recovery session and
CSRF proof, then require that original cookie at callback. Require both the
single-use code and an already-enrolled passkey; recheck credential/proof/session
at commit after fresh provider token verification. Keep actual provider assurance
and encrypted-device authorization separate.

The user must retain a code, account ID and old passkey. Losing all of these has
no insecure fallback. Provider callbacks and session expiry can require restarting
the flow. Existing login state without a purpose remains ordinary-login-only for
rolling compatibility; no client parameter selects the restoration purpose.
There is no schema change or retrospective identity/audit rewrite. Production
hosting, device selection, operator recovery and a real recovery drill remain
unverified. See ../PROVIDER_RESTORATION.md for the operational flow and tests.
