import React, { useEffect, useState } from "react";
import { verifyCheckpoint } from "../src/transparency.mjs";

const anchorText = {
  pending: "Queued for submission",
  submitted: "Submitted; awaiting a Bitcoin block",
  confirmed: "In a Bitcoin block; awaiting finality depth",
  final: "Final in Bitcoin",
  failed: "Failed; will not be shown as anchored",
};

export function TransparencyPage() {
  const [latest, setLatest] = useState(null);
  const [anchors, setAnchors] = useState([]);
  const [signature, setSignature] = useState(null);
  const [message, setMessage] = useState("Loading the latest checkpoint…");
  useEffect(() => {
    const abort = new AbortController();
    Promise.all([
      fetch("/api/public/ledger/checkpoint", { signal: abort.signal }).then((r) => r.json()),
      fetch("/api/public/ledger/anchors?limit=20", { signal: abort.signal }).then((r) => r.json()),
    ]).then(async ([cp, anchorList]) => {
      setLatest(cp);
      setAnchors(anchorList.items ?? []);
      setMessage(cp.checkpoint ? "" : "No checkpoint has been issued yet.");
      if (cp.checkpoint) setSignature(await verifyCheckpoint(cp.checkpoint, cp.key.publicKey));
    }).catch((error) => { if (error.name !== "AbortError") setMessage("The transparency log is unavailable right now."); });
    return () => abort.abort();
  }, []);
  const cp = latest?.checkpoint;
  return (
    <>
      <p role="status" aria-live="polite">{message}</p>
      {latest && (
        <section className="console-card" aria-labelledby="log-key">
          <h2 id="log-key">Log identity</h2>
          <dl className="console-facts">
            <dt>Log</dt><dd>{latest.key.logId}</dd>
            <dt>Signing key (Ed25519)</dt><dd><code>{latest.key.publicKey}</code></dd>
            <dt>Key ID</dt><dd><code>{latest.key.keyId}</code></dd>
          </dl>
          <p>Pin this key from an independent source (for example the operator's published documentation) before trusting checkpoints.</p>
        </section>
      )}
      {cp && (
        <section className="console-card" aria-labelledby="latest-checkpoint">
          <h2 id="latest-checkpoint">Latest signed checkpoint</h2>
          <dl className="console-facts">
            <dt>Entries</dt><dd>{cp.body.size}</dd>
            <dt>Root hash</dt><dd><code>{cp.body.rootHash}</code></dd>
            <dt>Issued</dt><dd>{new Date(cp.body.issuedAt).toLocaleString()}</dd>
            <dt>Signature check in this browser</dt><dd>{signature === null ? "Checking…" : signature ? "Valid for the key above" : "INVALID"}</dd>
            <dt>Witness countersignatures</dt><dd>{cp.witnesses.length ? cp.witnesses.map((w) => w.name).join(", ") : "None yet"}</dd>
          </dl>
        </section>
      )}
      <section className="console-card" aria-labelledby="anchors">
        <h2 id="anchors">Public-chain anchors</h2>
        {anchors.length ? (
          <table className="console-table">
            <thead><tr><th scope="col">Log size</th><th scope="col">Reason</th><th scope="col">Status</th><th scope="col">Block</th></tr></thead>
            <tbody>
              {anchors.map((a) => (
                <tr key={a.id}>
                  <td>{a.size}</td><td>{a.reason}</td>
                  <td>{anchorText[a.status] ?? a.status}{a.lastError ? " (" + a.lastError + ")" : ""}</td>
                  <td>{a.blockHeight ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <p>No anchors have been scheduled yet. Anchoring runs periodically and immediately after finalization events.</p>}
      </section>
    </>
  );
}
