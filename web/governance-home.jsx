import React, {useEffect, useMemo, useState} from "react";
import {createAccountAPI} from "./account-api.mjs";
import {DiscussionPanel} from "./discussion-panel.jsx";
import {DecisionPanel} from "./decision-panel.jsx";

const api = createAccountAPI();
const messageFor = (error) => {
  if (error?.code === "AUTHENTICATION_REQUIRED") return "Sign in to open your workspaces.";
  if (error?.code === "ACCESS_DENIED") return "Your membership has changed. Refresh your workspaces.";
  if (error?.code === "SIGN_IN_AGAIN") return "Sign in again to continue.";
  return "The governance service could not complete this request. Retry when it is available.";
};
const preview = (value, length = 110) =>
  Array.from(String(value ?? "")).slice(0, length).join("");
const heading = (product) => product === "charter"
  ? {name:"CharterQuill",category:"ORGANIZATIONAL GOVERNANCE",description:"Review resolutions and amendments with a recorded, attributable deliberation history."}
  : {name:"CivicQuill",category:"PUBLIC LAWMAKING",description:"Develop legislation, propose exact language and discuss its merits with contributors."};

/** This screen consumes the actual account, document, proposal, and discussion services.
 * It never generates pretend organizations, votes, signatures, or source material.
 */
export function GovernanceHome() {
  const serviceEnabled = document.documentElement.dataset.accountEnabled === "true";
  const [authenticated,setAuthenticated] = useState(serviceEnabled ? null : false);
  const accountEnabled = authenticated === true;
  const product = document.documentElement.dataset.quillProduct === "charter" ? "charter" : "civic";
  const brand = heading(product);
  const [workspaces, setWorkspaces] = useState([]);
  const [workspaceId, setWorkspaceId] = useState("");
  const [documents, setDocuments] = useState([]);
  const [documentId, setDocumentId] = useState("");
  const [proposals, setProposals] = useState([]);
  const [proposalId, setProposalId] = useState("");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [message, setMessage] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [documentRefresh, setDocumentRefresh] = useState(0);
  const [proposalRefresh, setProposalRefresh] = useState(0);
  const [guestCursor, setGuestCursor] = useState(null);
  const [guestPrevious, setGuestPrevious] = useState([]);
  const [guestNextCursor, setGuestNextCursor] = useState(null);
  const activeWorkspace = workspaces.find(w => w.tenantId === workspaceId);
  const activeDocument = documents.find(d => d.id === documentId);
  const activeProposal = proposals.find(p => p.proposal.id === proposalId);
  const effectiveTenantId = activeDocument?.tenantId ?? workspaceId;
  const visibleDocuments = useMemo(
    () => documents.filter(d => String(d.title).toLocaleLowerCase().includes(search.toLocaleLowerCase())),
    [documents, search]
  );
  useEffect(()=>{
    if(!serviceEnabled)return;
    const abort=new AbortController();
    api("/api/session",{signal:abort.signal})
      .then(()=>{if(!abort.signal.aborted)setAuthenticated(true);})
      .catch(error=>{
        if(abort.signal.aborted)return;
        setAuthenticated(false);
        if(error.status!==401)setMessage("Account status could not be verified. Public reading may still be available.");
      });
    return()=>abort.abort();
  },[serviceEnabled]);
  useEffect(() => {
    document.title = brand.name + " — Governance workspaces";
    document.documentElement.style.setProperty("--accent", product === "charter" ? "#334a72" : "#275c49");
    if (!accountEnabled) return;
    const abort = new AbortController();
    setLoading(true);
    api("/api/workspaces?limit=100", {signal:abort.signal})
      .then(result => {
        setWorkspaces(result.items);
        setWorkspaceId(previous => result.items.some(w => w.tenantId === previous)
          ? previous : (result.items[0]?.tenantId ?? ""));
        if (result.nextCursor) setMessage("Showing the first 100 workspaces. Further pages are available in Account & workspaces.");
      })
      .catch(error => {if(error.name !== "AbortError") setMessage(messageFor(error));})
      .finally(() => {if(!abort.signal.aborted) setLoading(false);});
    return () => abort.abort();
  }, [product, refresh, accountEnabled]);
  useEffect(() => {
    if(authenticated!==false||!serviceEnabled) return;
    const abort=new AbortController();
    setLoading(true);setDocuments([]);setDocumentId("");setProposals([]);setProposalId("");
    const path="/api/public/documents?limit=40"+(guestCursor?"&after="+encodeURIComponent(guestCursor):"");
    api(path,{signal:abort.signal}).then(result=>{
      setDocuments(result.items);
      setGuestNextCursor(result.nextCursor);
      setDocumentId(result.items[0]?.id ?? "");
    }).catch(error=>{if(error.name!=="AbortError")setMessage("Public document directory is currently unavailable.");})
    .finally(()=>{if(!abort.signal.aborted)setLoading(false);});
    return()=>abort.abort();
  },[authenticated,serviceEnabled,guestCursor,documentRefresh]);
  useEffect(() => {
    const abort = new AbortController();
    setDocuments([]);
    setDocumentId("");
    setProposals([]);
    setProposalId("");
    if (!workspaceId || !accountEnabled) return () => abort.abort();
    setLoading(true);
    api("/api/workspaces/" + workspaceId + "/documents?limit=100", {signal:abort.signal})
      .then(result => {
        setDocuments(result.items);
        setDocumentId(result.items[0]?.id ?? "");
        if (result.nextCursor) setMessage("Showing the first 100 public documents in this workspace.");
      })
      .catch(error => {if(error.name !== "AbortError") setMessage(messageFor(error));})
      .finally(() => {if(!abort.signal.aborted) setLoading(false);});
    return () => abort.abort();
  }, [workspaceId, documentRefresh, accountEnabled]);
  useEffect(() => {
    const abort = new AbortController();
    setProposals([]);
    setProposalId("");
    if (!documentId) return () => abort.abort();
    api("/api/public/documents/" + documentId + "/proposals?limit=100", {signal:abort.signal})
      .then(result => {
        setProposals(result.items);
        setProposalId(result.items[0]?.proposal.id ?? "");
        if (result.nextCursor) setMessage("Showing the first 100 proposals. Open the document editor for paginated proposal history.");
      })
      .catch(error => {if(error.name !== "AbortError") setMessage(messageFor(error));});
    return () => abort.abort();
  }, [documentId, proposalRefresh]);
  async function createWorkspace() {
    if (creating || loading) return;
    setCreating(true);
    setMessage("");
    try {
      const result = await api("/api/workspaces", {method:"POST",body:{}});
      setWorkspaceId(result.tenantId);
      setRefresh(value => value + 1);
      setMessage("Workspace created. Public documents and proposals are published to everyone; do not submit private materials.");
    } catch (error) {setMessage(messageFor(error));}
    finally {setCreating(false);}
  }
  if(authenticated===null)return <main className="governance-empty" role="status">Checking your session and public directory…</main>;
  return <div className="governance-page">
    <header className="governance-navigation">
      <a className="governance-brand" href="/governance"><span aria-hidden="true">Q</span>{brand.name}</a>
      <nav aria-label="Primary"><a aria-current="page" href="/governance">Workspaces</a><a href="/">Document editor</a><a href="/account">Accounts & membership</a></nav>
    </header>
    <section className="governance-hero">
      <p className="eyebrow">{brand.category} / SHARED GOVERNANCE ENGINE</p>
      <h1>Decisions start with better language.</h1>
      <p>{brand.description}</p>
      <div className="governance-capabilities"><span>Versioned public documents</span><span>Exact text amendments</span><span>Evidence-led arguments</span><span>Member permissions</span></div>
    </section>
    <div className="governance-disclosure" role="note"><strong>Public collaboration release.</strong> All published source documents and proposals are public. Workspace-member voting and draft amendment application are recorded, but independently verified voter identity, legally executed resolutions, signatures, private organization storage, and blockchain finality have not been activated.</div>
    <div className="governance-body">
      {!serviceEnabled && <p className="governance-disclosure">The standalone file has no public database or account service. Use a configured hosted Quill service for collaboration.</p>}
      {accountEnabled ? <div className="governance-controls">
        <label htmlFor="governance-workspace">Your workspace
          <select id="governance-workspace" value={workspaceId} onChange={event => setWorkspaceId(event.target.value)} disabled={creating || loading}>
            {!workspaceId && <option value="">No workspaces yet</option>}
            {workspaces.map(w => <option value={w.tenantId} key={w.tenantId}>Workspace {w.tenantId.slice(0,8)} · {w.role}</option>)}
          </select>
        </label>
        <button disabled={creating || loading} onClick={createWorkspace}>Create workspace</button>
        <button disabled={creating || loading} onClick={() => {setMessage("");setRefresh(x=>x+1);setDocumentRefresh(x=>x+1);setProposalRefresh(x=>x+1);}}>Refresh records</button>
      </div> : <div className="governance-guest-bar"><strong>Browse public documents and amendments</strong><a href="/auth/start">Sign in to collaborate</a><button onClick={()=>setDocumentRefresh(n=>n+1)} disabled={loading}>Refresh public directory</button></div>}
      <p className="governance-message" aria-live="polite" role="status">{loading ? "Loading workspace records… " : ""}{message}</p>
      {!workspaceId && accountEnabled ? <div className="governance-empty"><h2>Build a governance workspace</h2><p>Create a workspace, publish a public document through the editor, and invite contributors through Accounts & membership.</p><a href="/account">Manage membership</a></div> :
      <div className="governance-columns">
        <section className="governance-column" aria-label="Workspace documents">
          <div className="governance-column-heading"><p className="eyebrow">01 / DOCUMENTS</p><h2>Working texts <span>{documents.length}</span></h2></div>
          <input aria-label="Filter documents" value={search} onChange={event=>setSearch(event.target.value)} placeholder="Search by title"/>
          <div className="governance-list">
            {visibleDocuments.map(d => <button type="button" key={d.id} aria-pressed={d.id===documentId} onClick={()=>setDocumentId(d.id)}>
              <strong>{d.title}</strong><small>Edition {d.version} · {d.mode==="public-input"?"Fixed for public input":"Collaboration draft"}</small>
            </button>)}
            {!visibleDocuments.length && <p className="governance-placeholder">No matching documents yet. Publish one from the editor.</p>}
          </div>
          {activeDocument && <a className="governance-action" href={"/?document="+encodeURIComponent(activeDocument.id)}>{accountEnabled ? "Read document and propose changes" : "Read public document"}</a>}
          {!accountEnabled && <div className="governance-pagination"><button disabled={!guestPrevious.length || loading} onClick={()=>{const prev=guestPrevious.at(-1);setGuestPrevious(items=>items.slice(0,-1));setGuestCursor(prev);}}>Previous page</button><button disabled={!guestNextCursor || loading} onClick={()=>{setGuestPrevious(items=>[...items,guestCursor]);setGuestCursor(guestNextCursor);}}>Next page</button></div>}
          <a className="governance-secondary" href="/">Open document editor</a>
        </section>
        <section className="governance-column" aria-label="Proposed amendments">
          <div className="governance-column-heading"><p className="eyebrow">02 / AMENDMENTS</p><h2>Proposed changes <span>{proposals.length}</span></h2></div>
          <p className="governance-explainer">Every proposed change binds to the exact text and source version. Suggestions do not silently rewrite the document.</p>
          <div className="governance-list">
            {proposals.map(p => <button type="button" key={p.proposal.id} aria-pressed={p.proposal.id===proposalId} onClick={()=>setProposalId(p.proposal.id)}>
              <strong>{preview(p.proposal.rationale)}</strong><small>{preview(p.proposal.selection.quote,65)} → {preview(p.proposal.replacement,65) || "(delete)"}</small><small>Source version {p.baseVersion}{p.stale?" · source updated":""}</small>
            </button>)}
            {!proposals.length && <p className="governance-placeholder">No proposed amendments. Select text in the saved document and use Suggest replacement.</p>}
          </div>
          <button onClick={()=>setProposalRefresh(x=>x+1)} disabled={!documentId}>Refresh amendments</button>
        </section>
        <section className="governance-column governance-column-debate" aria-label="Argument deliberation">
          <div className="governance-column-heading"><p className="eyebrow">03 / DELIBERATION</p><h2>Review the case</h2></div>
          {activeProposal && activeDocument ? <>
            <div className="governance-change">
              <p className="eyebrow">BEFORE</p><blockquote><del>{activeProposal.proposal.selection.quote}</del></blockquote>
              <p className="eyebrow">PROPOSED</p><blockquote><ins>{activeProposal.proposal.replacement || "(delete selected text)"}</ins></blockquote>
              <h3>Reason for the change</h3><p>{activeProposal.proposal.rationale}</p>
              <p className="governance-integrity">Integrity digest: <code>{activeProposal.digest}</code></p>
            </div>
            {accountEnabled ? <DecisionPanel key={"vote-"+activeProposal.proposal.id} tenantId={workspaceId}
              documentId={activeDocument.id} proposalId={activeProposal.proposal.id}
              role={activeWorkspace?.role} /> : <p className="governance-guest-voting">Voting requires membership in the proposal workspace. <a href="/auth/start">Sign in</a> to participate.</p>}
            <DiscussionPanel key={activeProposal.proposal.id}
              document={{id:activeDocument.id,tenantId:effectiveTenantId,mode:activeDocument.mode}}
              proposal={activeProposal.proposal}/>
          </> : <p className="governance-placeholder">Select an amendment to view its supporting arguments, objections, evidence, and threaded replies. Workspace contributors can participate using their signed-in accounts.</p>}
        </section>
      </div>}
      {activeWorkspace && <p className="governance-footer">Workspace role: {activeWorkspace.role}. This is an evidence-backed public collaboration surface, not an execution or adoption certificate.</p>}
    </div>
  </div>;
}
