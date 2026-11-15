import React, { useState } from "react";
import { verifyPackage } from "../src/verification-package.mjs";

const label = { verified: "Verified", failed: "Failed", limited: "Limited", unverified: "Not yet verifiable" };
const MAX_BYTES = 50_000_000;

/** Runs entirely in the browser; the package is never sent anywhere. */
export function VerifyPage() {
  const params = new URLSearchParams(window.location.search);
  const [documentId, setDocumentId] = useState(params.get("document") ?? "");
  const [logKey, setLogKey] = useState("");
  const [report, setReport] = useState(null);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  async function run(load) {
    setBusy(true); setReport(null); setStatus("Verifying…");
    try {
      const pkg = await load();
      const result = await verifyPackage(pkg, { trustedLogKeys: logKey.trim() ? [logKey.trim()] : [] });
      setReport(result);
      setStatus(result.overall === "failed" ? "Verification failed." : result.overall === "consistent" ? "The edition is consistent with the published log." : "Some evidence is not available yet.");
    } catch {
      setStatus("The file is not a readable Quill verification package.");
    } finally { setBusy(false); }
  }
  const fromFile = (file) => run(async () => {
    if (file.size > MAX_BYTES) throw Error("too large");
    return JSON.parse(await file.text());
  });
  const fromService = () => run(async () => {
    if (!/^[a-f0-9-]{36}$/.test(documentId)) throw Error("invalid id");
    const response = await fetch("/api/public/documents/" + documentId + "/verification-package", { cache: "no-store" });
    if (!response.ok) throw Error("unavailable");
    return response.json();
  });

  return (
    <section className="console-card" aria-labelledby="verify-heading">
      <h2 id="verify-heading">Check a published edition</h2>
      <p>Verification happens in this browser. It recomputes the document digest, the transparency-log inclusion proof, the checkpoint signature, witness countersignatures and any Bitcoin anchor proof. For the strongest result, download the package and also run <code>node scripts/quill-verify.mjs</code> with a block explorer you trust.</p>
      <div className="console-form">
        <label>Verification package file
          <input type="file" accept="application/json,.json" disabled={busy} onChange={(e) => e.target.files[0] && fromFile(e.target.files[0])} />
        </label>
        <label>Or a public document ID
          <input value={documentId} onChange={(e) => setDocumentId(e.target.value.trim())} placeholder="00000000-0000-0000-0000-000000000000" />
        </label>
        <button disabled={busy || !documentId} onClick={fromService}>Fetch and verify</button>
        <label>Pinned log public key (optional)
          <input value={logKey} onChange={(e) => setLogKey(e.target.value)} placeholder="Base64 Ed25519 key published by the operator" />
        </label>
      </div>
      <p role="status" aria-live="polite">{status}</p>
      {report && (
        <ol className="verification-checks">
          {report.checks.map((check, i) => (
            <li key={i} className={"check-" + check.state}>
              <strong>{label[check.state]}</strong> <span className="check-id">{check.id}</span>
              <p>{check.detail}</p>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
