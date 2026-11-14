# Payment provider adapters and reconciliation (DCE-030)

Status: implemented on branch `feature/admin-billing` and tested against an in-memory imitation
of the Stripe REST API with real HMAC signatures. **Not exercised against Stripe's servers**, not
deployed, not wired into `server/start.mjs`. No payment was ever made by this work.

Files: `server/payment-providers/stripe.mjs`, `server/payment-providers/manual.mjs`,
`server/billing-store.mjs`, `server/billing-http.mjs`, `scripts/reconcile-payments.mjs`,
`migrations/025-entitlements-and-payments.sql`.

## Provider interface

A provider is a plain object:

| Member | Meaning |
| --- | --- |
| `id` | route and storage name (`stripe`, `manual`) |
| `available` | `true` only when fully configured; otherwise checkout and webhooks return `503 PROVIDER_UNAVAILABLE` and the browser shows no purchase control |
| `mode` | `test` / `live` (Stripe, from the key prefix), `invoice` (manual), or `null` |
| `createCheckout({checkoutId, item, successUrl, cancelUrl})` | returns `{providerSessionId, url, livemode, status}` |
| `verifyWebhook(rawBody, headers)` | authenticates and returns a normalized event, or throws |
| `fetchCheckout`, `fetchSubscription`, `fetchPayment` (optional) | read-only state for reconciliation |

Normalized events carry only identifiers, integer minor-unit amounts, currency, status and
times: `kind` is one of `checkout-completed`, `invoice-paid`, `subscription-updated`,
`subscription-deleted`, `charge-refunded`, `dispute-created`, `ignored`. Eligibility and
governance code never sees provider objects, so a provider can be replaced by writing another
adapter.

## Checkout

`POST /api/billing/checkout {provider, itemId, subject: "account" | "tenant", tenantId?, idempotencyKey}`
(`GET` returns `{providers, catalog, purchasesEnabled}`).

1. In one transaction the caller is authorized (any non-recovery session for an account
   purchase; workspace owner/admin for a workspace purchase), the catalog item is read from
   effective settings, and a `checkouts` row is stored with a snapshot of the item, its amount
   and currency, `status = 'creating'`, keyed by `(created_by, idempotencyKey)`. Reusing a key for
   a different request fails with `409 IDEMPOTENCY_KEY_REUSED`; reusing it for the same request
   returns the same checkout.
2. Outside any transaction the adapter is called. Stripe receives
   `POST /v1/checkout/sessions` (form-encoded) with `mode` (`payment` or `subscription`),
   `client_reference_id` = checkout ID, inline `price_data` (currency, `unit_amount` in minor
   units, product name, `recurring[interval]` for subscriptions), `metadata[checkout_id]` on the
   session and on the payment intent or subscription, fixed same-origin success/cancel URLs, and
   the header `Idempotency-Key: dge-checkout-<checkoutId>` — so concurrent or retried requests
   get the same Stripe session.
3. A second transaction stores the session ID and `https` URL (`status = 'open'`), or
   `invoice-requested` for the manual provider.

The browser redirects only to an `https:` URL returned by the server. Nothing is credited until
a verified payment event arrives.

## Webhooks

`POST /api/billing/webhooks/{provider}` reads the exact raw body (at most 64 KiB) and never calls
`write()`: providers send no browser origin or CSRF token. Authentication is the provider
signature only.

Stripe: header `Stripe-Signature: t=<unix seconds>,v1=<hex>[,v1=<hex>…]`. The adapter computes
HMAC-SHA256 with the endpoint secret over `` `${t}.${rawBody}` ``, compares against every `v1`
candidate with `timingSafeEqual` (supporting secret rotation), ignores other schemes such as
`v0`, and then requires `|now − t| ≤ 300 s` (`WEBHOOK_TIMESTAMP_STALE`). Missing, malformed or
wrong signatures, a wrong secret and any modified byte fail with `400 WEBHOOK_SIGNATURE_INVALID`
before anything is stored.

Processing, in one transaction in billing-worker mode:

* The event is inserted into `dge_billing.webhook_events` keyed by `(provider, event_id)`. A
  replayed event ID returns `{received: true, duplicate: true}` and changes nothing.
* Its normalized identifiers are stored as `refs` (no raw body, no card data, no customer
  details) so it can be retried.
* Outcomes: `processed`, `ignored` (unknown type, unpaid or foreign checkout), `pending-link`
  (refers to a subscription or payment not yet linked to a checkout), `stale` (older than the
  last applied subscription state, or after cancellation), `mismatch` (amount, currency or
  session differs from the stored checkout; the checkout is marked `mismatch` and nothing is
  granted).

| Stripe event | Effect |
| --- | --- |
| `checkout.session.completed` (payment_status `paid`) | marks the checkout completed and links its payment intent / subscription; one-time items add a provenance grant and a `purchase` ledger entry (idempotency `checkout:<id>`, so a second completion event credits nothing); subscriptions create the subscription record |
| `invoice.paid` | a `subscription` grant for exactly the invoice period (`lines.data[0].period`), quantity from the catalog item or unlimited, idempotency per invoice |
| `customer.subscription.updated` | updates status and period end unless older than the last applied event (`stale`); `canceled`, `unpaid`, `incomplete_expired` are treated as deletion |
| `customer.subscription.deleted` | marks the subscription canceled and ends its still-running grants now |
| `charge.refunded` | one-time purchase: revokes `floor(quantity × cumulative_refunded / amount)` credits in total (exact `BigInt` arithmetic), limited to the unused balance; subscription payment: a full refund ends the subscription's running grants |
| `charge.dispute.created` | records the dispute; revokes all unused credits of that purchase, or ends the subscription's running grants |

**Out-of-order delivery:** events that cannot be linked yet stay `pending-link`. After every
processed `checkout.session.completed` or `invoice.paid`, up to 100 pending events of that
provider are retried in provider-creation order. Subscription status updates apply only if their
event time is not older than the last applied one, and cancellation is terminal.

**Refunds and disputes never touch governance.** Credits already spent on documents cannot be
recovered; the unrecoverable remainder is reported by reconciliation. Documents, memberships,
proposals and ballots are unchanged.

## Manual provider (invoiced customers)

Enabled with `BILLING_MANUAL_INVOICING=enabled`. Checkout creates an `invoice-requested` record
and no URL. A platform administrator then records the payment —
`POST /api/entitlements/manual-payments {checkoutId, invoiceReference, amountMinor, currency}`
— or a cumulative refund —
`POST /api/entitlements/manual-refunds {checkoutId, refundReference, refundedMinor}`. These are
turned into normalized events with IDs `manual:payment:<invoiceReference>` /
`manual:refund:<refundReference>` and processed by the same code, so recording the same invoice
twice is a duplicate. The manual provider has no webhook (`404 WEBHOOK_UNSUPPORTED`).

## Reconciliation

`reconcilePayments({transaction, provider, limit})` (also `billing.reconcile({provider})` and
`node scripts/reconcile-payments.mjs stripe|manual [limit]`) reads the latest checkouts in one
transaction, then queries the provider outside it, and reports without changing anything:

`credit-purchase-mismatch`, `unrecoverable-credits`, `mode-mismatch`, `paid-not-fulfilled`
(e.g. a lost webhook), `fulfilled-not-paid`, `amount-mismatch`,
`subscription-status-mismatch`, `refund-mismatch`, `dispute-not-applied`,
`provider-unreachable`, plus the number of `pending-link` events. The report includes
`mode` (`test`/`live`/`invoice`), contains identifiers and integer amounts only, and the script
exits 2 when differences exist. Fixing a difference is an operator decision.

## Configuration

| Variable | Meaning |
| --- | --- |
| `STRIPE_SECRET_KEY` | `sk_test_…`/`sk_live_…` (or restricted `rk_…`); absent → Stripe unavailable |
| `STRIPE_WEBHOOK_SECRET` | `whsec_…` endpoint secret; absent → Stripe unavailable |
| `STRIPE_API_VERSION` | optional pinned API version header |
| `BILLING_MANUAL_INVOICING` | `enabled` to offer invoices |

The generic `PAYMENT_PROVIDER_SECRET` / `PAYMENT_WEBHOOK_SECRET` placeholders in `.env.example`
are not read by this code.

## Security notes

* No code path logs card data, keys, signatures or webhook bodies; provider errors become
  fixed codes (`PROVIDER_REQUEST_FAILED`, `PROVIDER_UNREACHABLE`, `PROVIDER_RESPONSE_INVALID`).
* Card data never reaches this service (Stripe-hosted Checkout).
* Webhook events are trusted only after signature verification; the checkout ID inside an event
  must match a stored checkout for that provider, and amount/currency/session must match.
* Billing-worker mode (`dge.worker = 'billing'`) bypasses subject row filters for billing tables
  only and is entered by server code after verification.

## Limitations

* Validated against a local imitation of the documented Stripe API, not Stripe itself; field
  locations follow the documented API (`invoice.subscription`, with a fallback to
  `parent.subscription_details` for newer versions). Pin `STRIPE_API_VERSION` and run a
  test-mode end-to-end check before production.
* `checkout.session.async_payment_succeeded` / `…_failed` are ignored: delayed payment methods
  are not fulfilled automatically (reconciliation reports them as `paid-not-fulfilled`).
* Partial refunds of subscription payments do not change grants.
* Invoice and tax metadata (tax IDs, addresses, tax rates) are not collected or stored; the
  catalog prices are sent as entered. Customer portal, plan changes and proration are not
  implemented.
* Pending-link retries are bounded to 100 events per trigger; older ones wait for the next
  trigger and are counted by reconciliation.
