# Private (end-to-end encrypted) workspaces — integration guide

Status: implemented and tested in this repository (unit, PGlite integration,
wasm-in-Node integration and one real-browser journey). **Not independently
reviewed, audited or certified**, and not an E2EESA conformance claim. Endpoint
compromise and recipient retention remain limitations (see the end).

## What it does

| Step | Endpoint (browser) | Service |
|---|---|---|
| Enroll a device | Creates an OpenMLS endpoint (Ed25519 signature key) inside Wasm; asks the account for a fresh **passkey assertion** (step-up); posts `SHA-256("dge-mls-signature-key-v1"‖0‖key)` to the existing `POST /api/devices` | `authorized_devices` row (refused for recovery sessions and without a passkey step-up in the last 5 minutes) |
| Publish public material | Publishes identity + signature key within 10 minutes of that authorization, then single-use key packages from the durable vault outbox | `dge_private.device_keys` (immutable; thumbprint must match the authorized device) and `dge_private.key_packages` (≤32 active per device, 30-day expiry, consumed exactly once) |
| Verify devices | Shows each device's **safety number** (12×5 digits from SHA-512 over identity and key). Members compare it out of band and press *Approve*. Pins live only in local IndexedDB | Directory of active workspace members' devices only |
| Create a private document | MLS group with opaque ID `SHA-256("dge-private-group-v1"‖tenant‖document)`; encrypts the initial snapshot | `dge_private.groups` (epoch 0, creator device) then the existing ciphertext store |
| Add a member | Claims one key package per device of the member (all must be approved), `add` → Commit+Welcome, posts them, merges only after the service accepted the commit, then **re-encrypts** the whole document for the new epoch | Ordered mailbox (`dge_private.group_messages`): one commit per epoch, idempotent command IDs, Welcome visible only to its recipient device |
| Join | Accepts the Welcome only if every roster device is approved locally (exact identity + key pins enforced inside the MLS endpoint) | — |
| Edit | Yjs updates sealed with the existing `sealPrivateYjsUpdate` codec; sent over the private WSS relay (HTTP fallback) | Existing update ledger (current epoch only) and private hub; never decrypts |
| Remove a member | Removal commit from an owner/admin or creator device, then re-encryption for the new epoch | Access for the removed device stops immediately; stale-epoch appends are refused until the rekey lands |

Content keys are **RFC 9420 MLS-Exporter** outputs of the current epoch
(`dge-private-snapshot-v1` and `dge-private-update-v1` labels, context bound to
tenant and document). The Wasm endpoint imports them directly into WebCrypto
as **non-extractable** AES-256-GCM keys (`BrowserEndpoint.exportKey`,
`coordinator.exportKey`). Snapshots use the existing
`encryptLocalDraftBytes` envelope (AAD binds tenant/document/epoch) and frames
the existing `private-collaboration-crypto` codec. No new cipher, key agreement,
signature or wire protocol is introduced. Per-epoch CryptoKeys are cached in
the browser's IndexedDB so a device can reload older epochs it was a member of.

## Mounting

Server (already done in this repository):

- `createPlatform({ ..., privateWorkspaces: true })` composes
  `createPrivateWorkspaceServices` (directory/group/mailbox store, the private
  document store and update ledger, all authorized by the MLS roster/epoch
  adapter) and mounts their routes. `services.privateWorkspace` exposes them.
- `server/runtime.mjs` reads **`PRIVATE_WORKSPACES`**: `enabled` turns the path
  on; unset or `disabled` leaves it off; any other value aborts startup. When
  enabled, `routeUpgrades(server)` splits WebSocket upgrades so the public hub
  owns `/ws/public/*` and the private hub owns `/ws/private/*`. In
  `TRANSPORT_MODE=edge-tls` the private hub accepts the declared managed-edge
  boundary (`x-forwarded-proto: https`), as `createEdgeServer` does for HTTP.
- The application then serves `/private`, `/private.js`, `/mls/quill_mls.js`
  and `/mls/quill_mls_bg.wasm` (`application/wasm`, ≤8 MB) and its CSP gains
  `'wasm-unsafe-eval'` in `script-src` only. `'unsafe-eval'` is never added.
- Migration `027-private-device-directory.sql` must be applied
  (`npm run migrate:identity`); startup refuses an older schema.
- `tests/support/account-fixture.mjs` enables private workspaces by default
  (`privateWorkspaces: false` opts out).

Product packages (CivicQuill/CharterQuill) mount the UI without editing
`web/app.jsx`:

```jsx
import {PrivateWorkspace} from '<engine checkout>/web/private-workspace.jsx'; // not a package export yet
<PrivateWorkspace api={createAccountAPI()} tenantId={tenantId} accountId={session.accountId}
  loadMls={async () => { const m = await import('/mls/quill_mls.js'); await m.default({module_or_path: '/mls/quill_mls_bg.wasm'}); return m; }}/>
```

Keep `/mls/*` external to the bundle (see `scripts/build-private-workspace.mjs`).
The engine also ships a standalone page (`web/private-main.jsx`,
`web/private.html`) served at `/private`.

## Build

```
npm run build                                  # existing app bundle (dist/app.js, app.css)
node scripts/build-private-workspace.mjs       # dist/private.js, dist/private.html
rustup toolchain install 1.94.0 --profile minimal --target wasm32-unknown-unknown
python3 scripts/install-mls-tools.py "$TOOLS"  # checksum-pinned wasm-bindgen 0.2.130
PATH="$TOOLS:$PATH" npm run build:mls          # dist/mls/quill_mls.js + quill_mls_bg.wasm
```

The `Dockerfile` runs the same steps: an `mls` stage (`rust:1.94.0-slim-bookworm`
plus the Node 24 binary and the pinned wasm-bindgen) builds `dist/mls`, the
build stage bundles the page, and the runtime image sets
`PRIVATE_WORKSPACES=enabled`. The image build was **not executed** in the
development environment (no Docker daemon); CI or the deploy pipeline must
build it once before relying on it.

## Tests

- `tests/private-workspace.test.mjs` (in `npm test`): step-up enrollment and
  key binding, recovery sessions refused, single-use/expiring/bounded key
  packages, mailbox ordering/replay/bounds/recipient scope/integrity,
  removal and revocation cutting access, stale-epoch writes blocked until
  rekey, cross-tenant isolation (including RLS), flag/CSP/route mounting, and
  a ciphertext canary scan of every table.
- `tests/private-workspace-mls.test.mjs` (in `npm test`; **skipped with an
  explicit reason if `dist/mls` is not built**): the real compiled OpenMLS Wasm
  and vault coordinator in Node, production routes and the TLS 1.3 relay. Covers
  mutual safety-number approval, convergence, new-device and substituted-key
  warnings, removal → no new-epoch key and old keys failing on new frames, and
  canaries absent from all tables, captured logs and every relay frame.
- `tests/private-workspace.browser.mjs` (`npm run test:browser`): two isolated
  Chrome profiles with virtual passkeys run enroll → create → approve → add →
  both edit and converge → remove → the removed browser cannot decrypt.
- `crypto/mls-endpoint/tests/protocol.rs`: exporter agreement, label/context
  separation, rotation on add/remove, evicted endpoint cannot export.

## Limitations (precise)

- **Endpoint compromise**: a malicious or compromised authorized device,
  browser profile, extension or served JavaScript/Wasm can read plaintext and
  keys. The service serves the client code; a malicious service update is not
  prevented (no code transparency or pinned client).
- **Recipient retention**: removal only stops access to *new* epochs. A removed
  member keeps what they already decrypted, and their browser keeps the epoch
  keys it had. There is no recall.
- **Sender authenticity of edits**: Yjs frames are AES-GCM under the shared
  epoch key, so any current member device can forge a frame claiming another
  member's device ID. The relay only checks the claimed sender is in the roster.
  MLS authenticates membership changes, not individual Yjs edits.
- **Service-side metadata and availability**: the service sees accounts,
  device IDs, document IDs, rosters, epochs, timing and sizes; it can withhold,
  delay or reorder delivery, and can roll back a snapshot to an older version
  of the same epoch (clients do not yet track a high-water mark across reloads).
  Service authorization is defence in depth below MLS, not the confidentiality
  boundary.
- **Trust on first approval**: safety numbers protect only if members actually
  compare them out of band. Pins are local to one browser profile; another
  browser starts without pins.
- **Device scope**: one MLS endpoint per (workspace, account, browser profile);
  at most 32 private documents per enrolled endpoint (Wasm limit). The local
  vault wrapping key is a non-extractable WebCrypto key in IndexedDB, not
  hardware-bound or passkey-PRF-derived; whole-profile rollback is undetected.
- **Membership operations**: one device per commit; a document with N member
  devices added costs N commits. Concurrent admins may receive
  `MEMBERSHIP_CHANGE_CONFLICT`; the losing endpoint's pending commit cannot be
  discarded through the current Wasm API, and recovery of that endpoint's group
  from this state is untested. A removed device can never be re-added; enroll a new device.
- **New members** see only the state re-encrypted for the epoch they joined,
  not earlier frame history. Snapshots are whole-document; very large
  documents (>2.9 MB ciphertext) are refused.
- **Key package availability**: any owner/admin/editor of a shared workspace can
  claim (consume) another member's published key packages, so a malicious member
  can temporarily block that member's admission until their client replenishes
  packages (it tops up to 6 whenever the private page opens). Confidentiality is
  unaffected: a claimed package only admits the device whose approved key signed it.
- **Realtime fanout** is per instance; clients poll the ledger and mailbox
  every 2 s as the authority. Two clients behind one IP share the existing
  per-peer request budget.
- **Not done**: attachments, private proposals/discussion/votes, export,
  search, cross-device pin sync, backup/recovery of private keys (none exists by
  design: losing every enrolled device loses access), independent review.
