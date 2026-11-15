// DCE-038: the engine's HTTP surface as data. scripts/build-openapi.mjs turns
// this table into docs/sdk/openapi.json, and tests/http-contract.test.mjs
// sends every (method, path) to the real platform handler so the table cannot
// drift from the routes actually served. Auth values:
//   public        no session
//   session       session cookie (reads)
//   write         session cookie + exact Origin + x-dge-csrf header
//   signature     provider/peer signature over the raw body, no session
//   redirect      browser redirect flow
export const HTTP_CONTRACT_VERSION = "1.1.0";

const W = "/api/workspaces/{tenantId}";
const D = W + "/documents/{documentId}";
const P = D + "/proposals/{proposalId}";
const PD = "/api/public/documents/{documentId}";

/** [method, path, auth, tag, summary] */
export const ENGINE_ROUTES = Object.freeze([
  // Accounts and sessions
  ["GET", "/auth/start", "redirect", "accounts", "Start external OIDC sign-in"],
  ["GET", "/auth/callback", "redirect", "accounts", "Complete external OIDC sign-in"],
  ["POST", "/auth/passkey/register/options", "public", "accounts", "Passkey account creation options"],
  ["POST", "/auth/passkey/register/verify", "public", "accounts", "Create an account with a passkey"],
  ["POST", "/auth/passkey/login/options", "public", "accounts", "Passkey sign-in options"],
  ["POST", "/auth/passkey/login/verify", "public", "accounts", "Sign in with a passkey"],
  ["GET", "/api/session", "session", "accounts", "Current session"],
  ["POST", "/api/recovery-codes", "write", "accounts", "Issue recovery codes"],
  ["POST", "/api/recovery-session", "public", "accounts", "Start a restricted recovery session"],
  ["POST", "/api/passkeys/enrollment/options", "write", "accounts", "Passkey enrollment options"],
  ["POST", "/api/passkeys/enrollment/verify", "write", "accounts", "Enroll a passkey"],
  ["POST", "/api/passkeys/authentication/options", "write", "accounts", "Passkey step-up options"],
  ["POST", "/api/passkeys/authentication/verify", "write", "accounts", "Passkey step-up"],
  ["GET", "/api/passkeys", "session", "accounts", "List passkeys"],
  ["DELETE", "/api/passkeys/{credentialId}", "write", "accounts", "Revoke a passkey"],
  ["GET", "/api/devices", "session", "accounts", "List authorized devices"],
  ["POST", "/api/devices", "write", "accounts", "Authorize a device key"],
  ["DELETE", "/api/devices/{deviceId}", "write", "accounts", "Revoke a device"],
  ["POST", "/api/logout", "write", "accounts", "Sign out"],
  ["POST", "/api/logout-all", "write", "accounts", "Sign out everywhere"],
  ["GET", "/api/workspaces", "session", "workspaces", "List workspaces"],
  ["POST", "/api/workspaces", "write", "workspaces", "Create a workspace"],
  ["GET", W + "/members", "session", "workspaces", "List members"],
  ["PATCH", W + "/members/{accountId}", "write", "workspaces", "Change or remove a member"],
  ["GET", W + "/invitations", "session", "workspaces", "List invitations"],
  ["POST", W + "/invitations", "write", "workspaces", "Invite an account"],
  ["DELETE", W + "/invitations/{invitationId}", "write", "workspaces", "Revoke an invitation"],
  ["POST", W + "/join", "write", "workspaces", "Accept an invitation"],
  // Documents
  ["GET", W + "/documents", "session", "documents", "List workspace documents"],
  ["POST", W + "/documents", "write", "documents", "Create a document"],
  ["GET", D, "session", "documents", "Read a document"],
  ["PUT", D, "write", "documents", "Save a new public working revision"],
  ["POST", D + "/freeze-input", "write", "documents", "Freeze a draft as fixed public input"],
  ["POST", D + "/restore", "write", "documents", "Restore earlier content as a new revision"],
  ["GET", "/api/public/documents", "public", "documents", "Public document directory"],
  ["GET", PD, "public", "documents", "Read a public document"],
  ["GET", PD + "/history", "public", "documents", "Public revision history"],
  ["GET", PD + "/export", "public", "documents", "Export an exact edition"],
  ["GET", PD + "/read", "public", "documents", "Script-free reading page"],
  ["GET", PD + "/verification-package", "public", "verification", "Offline verification package"],
  // Proposals and discussion
    ["POST", D + "/proposals", "write", "proposals", "Propose exact replacement text"],
  ["GET", PD + "/proposals", "public", "proposals", "Public proposals"],
  ["GET", PD + "/proposals/{proposalId}", "public", "proposals", "Public proposal"],
    ["POST", P + "/points", "write", "discussion", "Add a pro/con point or reply"],
  ["GET", P + "/my-point-votes", "session", "discussion", "My point ratings"],
  ["PUT", P + "/point-votes/{pointId}", "write", "discussion", "Rate a point"],
  ["GET", PD + "/proposals/{proposalId}/points", "public", "discussion", "Public discussion (sort=top|new|confidence)"],
  ["GET", PD + "/proposals/{proposalId}/points/{pointId}/history", "public", "discussion", "Point revision and merge history"],
  ["POST", P + "/point-merges/{pointId}", "write", "discussion", "Merge a duplicate point (owner/admin)"],
  // Decisions
  ["GET", P + "/decision", "session", "decisions", "Decision state"],
  ["POST", P + "/decision", "write", "decisions", "Open a frozen decision (policySettings may set tieRule, castingPrincipalId, supportFloor)"],
  ["POST", P + "/decision/ballots", "write", "decisions", "Cast or change a ballot"],
  ["POST", P + "/decision/casting-vote", "write", "decisions", "Presiding member breaks an exact tie after voting ends"],
  ["POST", P + "/decision/close", "write", "decisions", "Close and certify"],
  ["POST", P + "/decision/finalize", "write", "decisions", "Finalize after the challenge window"],
  ["GET", P + "/decision/challenges", "session", "decisions", "List challenges"],
  ["POST", P + "/decision/challenges", "write", "decisions", "File a challenge"],
  ["POST", P + "/decision/challenges/{challengeId}/resolve", "write", "decisions", "Resolve a challenge"],
  ["GET", PD + "/proposals/{proposalId}/decision/receipt", "public", "decisions", "Public decision receipt"],
  // Electorates
  ["GET", W + "/rosters", "session", "electorates", "List rosters"],
  ["POST", W + "/rosters", "write", "electorates", "Create a roster"],
  ["GET", W + "/rosters/{rosterId}", "session", "electorates", "Read a roster"],
  ["POST", W + "/rosters/{rosterId}/entries", "write", "electorates", "Record a roster entry"],
  ["POST", W + "/rosters/{rosterId}/sync-membership", "write", "electorates", "Sync a membership roster"],
  ["POST", W + "/rosters/{rosterId}/snapshots", "write", "electorates", "Freeze a record-date snapshot"],
  ["GET", W + "/rosters/{rosterId}/snapshots/{snapshotId}", "session", "electorates", "Read a snapshot"],
  ["GET", W + "/proxies", "session", "electorates", "List proxies"],
  ["POST", W + "/proxies", "write", "electorates", "Grant a proxy"],
  ["POST", W + "/proxies/{grantId}/revoke", "write", "electorates", "Revoke a proxy"],
  // Moderation and clause permissions
  ["POST", W + "/reports", "write", "moderation", "Report content"],
  ["GET", W + "/moderation", "session", "moderation", "Moderation queue"],
  ["POST", W + "/moderation/actions", "write", "moderation", "Take a moderation action"],
  ["POST", W + "/moderation/appeals", "write", "moderation", "Appeal a moderation action"],
  ["GET", W + "/moderation/mine", "session", "moderation", "My moderation history"],
  ["POST", W + "/moderation/appeals/{appealId}/resolve", "write", "moderation", "Resolve an appeal"],
  ["GET", PD + "/moderation", "public", "moderation", "Public moderation log"],
  ["GET", D + "/section-grants", "session", "moderation", "Section grants"],
  ["POST", D + "/section-grants", "write", "moderation", "Grant section rights"],
  ["POST", D + "/section-grants/access", "write", "moderation", "Restrict or open section access"],
  ["POST", D + "/section-grants/{grantId}/revoke", "write", "moderation", "Revoke section rights"],
  // Editions and signatures
  ["GET", D + "/editions", "session", "editions", "List editions"],
  ["POST", D + "/editions", "write", "editions", "Record a final edition"],
  ["GET", "/api/public/editions", "public", "editions", "Public editions"],
  ["GET", "/api/public/editions/{editionId}", "public", "editions", "Public edition"],
  ["GET", W + "/editions/{editionId}/signatories", "session", "signatures", "Signatories"],
  ["POST", W + "/editions/{editionId}/intents", "write", "signatures", "Begin a signature"],
  ["POST", W + "/editions/{editionId}/signatures", "write", "signatures", "Sign an edition"],
  ["POST", W + "/editions/{editionId}/manifests", "write", "signatures", "Freeze a signature manifest"],
  ["GET", W + "/editions/{editionId}/signatures", "session", "signatures", "Signatures on an edition"],
  ["GET", "/api/public/editions/{editionId}/directory", "public", "signatures", "Public signer directory"],
  ["GET", "/api/public/editions/{editionId}/manifests", "public", "signatures", "Public signature manifests"],
  // Transparency log
  ["GET", "/api/public/ledger/checkpoint", "public", "ledger", "Latest signed checkpoint"],
  ["GET", "/api/public/ledger/checkpoints", "public", "ledger", "Checkpoint history"],
  ["GET", "/api/public/ledger/consistency", "public", "ledger", "Consistency proof"],
  ["GET", "/api/public/ledger/proof", "public", "ledger", "Inclusion proof"],
  ["GET", "/api/public/ledger/anchors", "public", "ledger", "External anchors"],
  ["POST", "/api/public/ledger/cosignatures", "signature", "ledger", "Witness cosignature (Ed25519-signed)"],
  ["POST", "/api/ledger/witnesses", "write", "ledger", "Register a witness key (platform admin)"],
  ["GET", "/api/public/ledger/subjects/{subjectId}/entries", "public", "ledger", "Entries for a subject"],
  // Settings, billing, search, notifications
  ["GET", "/api/settings", "session", "settings", "Platform settings"],
  ["POST", "/api/settings", "write", "settings", "Change platform or product settings"],
  ["POST", "/api/settings/simulate", "write", "settings", "Simulate a settings change"],
  ["POST", "/api/settings/rollback", "write", "settings", "Roll settings back"],
  ["GET", W + "/settings", "session", "settings", "Workspace settings"],
  ["POST", W + "/settings", "write", "settings", "Change workspace settings"],
  ["GET", W + "/settings/history", "session", "settings", "Settings history"],
  ["GET", "/api/entitlements", "session", "billing", "My entitlements"],
  ["GET", W + "/entitlements", "session", "billing", "Workspace entitlements"],
  ["POST", "/api/entitlements/grants", "write", "billing", "Create a grant (platform admin)"],
  ["GET", "/api/billing/checkout", "session", "billing", "Purchase options"],
  ["POST", "/api/billing/checkout", "write", "billing", "Start a checkout"],
  ["POST", "/api/billing/webhooks/{provider}", "signature", "billing", "Payment provider webhook"],
  ["GET", "/api/search", "session", "search", "Member search"],
  ["GET", "/api/public/search", "public", "search", "Public search"],
  ["GET", "/api/notifications/inbox", "session", "notifications", "Notification inbox"],
  ["GET", "/api/notifications/preferences", "session", "notifications", "Notification preferences"],
  ["GET", "/api/notifications/subscriptions", "session", "notifications", "Subscriptions"],
  // Private workspaces (ciphertext and public MLS material only)
  ["GET", W + "/private-devices", "session", "private", "Private devices"],
  ["POST", W + "/private-devices", "write", "private", "Register a private device"],
  ["POST", W + "/private-devices/{deviceId}/key-packages", "write", "private", "Publish MLS key packages"],
  ["POST", W + "/private-devices/{deviceId}/key-packages/claim", "write", "private", "Claim a key package"],
  ["GET", W + "/private-groups", "session", "private", "Private groups"],
  ["POST", W + "/private-groups", "write", "private", "Create a private group"],
  ["GET", W + "/private-groups/{groupId}", "session", "private", "Read a private group"],
  ["GET", W + "/private-groups/{groupId}/messages", "session", "private", "Handshake mailbox"],
  ["POST", W + "/private-groups/{groupId}/messages", "write", "private", "Post an MLS message"],
]);

const PARAM = /\{([a-zA-Z]+)\}/g;
const AUTH = {
  public: [], redirect: [], signature: [],
  session: [{ session: [] }], write: [{ session: [], csrf: [] }],
};

/** OpenAPI 3.1 document for the engine HTTP surface (deterministic). */
export function buildOpenApi(routes = ENGINE_ROUTES) {
  const paths = {};
  for (const [method, path, auth, tag, summary] of routes) {
    const params = [...path.matchAll(PARAM)].map((m) => ({ name: m[1], in: "path", required: true, schema: { type: "string" } }));
    const op = {
      tags: [tag], summary, operationId: (method.toLowerCase() + path.replace(/[{}]/g, "").replace(/[^a-zA-Z0-9]+/g, "_")).replace(/_+$/, ""),
      security: AUTH[auth], "x-dge-auth": auth,
      ...(params.length ? { parameters: params } : {}),
      ...(method !== "GET" && method !== "DELETE" ? { requestBody: { required: false, content: { "application/json": { schema: { type: "object" } } } } } : {}),
      responses: {
        200: { description: "Success" },
        400: { $ref: "#/components/responses/Error" }, 401: { $ref: "#/components/responses/Error" },
        403: { $ref: "#/components/responses/Error" }, 404: { $ref: "#/components/responses/Error" },
        409: { $ref: "#/components/responses/Error" }, 429: { $ref: "#/components/responses/Error" },
      },
    };
    (paths[path] ??= {})[method.toLowerCase()] = op;
  }
  return {
    openapi: "3.1.0",
    info: { title: "Distributed Governance Engine HTTP API", version: HTTP_CONTRACT_VERSION,
      description: "Generated from src/http-contract.mjs. Writes need the session cookie, the exact Origin and an x-dge-csrf header; errors are {\"error\": CODE}. Request bodies are strict: unknown fields are rejected." },
    components: {
      securitySchemes: {
        session: { type: "apiKey", in: "cookie", name: "__Host-dge_session" },
        csrf: { type: "apiKey", in: "header", name: "x-dge-csrf" },
      },
      responses: { Error: { description: "Stable error code", content: { "application/json": { schema: { type: "object", required: ["error"], properties: { error: { type: "string" } } } } } } },
    },
    paths,
  };
}
