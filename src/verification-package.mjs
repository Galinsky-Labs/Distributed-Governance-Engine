// Independent verification of an exported public edition. Runs offline in
// browsers and Node without trusting the application UI: every claim is
// recomputed from the supplied bytes, and anything the package cannot prove
// is reported as limited or unverified rather than assumed.
import { digest } from "./integrity.mjs";
import { legalDocumentDigest } from "./legal-schema.mjs";
import {
  entryLeafHash, verifyInclusion, verifyCheckpoint, checkpointDigest, checkpointSigningInput, verifyEd25519, fromHex,
} from "./transparency.mjs";
import { parseDetachedTimestamp, attestations, verifyAgainstHeader } from "./opentimestamps.mjs";
import { verifyPublicDecisionReceipt } from "./decision-verification.mjs";

export const VERIFICATION_PACKAGE_SCHEMA = "quill-verification-package-v1";
const STATES = ["verified", "failed", "limited", "unverified"];

const base64ToBytes = (value) => Uint8Array.from(atob(value), (c) => c.charCodeAt(0));

/** Recomputes the transparency-log event digest of a public document version. */
export function documentVersionEventDigest(edition) {
  const restoration = edition.restoration ?? null;
  return digest(restoration ? "public-document-restoration-v1" : "public-document-version-v1", {
    tenantId: edition.tenantId, documentId: edition.documentId, version: edition.version,
    digest: edition.digest, previousDigest: edition.previousDigest ?? null, createdAt: edition.createdAt,
    ...(restoration ? { restoration } : {}),
  });
}

/**
 * @param pkg verification package as published by the service
 * @param trustedLogKeys optional pinned log public keys (base64); without a pin
 *   the signature only proves consistency with the key inside the package.
 * @param bitcoinHeader optional async (height) => merkle root hex in explorer
 *   order from a source the verifier trusts; without it anchors stay limited.
 */
export async function verifyPackage(pkg, { trustedLogKeys = [], bitcoinHeader = null } = {}) {
  const checks = [];
  const add = (id, state, detail) => { if (!STATES.includes(state)) throw Error("Invalid state"); checks.push({ id, state, detail }); };
  const attempt = async (id, fn) => {
    try { await fn(); } catch (error) { add(id, "failed", String(error?.message ?? error).slice(0, 200)); }
  };
  if (!pkg || pkg.schema !== VERIFICATION_PACKAGE_SCHEMA || typeof pkg.edition !== "object")
    return summarize([{ id: "format", state: "failed", detail: "Not a Quill verification package" }]);
  const { edition, ledger } = pkg;

  await attempt("content", async () => {
    const computed = legalDocumentDigest(edition.document);
    if (computed !== edition.digest) return add("content", "failed", "The document text does not match its published digest");
    if (edition.document.id !== edition.documentId || edition.document.tenantId !== edition.tenantId)
      return add("content", "failed", "The document identity does not match the package");
    add("content", "verified", "Document content matches digest " + computed);
  });

  const eventDigest = documentVersionEventDigest(edition);
  if (!ledger || ledger.status !== "included") {
    add("log-inclusion", "unverified", ledger?.status === "logged-awaiting-checkpoint"
      ? "The event is logged but no signed checkpoint covers it yet; download a newer package later"
      : "The event is not yet in the transparency log");
  } else {
    await attempt("log-inclusion", async () => {
      if (ledger.entry.eventDigest !== eventDigest) return add("log-inclusion", "failed", "The logged event does not describe this edition");
      const leaf = entryLeafHash({ kind: ledger.entry.kind, scope: ledger.entry.scope, subjectId: edition.documentId, eventDigest });
      const ok = leaf === ledger.entry.leafHash && verifyInclusion({
        leaf, index: ledger.entry.seq, treeSize: ledger.checkpoint.body.size, proof: ledger.proof, root: ledger.checkpoint.body.rootHash,
      });
      add("log-inclusion", ok ? "verified" : "failed", ok
        ? `Entry ${ledger.entry.seq} is included in log size ${ledger.checkpoint.body.size}`
        : "The inclusion proof does not reach the checkpoint root");
    });
    await attempt("checkpoint-signature", async () => {
      const key = ledger.key?.publicKey;
      const ok = await verifyCheckpoint(ledger.checkpoint, key);
      if (!ok) return add("checkpoint-signature", "failed", "The checkpoint signature is invalid");
      const pinned = trustedLogKeys.includes(key);
      add("checkpoint-signature", pinned ? "verified" : "limited", pinned
        ? "Signed by the pinned log key " + ledger.checkpoint.keyId
        : "Signature is valid for the key in this package; pin the operator's published key to rule out a substituted log");
    });
    await attempt("witnesses", async () => {
      const witnesses = ledger.checkpoint.witnesses ?? [];
      if (!witnesses.length) return add("witnesses", "limited", "No independent witness has countersigned this checkpoint");
      const input = checkpointSigningInput(ledger.checkpoint.body);
      const valid = [];
      for (const w of witnesses) if (await verifyEd25519(w.publicKey, w.signature, input)) valid.push(w.name);
      add("witnesses", valid.length === witnesses.length ? "verified" : "failed",
        `${valid.length} of ${witnesses.length} witness cosignatures are valid` + (valid.length ? ": " + valid.join(", ") : ""));
    });
    await attempt("anchor", async () => {
      const cpDigest = checkpointDigest(ledger.checkpoint.body);
      const anchors = (ledger.checkpoint.anchors ?? []).filter((a) => a.proof && a.provider === "opentimestamps-bitcoin");
      if (!anchors.length) return add("anchor", "unverified", "No public-chain anchor proof is available for this checkpoint yet");
      for (const anchor of anchors) {
        const detached = parseDetachedTimestamp(base64ToBytes(anchor.proof));
        if (detached.digest.length !== 32 || [...detached.digest].some((b, i) => b !== fromHex(cpDigest)[i]))
          return add("anchor", "failed", "The anchor proof commits to a different checkpoint");
        const bitcoin = attestations(detached).filter((a) => a.kind === "bitcoin" && a.message);
        if (!bitcoin.length) { add("anchor", "unverified", "Submitted to Bitcoin calendars; block attestation still pending"); continue; }
        if (!bitcoinHeader) {
          add("anchor", "limited", "Commits to Bitcoin block " + bitcoin.map((a) => a.height).join(", ") +
            ". Compare that block's merkle root with an explorer you trust, or run the command-line verifier with header lookup");
          continue;
        }
        for (const att of bitcoin) {
          const merkleRootHex = await bitcoinHeader(att.height);
          const ok = verifyAgainstHeader(detached, detached.digest, { height: att.height, merkleRootHex });
          add("anchor", ok ? "verified" : "failed", ok
            ? `Checkpoint is committed in Bitcoin block ${att.height} (header supplied by the verifier)`
            : `The proof does not match Bitcoin block ${att.height}`);
        }
      }
    });
  }

  for (const receipt of pkg.decisions ?? []) {
    const result = verifyPublicDecisionReceipt(receipt, { documentId: edition.documentId });
    add("decision:" + (receipt.proposalId ?? "unknown"), result.checksumValid ? "limited" : "failed",
      result.checksumValid ? "Decision certificate digest is internally consistent; " + result.limitation : result.limitation);
  }
  add("scope", "limited", "This proves what was published and when it was committed. It does not prove voters were honest, that every event was submitted, or that the text has legal effect.");
  return summarize(checks);
}

function summarize(checks) {
  const failed = checks.some((c) => c.state === "failed");
  const core = ["content", "log-inclusion", "checkpoint-signature"].every((id) => checks.find((c) => c.id === id)?.state !== "failed" && checks.some((c) => c.id === id));
  return { overall: failed ? "failed" : core ? "consistent" : "incomplete", checks };
}
