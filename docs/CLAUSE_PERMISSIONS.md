# Clause-level permissions and selective unlocks

Unit: DCE-018. Schema: `dge_moderation.section_access`, `section_grants`, `access_events` in `migrations/022-moderation-and-clause-permissions.sql`. Code: `server/section-grants.mjs`, `server/section-grants-http.mjs`, `web/section-grants-panel.jsx`.

## Model

A grant targets one section of a document: a `section` or `exhibit` node ID, or the document ID for the whole document. It names:

- **grantee**: a workspace role (`owner|admin|editor|participant|viewer`), an account, or a roster class (`{rosterId,class}`: any principal with a current, valid, non-zero entry of that class);
- **rights**: a non-empty subset of `read`, `propose`, `discuss`, `vote`, `sign`;
- **effect**: `allow` (an unlock) or `deny`;
- optional **expiry**; grants can be revoked once. Every grant, revocation and restriction change is an append-only audit event.

The first grant marks the document **restricted**. While restricted:

1. A right on a target exists only if an active `allow` grant for that right applies to the actor on the target node or any ancestor, and no active `deny` for that right applies on the target or any ancestor. Allows are inherited downward; a deny on an ancestor overrides every allow beneath it; a grant on a nested section never opens its parent.
2. Revoked and expired grants are ignored, so an expired unlock falls back to **deny**; the document does not become open again. Lifting restriction is an explicit, versioned manager action (`POST …/section-grants/access` with `expectedVersion`), and grants stay on record.
3. Workspace roles still apply on top: a viewer cannot propose even with a `propose` grant.

## Enforcement

Checks run inside the same transaction as the operation, in the stores:

| Operation | Store | Right on the proposal's target section |
| --- | --- | --- |
| Create a text proposal | `proposal-store.create` | `propose` (target block in the base edition) |
| Create a discussion point, vote on a point | `discussion-store.create/vote` | `discuss`; `mine().canContribute` reflects it |
| Open a decision (v1 and v2) | `decision-store.open` | `vote`: principals without it on every targeted section are removed from the frozen electorate and counted as `no-section-vote-right` |

Owners and admins administer grants (recent authentication required) but are not exempt from them: a restricted clause binds every role, and a manager who needs a right must grant it explicitly, which is audited.

## API

- `GET /api/workspaces/{t}/documents/{d}/section-grants` — `{restricted, version, mine:[{sectionId, rights}]}` for everyone; managers also get `grants`.
- `POST …/section-grants` — `{sectionId, grantee, rights, effect?, expiresAt?, commandId}`.
- `POST …/section-grants/{grantId}/revoke` — `{commandId}`.
- `POST …/section-grants/access` — `{restricted, expectedVersion, commandId}`.

## Limits

- `read` and `sign` are stored and reported by `mine`, but this branch enforces `propose`, `discuss` and `vote` only. Public documents are published under the public disclosure contract, so a `read` restriction cannot hide them; private documents and signing workflows (DCE-003, migration 023) must call `sectionAccess` themselves. Search, export, notification and realtime-room paths are owned by other units and do not yet consult grants.
- Grants reference stable node IDs. If a section is deleted, its grants stop matching anything; if text is moved into another section, the new location's grants apply.
- Section paths for proposals are computed from the proposal's base edition, which is the text the proposal and its vote are bound to.
