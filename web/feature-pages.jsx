import React, { useEffect, useState } from "react";
import { createAccountAPI } from "./account-api.mjs";
import { SearchPanel } from "./search-panel.jsx";
import { NotificationCenter, UnsubscribeConfirmation, EmailVerification } from "./notification-center.jsx";
import { EditionsPanel } from "./editions-panel.jsx";
import { SignaturePanel } from "./signature-panel.jsx";
import { SignerDirectory } from "./signer-directory.jsx";
import { AdminConsole } from "./admin-console.jsx";
import { BillingPanel } from "./billing-panel.jsx";
import { ElectoratePanel } from "./electorate-panel.jsx";
import { ModerationPanel } from "./moderation-panel.jsx";
import { SectionGrantsPanel } from "./section-grants-panel.jsx";

const api = createAccountAPI();

function useSession() {
  const [state, setState] = useState({ checked: false, signedIn: false, workspaces: [] });
  useEffect(() => {
    api("/api/workspaces?limit=100")
      .then((r) => setState({ checked: true, signedIn: true, workspaces: r.items }))
      .catch(() => setState({ checked: true, signedIn: false, workspaces: [] }));
  }, []);
  return state;
}
const SignInPrompt = () => <p className="console-notice">Sign in to use this page. <a href="/auth/start">Sign in</a></p>;

export function SearchPage() {
  const session = useSession();
  const [scope, setScope] = useState("public");
  if (!session.checked) return <p role="status">Loading…</p>;
  return (
    <section className="console-card">
      {session.signedIn && (
        <fieldset className="console-fieldset"><legend>Search</legend>
          <label className="console-check"><input type="radio" name="scope" checked={scope === "public"} onChange={() => setScope("public")} /> All public documents</label>
          <label className="console-check"><input type="radio" name="scope" checked={scope === "member"} onChange={() => setScope("member")} /> My workspaces</label>
        </fieldset>
      )}
      <SearchPanel key={scope} scope={scope} workspaces={session.workspaces} />
      <p className="console-description">Private workspace documents are encrypted and never indexed by the server.</p>
    </section>
  );
}

export function NotificationsPage() {
  const session = useSession();
  if (!session.checked) return <p role="status">Loading…</p>;
  return session.signedIn ? <NotificationCenter /> : <SignInPrompt />;
}
export const UnsubscribePage = () => <UnsubscribeConfirmation token={window.location.hash.slice(1)} />;
export const VerifyEmailPage = () => <EmailVerification token={window.location.hash.slice(1)} />;

/** Freeze final editions, then collect support, approval or execution signatures. */
export function EditionsPage() {
  const session = useSession();
  const [tenantId, setTenantId] = useState("");
  const [documents, setDocuments] = useState([]);
  const [documentId, setDocumentId] = useState(new URLSearchParams(location.search).get("document") ?? "");
  const [edition, setEdition] = useState(null);
  useEffect(() => { if (session.workspaces[0] && !tenantId) setTenantId(session.workspaces[0].tenantId); }, [session]);
  useEffect(() => {
    if (!tenantId) return;
    api("/api/workspaces/" + tenantId + "/documents?limit=100").then((r) => { setDocuments(r.items); setDocumentId((d) => d || r.items[0]?.id || ""); }).catch(() => setDocuments([]));
  }, [tenantId]);
  if (!session.checked) return <p role="status">Loading…</p>;
  if (!session.signedIn) return <SignInPrompt />;
  const role = session.workspaces.find((w) => w.tenantId === tenantId)?.role;
  return (
    <>
      <section className="console-card">
        <div className="console-form">
          <label>Workspace<select value={tenantId} onChange={(e) => { setTenantId(e.target.value); setDocumentId(""); setEdition(null); }}>
            {session.workspaces.map((w) => <option key={w.tenantId} value={w.tenantId}>Workspace {w.tenantId.slice(0, 8)} · {w.role}</option>)}</select></label>
          <label>Document<select value={documentId} onChange={(e) => { setDocumentId(e.target.value); setEdition(null); }}>
            {documents.map((d) => <option key={d.id} value={d.id}>{d.title} · v{d.version}</option>)}</select></label>
        </div>
        <p className="console-notice">A support signature, an approval and a legal execution are different acts. A drawn or typed mark is a visual record, not proof of identity; execution requires your passkey.</p>
      </section>
      {tenantId && documentId && <section className="console-card"><EditionsPanel key={documentId} tenantId={tenantId} documentId={documentId} role={role} onSelect={setEdition} /></section>}
      {edition && (
        <>
          <section className="console-card"><SignaturePanel key={edition.id} tenantId={tenantId} editionId={edition.id} editionKind={edition.kind} /></section>
          <section className="console-card"><SignerDirectory editionId={edition.id} kind="support" /></section>
        </>
      )}
    </>
  );
}

export function SignersPage() {
  const params = new URLSearchParams(location.search);
  const editionId = params.get("edition") ?? "";
  const kind = ["support", "approval", "execution"].includes(params.get("kind")) ? params.get("kind") : "support";
  return /^[a-f0-9-]{36}$/.test(editionId)
    ? <section className="console-card"><SignerDirectory editionId={editionId} kind={kind} /></section>
    : <p className="console-notice">Open a signer directory from an edition's page.</p>;
}

/** Settings at platform, product, workspace or document scope; access is enforced server-side. */
export function AdminPage({ product }) {
  const session = useSession();
  const [scope, setScope] = useState("tenant");
  const [tenantId, setTenantId] = useState("");
  useEffect(() => { if (session.workspaces[0] && !tenantId) setTenantId(session.workspaces[0].tenantId); }, [session]);
  if (!session.checked) return <p role="status">Loading…</p>;
  if (!session.signedIn) return <SignInPrompt />;
  const target = scope === "platform" ? { scope } : scope === "product" ? { scope, product } : { scope: "tenant", tenantId };
  return (
    <>
      <section className="console-card">
        <div className="console-form">
          <label>Scope<select value={scope} onChange={(e) => setScope(e.target.value)}>
            <option value="tenant">This workspace</option><option value="product">Product defaults (platform administrators)</option><option value="platform">Platform (platform administrators)</option></select></label>
          {scope === "tenant" && <label>Workspace<select value={tenantId} onChange={(e) => setTenantId(e.target.value)}>{session.workspaces.map((w) => <option key={w.tenantId} value={w.tenantId}>Workspace {w.tenantId.slice(0, 8)} · {w.role}</option>)}</select></label>}
        </div>
        <p className="console-notice">Every change is validated, previewed and versioned. Invariants such as public anchoring, fixed public-input sources and frozen ballots cannot be turned off.</p>
      </section>
      {(scope !== "tenant" || tenantId) && <section className="console-card"><AdminConsole key={JSON.stringify(target)} target={target} /></section>}
    </>
  );
}
export function BillingPage() {
  const session = useSession();
  const [tenantId, setTenantId] = useState("");
  if (!session.checked) return <p role="status">Loading…</p>;
  if (!session.signedIn) return <SignInPrompt />;
  return (
    <section className="console-card">
      <p>Reading, discussing and voting are always free. Drafting new documents uses your weekly allowance, a subscription, credits or a granted exemption.</p>
      <div className="console-form"><label>Workspace balance (optional)<select value={tenantId} onChange={(e) => setTenantId(e.target.value)}>
        <option value="">My account</option>{session.workspaces.map((w) => <option key={w.tenantId} value={w.tenantId}>Workspace {w.tenantId.slice(0, 8)}</option>)}</select></label></div>
      <BillingPanel key={tenantId} tenantId={tenantId || undefined} />
    </section>
  );
}

function WorkspaceScoped({ render, needsDocument = false }) {
  const session = useSession();
  const [tenantId, setTenantId] = useState("");
  const [documents, setDocuments] = useState([]);
  const [documentId, setDocumentId] = useState("");
  useEffect(() => { if (session.workspaces[0] && !tenantId) setTenantId(session.workspaces[0].tenantId); }, [session]);
  useEffect(() => {
    if (!needsDocument || !tenantId) return;
    api("/api/workspaces/" + tenantId + "/documents?limit=100").then((r) => { setDocuments(r.items); setDocumentId(r.items[0]?.id ?? ""); }).catch(() => setDocuments([]));
  }, [tenantId]);
  if (!session.checked) return <p role="status">Loading…</p>;
  if (!session.signedIn) return <SignInPrompt />;
  const role = session.workspaces.find((w) => w.tenantId === tenantId)?.role;
  return (
    <>
      <section className="console-card"><div className="console-form">
        <label>Workspace<select value={tenantId} onChange={(e) => setTenantId(e.target.value)}>{session.workspaces.map((w) => <option key={w.tenantId} value={w.tenantId}>Workspace {w.tenantId.slice(0, 8)} · {w.role}</option>)}</select></label>
        {needsDocument && <label>Document<select value={documentId} onChange={(e) => setDocumentId(e.target.value)}>{documents.map((d) => <option key={d.id} value={d.id}>{d.title}</option>)}</select></label>}
      </div></section>
      {tenantId && (!needsDocument || documentId) && <section className="console-card">{render({ tenantId, role, documentId })}</section>}
    </>
  );
}
export const ElectoratesPage = () => <WorkspaceScoped render={({ tenantId, role }) => <ElectoratePanel key={tenantId} tenantId={tenantId} role={role} />} />;
export const ModerationPage = () => <WorkspaceScoped render={({ tenantId, role }) => <ModerationPanel key={tenantId} tenantId={tenantId} role={role} />} />;
export function ClauseAccessPage() {
  return <WorkspaceScoped needsDocument render={({ tenantId, role, documentId }) => <ClauseAccess key={documentId} tenantId={tenantId} role={role} documentId={documentId} />} />;
}
function ClauseAccess({ tenantId, role, documentId }) {
  const [sections, setSections] = useState([]);
  useEffect(() => {
    api("/api/workspaces/" + tenantId + "/documents/" + documentId).then((r) => {
      const found = [];
      const walk = (nodes) => { for (const n of nodes ?? []) { if (n.kind === "section") found.push({ id: n.id, title: n.title }); walk(n.children); } };
      walk(r.document.content);
      setSections(found);
    }).catch(() => setSections([]));
  }, [documentId]);
  return <SectionGrantsPanel tenantId={tenantId} documentId={documentId} role={role} sections={sections} />;
}
