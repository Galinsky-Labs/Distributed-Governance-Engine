# Subscriptions, notifications and participation digests (DCE-032)

Status: implemented and locally tested against PGlite (`tests/notifications.test.mjs`). The worker is not scheduled by `server/start.mjs`; the email adapter has been exercised only with an injected `fetch`, never against the live Postmark API. Not deployed, not independently reviewed.

## Model

| Table (`dge_notifications`) | Purpose | Who can read / write |
| --- | --- | --- |
| `subscriptions` | account follows a `document`, `proposal` or `workspace` | owning account (`dge.account_id`); worker |
| `preferences` | cadence per channel: `in_app`, `email` ∈ `immediate`, `daily`, `weekly`, `off`; email `locale` | owning account; worker |
| `email_addresses` | one address per account, `verified_at` | owning account; worker |
| `deliveries` | one row per (account, channel, ledger sequence); status `pending` → `delivered` / `suppressed` / `dead` | worker only |
| `inbox` | in-app notices (`event` or `digest`) with read state | owning account reads and toggles `read_at`; worker inserts |
| `worker_cursor` | last fanned-out ledger sequence; a trigger forbids moving it backwards | worker only |

Defaults without a `preferences` row: in-app `immediate`, email `off`, locale `en`. All tables have `ENABLE` + `FORCE ROW LEVEL SECURITY`. Account policies compare `account_id` with `current_setting('dge.account_id', true)`; worker policies require `current_setting('dge.worker', true) = 'notifications'`. Grants are column-scoped where rows are updated.

## Event source

The worker consumes `dge_ledger.entries`, the transparency log that sequences every committed public event, instead of hooking into other stores. Per entry:

| Ledger kind | Resolution |
| --- | --- |
| `document-version` | subject is the document |
| `proposal` | subject is the document; proposal from `dge_proposals.anchor_outbox` by event digest |
| `discussion-event` | subject is the document; proposal from `dge_discussion.anchor_outbox` by event digest |
| `decision-event` | subject is the decision; document and proposal from `dge_decisions.decisions` (only those two columns are read) |
| any other kind | treated as document activity if the subject is a public document, otherwise skipped |

Entries with `scope='blinded'` (private commitments) are skipped. To read the source outbox rows the worker sets `dge.tenant_id` to the entry's tenant inside its own transaction; it never reads ballots, electorate snapshots or private tables.

Subscribers matched: workspace followers of the entry's tenant, document followers and proposal followers, whose subscription existed when the entry was recorded. Each subscriber gets one `deliveries` row per enabled channel. `UNIQUE (account_id, channel, ledger_seq)` plus the cursor (`SELECT … FOR UPDATE`) make fan-out idempotent: concurrent or repeated `tick()` calls never create duplicates.

## Delivery and re-checks

`deliver()` claims due groups — one row for `immediate`, or every due row of one account, channel and cadence for a digest (≤ 200 items) — with `FOR UPDATE SKIP LOCKED`. In the same transaction, before anything is shown or sent, it re-checks:

1. the account is still `active` (suspension suppresses),
2. the channel's current cadence is not `off`,
3. a subscription that covers the item still exists — and for workspace subscriptions the account is still an active member,
4. the document is still public; its **current** title is read at this point.

Failing items become `suppressed` with reason `account-inactive`, `channel-off`, `access-ended` or `no-verified-address`. So an unsubscribe, a membership removal or a suspension that commits before the delivery transaction takes effect before delivery, including for digest items queued days earlier.

- **In-app**: one `inbox` row (`event` or `digest`) and the delivery rows become `delivered` in the same transaction.
- **Email**: the claim transaction leases the rows (5 minutes) and composes the message; the adapter is called outside any transaction; success marks `delivered`, failure increments `attempts`, sets `next_attempt_at = now + min(6 h, 60 s × 2^attempts)` and records a sanitized error code. After `maxAttempts` (default 8) or a permanent provider rejection the rows become `dead` and are never retried. With no adapter configured, email rows stay `pending` with `email-unavailable` and follow the same backoff into `dead`; nothing is marked delivered.

Delivery is at least once: if the process stops after the provider accepted a message but before the row is marked, the lease expires and the message is re-sent after re-checking.

Digest boundaries are UTC: daily at `digestHourUtc` (default 08:00), weekly on `digestWeekdayUtc` (default Monday). Digests group items by document.

## Content rules

In-app items and emails contain only: event kind, the public document title, document/proposal/workspace identifiers, the ledger sequence and time, and links to the public document. They never contain document body text, proposal wording, discussion text, ballots or another person's identity. Emails are plain text only (no HTML, no tracking: `TrackOpens=false`, `TrackLinks=None`) and are localized with the recipient's `locale` preference. The worker and adapter report errors as codes; addresses and contents are never logged.

The worker does not know who caused an event, so a follower is also notified of their own public activity.

## Email addresses

`PUT /api/notifications/email` stores the address unverified (domain lower-cased), switches email delivery off and sends a verification link via the adapter (at most once per minute per account). The link carries a `verify-email` token bound to the account and a digest of the exact address; changing the address invalidates earlier links. `email` cadences other than `off` require a verified address and a configured adapter (`EMAIL_NOT_VERIFIED` 409, `EMAIL_UNAVAILABLE` 503).

## Tokens

`n1.<payload>.<HMAC-SHA256>` with a 32-byte `NOTIFICATION_TOKEN_KEY`. The payload holds only `{p: purpose, a: account, s: subscription | c: "email" | h: address digest, e: expiry}`; the purpose is inside the MAC, so tokens are single-purpose. Unsubscribe tokens last 60 days, verification tokens 24 hours. Verification is constant-time; tampered, foreign-key, wrong-purpose and expired tokens are `400 INVALID_TOKEN`. Rotating the key invalidates every outstanding link.

Unsubscribe works without login: `POST /api/public/notifications/unsubscribe {token, preview?}` (same-origin `Origin` required). `preview:true` only describes the effect. Tokens are only ever sent in POST bodies and URL fragments (`/notifications/unsubscribe#<token>`), never in query strings, so they do not reach access logs. Emails carry a `List-Unsubscribe: <https://…>` header pointing at that confirmation page; RFC 8058 one-click (`List-Unsubscribe-Post`) is **not** supported, because the account handler only accepts JSON bodies.

## HTTP API

| Method and path | Body | Result |
| --- | --- | --- |
| `GET /api/notifications/subscriptions?after&limit` | | `{items, nextCursor}` |
| `POST /api/notifications/subscriptions` | `{targetKind, targetId}` | 201 subscription (idempotent) |
| `DELETE /api/notifications/subscriptions/:id` | `{}` | `{removed:true}` |
| `GET /api/notifications/preferences` | | `{inApp, email, locale, emailAddress, emailAvailable}` |
| `PUT /api/notifications/preferences` | `{inApp, email, locale}` | preferences |
| `PUT /api/notifications/email` | `{address}` | `{address, verified, verificationSent}` |
| `DELETE /api/notifications/email` | `{}` | `{removed:true}` |
| `GET /api/notifications/inbox?before&limit` | | `{items, nextCursor, unreadCount}` newest first |
| `POST /api/notifications/inbox/read` | `{ids (≤100), read}` | `{updated}` |
| `POST /api/notifications/inbox/read-all` | `{}` | `{updated}` |
| `POST /api/public/notifications/unsubscribe` | `{token, preview?}` | `{scope}` or `{unsubscribed, scope}` |
| `POST /api/public/notifications/email-verification` | `{token}` | `{verified:true}` |

Account routes require a session. Writes require the account handler's `write()` guard (exact `Origin` and `x-dge-csrf` header). Because the identity store exposes CSRF-digest verification only through `withTenant`, account-scoped (non-workspace) writes rely on that HTTP guard plus session validation rather than on the store-level digest comparison; recovery-restricted sessions cannot write. Subscribing to a document or proposal requires only that it is public; subscribing to a workspace requires active membership. Limit: 500 subscriptions per account.

## Not implemented

Per-user time zones for digests, quiet hours, notification of private (encrypted) workspace activity, push or SMS channels, bounce/complaint webhooks from the email provider, RFC 8058 one-click unsubscribe, and topic follows.
