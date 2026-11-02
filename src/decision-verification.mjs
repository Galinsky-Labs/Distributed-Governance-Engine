import {digest,canonicalize,invariant,validDigest} from "./integrity.mjs";

/** Offline, deterministic checksum verification; not provenance/signature proof. */
export function verifyPublicDecisionReceipt(input,{documentId=null,proposalId=null}={}){
  try{
    invariant(input&&typeof input==="object"&&!Array.isArray(input),"Receipt must be a record");
    canonicalize(input);
    invariant(input.schemaVersion===1&&input.verification==="content-digest-only"&&
      input.externalAnchorVerified===false&&input.legallyExecuted===false,
      "Unsupported receipt format");
    invariant(Object.keys(input).sort().join(",")==="certificate,certificateDigest,documentId,externalAnchorVerified,legallyExecuted,proposalId,schemaVersion,verification",
      "Unexpected receipt fields");
    const certificate=input.certificate;
    invariant(certificate&&certificate.schemaVersion===1&&
      certificate.kind==="governance-decision-record-not-execution"&&
      certificate.executed===false&&certificate.canAdopt===false,
      "Unsupported decision certificate");
    invariant(typeof input.documentId==="string"&&input.documentId===certificate.documentId&&
      typeof input.proposalId==="string"&&input.proposalId===certificate.proposalId,
      "Receipt and certificate refer to different proposals");
    invariant(documentId===null||input.documentId===documentId,"Unexpected document");
    invariant(proposalId===null||input.proposalId===proposalId,"Unexpected proposal");
    invariant(validDigest(input.certificateDigest)===
      digest("governance-decision-certificate-v1",certificate),
      "Certificate digest mismatch");
    invariant(typeof certificate.closedAt==="string"&&Number.isFinite(Date.parse(certificate.closedAt)),
      "Malformed close time");
    invariant(["passed","failed","advisory"].includes(certificate.outcome?.status),
      "Invalid decision outcome");
    invariant(["applied-to-public-draft","stale-source","not-passed","advisory"].includes(certificate.application),
      "Invalid application state");
    return Object.freeze({
      checksumValid:true,documentId:input.documentId,proposalId:input.proposalId,
      certificateDigest:input.certificateDigest,
      appliedToDraft:certificate.application==="applied-to-public-draft",
      externalAnchorVerified:false,legallyExecuted:false,
      limitation:"Checksum only. Anyone can recompute a hash; verify origin and any independent transparency anchor separately."
    });
  }catch{
    return Object.freeze({checksumValid:false,externalAnchorVerified:false,legallyExecuted:false,
      limitation:"Receipt cannot be independently verified from the supplied data."});
  }
}
