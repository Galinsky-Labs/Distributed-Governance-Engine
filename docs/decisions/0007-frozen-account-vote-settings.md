# Decision: freeze explicit account rules with recent owner authentication

Existing votes already freeze a policy and electorate, but the hosted form could
only open one hard-coded rule. Reuse the persisted, digest-bound policy snapshot
for bounded count/fraction quorums, exact approval denominators/comparisons and a
publication-relative deliberation floor. A policy ID identifies one frozen
version; this does not introduce a reusable policy-template administration API.

Only current owners/admins may create the snapshot. Freezing configurable rules
requires actual provider authentication within five minutes, as document mode
freezing already does. A session cookie, recent app-session issuance, recovery
session or supplied assurance flag cannot replace that evidence. Other vote
permissions are unchanged. Existing session storage and constraints remain the
authority; no migration or new credential is necessary.

No setting changes source mode, grants an early close, supplies ballot weight or
mutates an existing snapshot. Public-input remains advisory and draft application
stays version-fenced. The UI labels actual rules from server snapshots and keeps
an uncertain retry's exact body. Historical default snapshots and old request
digests remain compatible; new optional timing fields are covered by existing
canonical digest domains. Preserve upgraded readers if rolling back the writer.

This is partial DCE-010 source evidence. Verified persons, shareholder/proxy
policies, finality/challenge procedures, deployment and independent assessment
remain separate gates.
