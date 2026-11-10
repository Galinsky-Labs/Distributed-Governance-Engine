# Frozen account voting rules — partial DCE-010

An owner or administrator can configure a proposal's quorum and approval rule
before opening its recorded vote. The server freezes the rule, exact proposal,
document version, mode and current eligible member accounts into one immutable
snapshot. Each account has one unit; this is not verified-person eligibility,
shareholder weighting, proxy authority or an open-public electorate.

`POST /api/workspaces/:tenantId/documents/:documentId/proposals/:proposalId/decision`
continues to require `hours` (1–720) and a UUID `commandId`. Optional
`policySettings` contains:

```json
{
  "minYes": "1",
  "minimumDeliberationHours": 0,
  "quorum": {"kind":"fraction-count","numerator":"1","denominator":"2"},
  "approval": {"basis":"decisive","comparison":"gt","numerator":"1","denominator":"2"}
}
```

A count quorum instead uses `{"kind":"count","minimum":"2"}`. Approval basis
is `decisive` (yes/no), `participating` (includes abstentions), or `eligible`
(all frozen accounts). `gt` means strictly more than the fraction; `gte` includes
the exact threshold. Fractions use exact integer cross multiplication, never
floating point. Positive count/minYes values are capped at 100,000; fraction
parts at 1,000,000. Fractions cannot exceed one, and a strict approval threshold
of one is rejected. Quorum count and minimum yes votes cannot exceed the frozen
membership. Partial settings use the existing defaults; explicit nulls,
unknown fields, weighting, mode and early-close overrides are rejected.

Minimum deliberation is 0–720 whole hours since the proposal's stored publication
time. Voting opens at the later of command time and that floor, then remains
open for the entire selected voting duration. UTC epoch milliseconds govern the
inclusive opening and exclusive deadline. The UI shows both timestamps and
requires refresh to update a scheduled vote's controls when its opening arrives.
Ballots and closure before their respective boundaries are rejected server-side.

Opening now requires a primary OIDC session authenticated within five minutes,
in addition to manager role, tenant membership, exact-origin CSRF and request
limits. A stale session receives `REAUTHENTICATION_REQUIRED`; sign in again.
Voting and closure keep their existing session/role checks. No new provider,
credential, cloud service or paid resource is required by this contribution.

Retries bind normalized settings and duration to the command ID. An uncertain
browser retry retains the same body/ID and locks the rule form until resolution
or an explicit refresh. Changed settings cannot reuse that command. The authenticated browser regression drops the real committed response through Chrome DevTools, checks the locked form and retries the identical body successfully. The saved
policy ID/digest and human-readable rule come from the snapshot, including for
historical votes; opening a new policy does not change any active vote. Database
runtime grants permit no update to snapshot columns. Existing requests without
settings preserve their original command-digest shape and default policy fields.

Public-input decisions stay advisory for every threshold and cannot change the
fixed source. A passed collaboration decision may append the exact amendment as
a new public **working draft**, provided its base version still matches. Neither
mode creates statutory adoption, execution, signature, challenge finality or
external anchor evidence.

No database migration or digest-format change is needed: optional timing metadata
is part of each new policy's existing digest-bound JSON snapshot. Existing
snapshots remain readable without it. Roll back the UI if necessary while
retaining these readers/evaluators for new snapshots; do not rewrite history,
ballots or policy digests. Named reusable templates, open-public safeguards,
verified eligibility, corporate rights, finality/challenge windows, production
hosting and independent review remain outstanding.
