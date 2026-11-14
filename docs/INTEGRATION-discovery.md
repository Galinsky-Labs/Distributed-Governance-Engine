# Integrating search, notifications and localization

Nothing in this feature is wired into `server/start.mjs`, `server/application.mjs` or `web/app.jsx`; this page lists what the integrator adds. Behaviour is specified in [SEARCH.md](SEARCH.md), [NOTIFICATIONS.md](NOTIFICATIONS.md) and [LOCALIZATION.md](LOCALIZATION.md).

## Database

Migration `026-search-and-notifications.sql` is already registered in `server/identity-store.mjs` and is applied by `npm run migrate` with the migration owner. It adds `dge_search` (functions only), `dge_notifications`, generated `search_vector` columns and GIN indexes on `dge_documents.documents` and `dge_proposals.proposals`, and the `public_proposal_search` policy. Adding the stored generated columns rewrites both tables once during migration. `verifyIdentityRuntime` does not yet include `dge_search`/`dge_notifications` in its schema-ownership check; the runtime role owns nothing in them and has no `CREATE` on them.

## Server factories

```js
import {createSearchStore} from "./search-store.mjs";
import {createSearchRoutes, searchBodyLimit} from "./search-http.mjs";
import {createNotificationStore, createNotificationTokens} from "./notification-store.mjs";
import {createNotificationRoutes, notificationBodyLimit} from "./notification-http.mjs";
import {createNotificationWorker} from "./notification-worker.mjs";
import {postmarkFromEnvironment} from "./email-adapters/postmark.mjs";

const search = createSearchStore({identity, transaction, product});            // product: "civic" | "charter"
const tokens = createNotificationTokens({key: Buffer.from(process.env.NOTIFICATION_TOKEN_KEY, "hex")});
const email = postmarkFromEnvironment(process.env);                              // null when POSTMARK_SERVER_TOKEN is absent
const notifications = createNotificationStore({identity, transaction, tokens, origin, email});
const notificationWorker = createNotificationWorker({transaction, store: notifications, email, origin});

// createAccountHandler({..., extensions: [..., createSearchRoutes({search}), createNotificationRoutes({notifications, origin})]})
// bodyLimit: Math.max(..., searchBodyLimit(path), notificationBodyLimit(path))
```

| Factory | Required | Optional (default) |
| --- | --- | --- |
| `createSearchStore` | `transaction`, `product`; `identity` for `/api/search` | — |
| `createNotificationTokens` | `key` (32-byte Buffer) | `clock` |
| `createNotificationStore` | `identity`, `transaction`, `tokens`, `origin` (HTTPS) | `email` (null), `links` (`defaultLinks(origin)`), `clock`, `maxSubscriptions` (500), `unsubscribeTtlMs` (60 d), `verificationTtlMs` (24 h), `verificationIntervalMs` (60 s) |
| `createNotificationWorker` | `transaction`, `store`, `origin` | `email` (null), `links`, `clock`, `fanOutBatch` (200), `deliveryGroups` (50), `digestLimit` (200), `maxAttempts` (8), `leaseMs` (300000), `digestHourUtc` (8), `digestWeekdayUtc` (1 = Monday), `onError` |
| `createPostmarkAdapter` | `serverToken`, `from` | `messageStream` ("outbound"), `fetch`, `endpoint`, `timeoutMs` (10000) |

`transaction` is the same runner the other stores use (one pooled connection, `dge_identity_runtime` privileges). Pass the **same** `email` adapter to the store and the worker. `onError` receives `EmailDeliveryError`-style objects with a `code`; it never receives addresses or message text. Any other provider can be added by implementing `{id, send({to, subject, text, headers, tag}) → Promise<{messageId}>}` that throws an error with `code` and `permanent` on failure.

`links` (both store and worker) controls URLs placed in emails: `{document(id), unsubscribe(token), verifyEmail(token)}`. The defaults are `${origin}/?document=<id>`, `${origin}/notifications/unsubscribe#<token>` and `${origin}/notifications/verify-email#<token>`. The two `/notifications/...` pages do not exist yet: serve `index.html` for them in `server/application.mjs` and mount the components below, or pass different `links`.

## Scheduling the worker

`notificationWorker.tick()` performs one fan-out pass (repeated until the backlog is drained) and one delivery pass and returns `{entries, queued, delivered, suppressed, failed, dead}`. It is safe to run concurrently and repeatedly. It depends on `ledger.tick()` (server/ledger.mjs) having sequenced events; run it after the ledger tick, e.g. every 30–60 seconds. No scheduler is added by this change.

## Routes

`GET /api/public/search`, `GET /api/search`, `/api/notifications/subscriptions[/:id]`, `/api/notifications/preferences`, `/api/notifications/email`, `/api/notifications/inbox`, `/api/notifications/inbox/read`, `/api/notifications/inbox/read-all`, `POST /api/public/notifications/unsubscribe`, `POST /api/public/notifications/email-verification`. Body limit 8192 bytes for all of them.

## Browser components

All components read strings through `useT()`, so render them inside `<I18nProvider locale={…}>` from `web/i18n-react.mjs`. `api` defaults to `createAccountAPI()`.

| Component | Props |
| --- | --- |
| `SearchPanel` (`web/search-panel.jsx`) | `api`, `scope` ("public" \| "member"), `workspaces` ([{tenantId}], member scope), `pageSize` (20), `linkFor(item)` |
| `NotificationCenter` (`web/notification-center.jsx`) | `api`, `documentLink(documentId)`; renders `NotificationInbox`, `NotificationPreferences`, `SubscriptionList` (each also exported, same props) inside a `<main>` |
| `FollowButton` | `api`, `targetKind`, `targetId`, `subscriptionId` (null), `onChange(subscription \| null)` |
| `UnsubscribeConfirmation` | `token` (read it from `location.hash`), `fetcher` (fetch) |
| `EmailVerification` | `token`, `fetcher` |
| `LanguagePicker` (`web/language-picker.jsx`) | `value`, `onChange(locale)`, `locales`, `id` |
| `I18nProvider` (`web/i18n-react.mjs`) | `locale`, `catalogs`, `onMissing`, `applyToDocument` |

`NotificationCenter`, `UnsubscribeConfirmation` and `EmailVerification` render their own `<main>`; mount them as page content, not inside another `<main>`.

## Environment variables

| Name | Meaning |
| --- | --- |
| `NOTIFICATION_TOKEN_KEY` | 64 lowercase hex characters (32 bytes), independent of `SESSION_KEY`/`OIDC_STATE_KEY`. Rotating it invalidates outstanding unsubscribe and verification links |
| `POSTMARK_SERVER_TOKEN` | Postmark server API token; absent means email is unavailable (preferences cannot enable email, nothing is sent) |
| `NOTIFICATION_EMAIL_FROM` | verified Postmark sender, e.g. `CivicQuill <notices@example.org>` |
| `POSTMARK_MESSAGE_STREAM` | optional transactional stream ID (default `outbound`) |

The digest hour and weekday are factory options, not environment variables.
