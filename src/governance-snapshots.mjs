import {
  digest, identifier, integer, invariant, validDigest, canonicalize,
} from "./integrity.mjs";
import { validatePolicy, evaluateDecision } from "./governance.mjs";

function immutableCopy(value) {
  const copy = structuredClone(value);
  canonicalize(copy);
  const freeze = (node) => {
    if (node && typeof node === "object") {
      for (const item of Object.values(node)) freeze(item);
      Object.freeze(node);
    }
    return node;
  };
  return freeze(copy);
}
function checkElectorate(policy, electorate) {
  invariant(electorate?.kind === "frozen", "Only frozen electorates are supported");
  identifier(electorate.id);
  invariant(
    Array.isArray(electorate.members) && electorate.members.length > 0 &&
    electorate.members.length <= 100000,
    "Invalid electorate",
  );
  const seen = new Set();
  for (const member of electorate.members) {
    identifier(member.principalId);
    invariant(!seen.has(member.principalId), "Duplicate principal");
    seen.add(member.principalId);
    const weight = integer(member.weight, { positive: true });
    invariant(policy.weighting !== "equal" || weight === 1n,
      "Equal-person policies require unit weight");
    invariant(Object.keys(member).every(key => ["principalId", "weight"].includes(key)),
      "Unknown electorate credential field");
  }
}

/**
 * Reusable immutable decision binding. No authentication, persistence, ballot
 * authority, e-signature, legal effect or public-chain receipt is conferred.
 * The caller must verify eligibility and commit to the exact snapshot.
 */
export function createGovernanceSnapshot({
  id, tenantId, documentId, mode, proposalDigest, policy, electorate, createdAt,
}) {
  for (const value of [id, tenantId, documentId]) identifier(value);
  invariant(["collaboration", "public-input"].includes(mode), "Invalid mode");
  validDigest(proposalDigest);
  invariant(Number.isSafeInteger(createdAt) && createdAt >= 0, "Invalid createdAt");
  const fixedPolicy = immutableCopy(policy);
  validatePolicy(fixedPolicy);
  const fixedElectorate = immutableCopy(electorate);
  checkElectorate(fixedPolicy, fixedElectorate);
  const base = {
    schemaVersion: 1, id, tenantId, documentId, mode, proposalDigest,
    policy: fixedPolicy, policyDigest: digest("policy", fixedPolicy),
    electorate: fixedElectorate, electorateDigest: digest("electorate", fixedElectorate),
    createdAt,
  };
  return immutableCopy({
    ...base,
    snapshotDigest: digest("governance-snapshot-v1", base),
  });
}
export function validateGovernanceSnapshot(value) {
  invariant(value && typeof value === "object" && !Array.isArray(value),
    "Invalid governance snapshot");
  const allowed = [
    "schemaVersion", "id", "tenantId", "documentId", "mode", "proposalDigest",
    "policy", "policyDigest", "electorate", "electorateDigest",
    "createdAt", "snapshotDigest",
  ];
  invariant(value.schemaVersion === 1 &&
    Object.keys(value).length === allowed.length &&
    Object.keys(value).every(key => allowed.includes(key)),
  "Unexpected snapshot fields");
  const recreated = createGovernanceSnapshot(value);
  invariant(value.policyDigest === recreated.policyDigest &&
    value.electorateDigest === recreated.electorateDigest &&
    value.snapshotDigest === recreated.snapshotDigest,
  "Governance snapshot has been modified");
  return recreated;
}
export function ballotForGovernanceSnapshot(snapshot, principalId, choice, castAt) {
  const fixed = validateGovernanceSnapshot(snapshot);
  identifier(principalId);
  invariant(fixed.electorate.members.some(m => m.principalId === principalId),
    "Principal is not in the frozen electorate");
  invariant(["yes", "no", "abstain"].includes(choice), "Invalid ballot choice");
  invariant(Number.isSafeInteger(castAt) &&
    castAt >= fixed.policy.opensAt && castAt < fixed.policy.closesAt,
    "Ballot is outside the frozen voting window");
  return Object.freeze({
    principalId, choice, castAt, proposalDigest: fixed.proposalDigest,
    electorateId: fixed.electorate.id, electorateDigest: fixed.electorateDigest,
    policyId: fixed.policy.id, policyDigest: fixed.policyDigest,
  });
}
export function evaluateGovernanceSnapshot(snapshot, ballots, now) {
  const fixed = validateGovernanceSnapshot(snapshot);
  return evaluateDecision({
    mode: fixed.mode, policy: fixed.policy, electorate: fixed.electorate,
    proposalDigest: fixed.proposalDigest, ballots, now,
  });
}
