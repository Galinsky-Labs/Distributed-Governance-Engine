import React, { useEffect, useRef, useState } from "react";
import { createAccountAPI, readInvitationPackage, recoverWithCode } from "./account-api.mjs";
import { InvitationControls } from "./invitations.jsx";
import { PasskeyControls } from "./passkey-controls.jsx";

const messages = {
  RECOVERY_NOT_ACCEPTED: "Recovery could not be completed. Check your account ID and unused recovery code.",
  PASSKEY_STEP_UP_REQUIRED: "Verify with your previously enrolled passkey before restoring sign-in.",
  PROVIDER_RESTORATION_UNAVAILABLE: "Provider restoration is unavailable. Try again later.",
  ERROR_CEREMONY_ABORTED: "Passkey verification was cancelled. You can try again.",
  ERROR_INVALID_DOMAIN: "Passkeys require this service to use a valid HTTPS hostname.",
  ERROR_INVALID_RP_ID: "Passkeys are not configured for this hostname.",
  PASSKEY_VERIFIER_UNAVAILABLE: "Passkeys are not configured for this service yet.",
  PASSKEY_ATTESTATION_POLICY_REJECTED: "This authenticator is not allowed by the service's passkey policy.",
  PASSKEY_VERIFICATION_FAILED: "Passkey verification failed. Try again with an enrolled passkey.",
  PASSKEY_NOT_ENROLLED: "Add a passkey before using passkey verification.",
  AUTHENTICATION_REQUIRED: "Sign in to continue.",
  REAUTHENTICATION_REQUIRED: "Sign in again before changing workspace access.",
  STEP_UP_REQUIRED: "Sign in with multifactor authentication before issuing recovery codes.",
  SIGN_IN_AGAIN: "Sign in again to restore request protection.",
  ACCESS_DENIED:
    "This change is not permitted. A workspace must retain an owner.",
  RATE_LIMITED: "Too many requests. Wait a minute and try again.",
  WORKSPACE_LIMIT_REACHED: "Your account has reached its workspace limit.",
  INVITATION_LIMIT_REACHED:
    "This workspace has reached its pending invitation limit. Cancel unused invitations first.",
  SERVICE_UNAVAILABLE: "The account service is temporarily unavailable.",
  INVITATION_ALREADY_USED:
    "This invitation has already been accepted. Remove the member to revoke workspace access.",
};
const api = createAccountAPI();
function Member({ member, authority, perform, workspace, busy }) {
  const [role, setRole] = useState(member.role);
  useEffect(() => setRole(member.role), [member.role]);
  const canManage =
    authority === "owner" ||
    (authority === "admin" && !["owner", "admin"].includes(member.role));
  return (
    <li className="member-row">
      <code>{member.accountId}</code>
      <label>
        Role for {member.accountId.slice(0, 8)}
        <select
          value={role}
          disabled={!canManage || busy}
          onChange={(e) => setRole(e.target.value)}
        >
          {[
            "viewer",
            "participant",
            "editor",
            ...(authority === "owner" ? ["admin", "owner"] : []),
          ].map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
          {!canManage &&
            ["owner", "admin"].includes(role) &&
            authority !== "owner" && <option value={role}>{role}</option>}
        </select>
      </label>
      <button
        disabled={!canManage || busy}
        onClick={() =>
          perform(
            () =>
              api(`/api/workspaces/${workspace}/members/${member.accountId}`, {
                method: "PATCH",
                body: { role },
              }),
            "Role updated.",
          )
        }
      >
        Save role
      </button>
      <button
        disabled={!canManage || busy}
        onClick={() =>
          perform(
            () =>
              api(`/api/workspaces/${workspace}/members/${member.accountId}`, {
                method: "PATCH",
                body: { role: null },
              }),
            "Member removed.",
          )
        }
      >
        Remove member
      </button>
    </li>
  );
}

function RecoveryForm({perform, busy, recovered}) {
  const [accountId, setAccountId] = useState(''), [code, setCode] = useState('');
  return <details onToggle={e => {if (!e.currentTarget.open) setCode('');}}>
    <summary>Use a recovery code</summary>
    <p>Use your saved account ID and one-time recovery code for limited access.
      Restoring sign-in also requires a passkey enrolled before you lost access.</p>
    <form autoComplete="off" onSubmit={e => {
      e.preventDefault();
      const submittedCode = code; setCode('');
      perform(async () => {await recoverWithCode(accountId.trim(), submittedCode.trim()); await recovered();}, 'Limited recovery access restored.');
    }}>
      <label>Recovery account ID<input name="recoveryAccountId" value={accountId} onChange={e => setAccountId(e.target.value)} required maxLength={36} /></label>
      <label>One-time recovery code<input name="recoveryCode" type="password" autoComplete="off" value={code} onChange={e => setCode(e.target.value)} required maxLength={43} /></label>
      <button disabled={busy}>Recover limited access</button>
    </form>
  </details>;
}
function ProviderRestorationControls({perform, busy, session}) {
  return <section aria-label="Restore provider sign-in">
    <h3>Restore sign-in</h3>
    <p>This temporary session cannot open workspace documents, change membership or enroll a new passkey.
      Verify with a previously enrolled passkey, then sign in with the provider account
      you want to bind to this account. This replaces your previous sign-in binding.</p>
    <button disabled={busy || !session.passkeyStepUpExpiresAt} onClick={() => perform(async () => {
      const {authorizationUrl} = await api('/api/provider-restoration', {method: 'POST', body: {}});
      const destination = new URL(authorizationUrl);
      if (destination.protocol !== 'https:' || destination.username || destination.password) throw Error('Invalid provider destination');
      location.assign(destination.href);
    }, 'Opening provider sign-in…', {refresh: false})}>Restore provider sign-in</button>
  </section>;
}

export function AccountPanel() {
  const [open, setOpen] = useState(location.pathname === "/account"),
    [session, setSession] = useState(null),
    [workspaces, setWorkspaces] = useState([]),
    [workspaceCursor, setWorkspaceCursor] = useState(null),
    [selected, setSelected] = useState(""),
    [memberPage, setMemberPage] = useState({
      tenantId: "",
      items: [],
      nextCursor: null,
    }),
    [busy, setBusy] = useState(false),
    [status, setStatus] = useState(
      new URLSearchParams(location.search).get("login") === "failed"
        ? "Sign-in could not be completed. Try again."
        : "",
    ),
    [reload, setReload] = useState(0),
    [joinCode, setJoinCode] = useState(""),
    [recoveryCodes, setRecoveryCodes] = useState([]);
  const heading = useRef(null),
    trigger = useRef(null),
    alive = useRef(true),
    codeEpoch = useRef(0);
  const clearCodes = () => {
    codeEpoch.current++;
    setRecoveryCodes([]);
  };
  const forget = () => {
    setSession(null);
    setWorkspaces([]);
    setSelected("");
    setMemberPage({ tenantId: "", items: [], nextCursor: null });
    setJoinCode("");
    clearCodes();
  };
  function report(error) {
    if (error.status === 401) forget();
    setStatus(
      messages[error.code] ??
        "The request could not be completed. Check the details and try again.",
    );
  }
  async function load() {
    try {
      const who = await api("/api/session"),
        page = who.recoveryRestricted ? {items: [], nextCursor: null} : await api("/api/workspaces");
      if (!alive.current) return;
      setSession(who);
      setWorkspaces(page.items);
      setWorkspaceCursor(page.nextCursor);
      setSelected((old) =>
        page.items.some((x) => x.tenantId === old)
          ? old
          : (page.items[0]?.tenantId ?? ""),
      );
    } catch (error) {
      if (alive.current) {if (error.status === 401) forget(); else report(error);}
    }
  }
  async function perform(action, message, { refresh = true } = {}) {
    if (busy) return;
    setBusy(true);
    setStatus("Working…");
    try {
      await action();
      if (alive.current) {
        if (refresh) { await load(); setReload((x) => x + 1); }
        if (alive.current) setStatus(message);
      }
    } catch (error) {
      if (alive.current) report(error);
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  useEffect(() => {
    alive.current = true;
    load();
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (!open) {
      clearCodes();
      return;
    }
    heading.current?.focus();
    const key = (e) => {
      if (e.key === "Escape") {
        setOpen(false);
        clearCodes();
        trigger.current?.focus();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [open]);
  useEffect(() => {
    if (!session || session.recoveryRestricted || !selected) {
      setMemberPage({ tenantId: "", items: [], nextCursor: null });
      return;
    }
    setMemberPage((old) =>
      old.tenantId === selected
        ? old
        : { tenantId: selected, items: [], nextCursor: null },
    );
    const abort = new AbortController();
    api(`/api/workspaces/${selected}/members`, { signal: abort.signal })
      .then((page) => setMemberPage({ tenantId: selected, ...page }))
      .catch((error) => {
        if (!abort.signal.aborted) {
          if (error.code === "ACCESS_DENIED") {
            setSelected("");
            setWorkspaces((old) => old.filter((x) => x.tenantId !== selected));
          }
          report(error);
        }
      });
    return () => abort.abort();
  }, [selected, reload, session?.accountId, session?.recoveryRestricted]);
  const authority =
    memberPage.tenantId === selected ? memberPage.viewerRole : null;
  const members = memberPage.tenantId === selected ? memberPage.items : [];
  useEffect(() => {
    const close = () => setOpen(false);
    window.addEventListener("quill-open-documents", close);
    return () => window.removeEventListener("quill-open-documents", close);
  }, []);
  return (
    <>
      <button
        ref={trigger}
        aria-expanded={open}
        onClick={() => setOpen((x) => !x)}
      >
        Account &amp; workspaces
      </button>
      {open && (
        <aside className="account-panel" aria-labelledby="account-title">
          <div className="account-title">
            <h2 id="account-title" ref={heading} tabIndex={-1}>
              Your account
            </h2>
            <button
              onClick={() => {
                setOpen(false);
                clearCodes();
                trigger.current?.focus();
              }}
            >
              Close account panel
            </button>
          </div>
          <p role="status">{status}</p>
          {!session ? (
            <>
              <p>
                Sign in to create a workspace or join one you have been invited
                to.
              </p>
              <a className="button-link" href="/auth/start">
                Sign in
              </a>
              <RecoveryForm perform={perform} busy={busy} recovered={load} />
            </>
          ) : (
            <>
              <p>Your account ID</p>
              <code className="account-id">{session.accountId}</code>
              <p className="small">
                A workspace owner can use this ID to invite you.
              </p>
              {!session.recoveryRestricted && <p>
                <a href="/auth/start">Sign in again for access changes</a>
              </p>}
              <PasskeyControls api={api} session={session} perform={perform} busy={busy} reload={reload} />
              {session.recoveryRestricted ? <>
                <ProviderRestorationControls perform={perform} busy={busy} session={session} />
                <button disabled={busy} onClick={() => perform(async () => {
                  await api('/api/logout', {method: 'POST', body: {}}); forget();
                }, 'Signed out.')}>Sign out</button>
              </> : <>
              <p className="small">
                Issuing recovery codes invalidates any unused codes from an earlier set.
                Save your account ID and the new codes offline before closing this panel.
              </p>
              <div className="account-actions">
                <button
                  disabled={busy || recoveryCodes.length > 0}
                  onClick={() =>
                    perform(async () => {
                      const requestEpoch = codeEpoch.current;
                      const result = await api("/api/recovery-codes", {
                        method: "POST",
                        body: {},
                      });
                      if (alive.current && codeEpoch.current === requestEpoch)
                        setRecoveryCodes(result.recoveryCodes);
                    }, "Recovery codes issued. Save them outside this application now.", {
                      refresh: false,
                    })
                  }
                >
                  Issue recovery codes
                </button>
                <button
                  disabled={busy}
                  onClick={() =>
                    perform(async () => {
                      await api("/api/logout", { method: "POST", body: {} });
                      forget();
                    }, "Signed out.")
                  }
                >
                  Sign out
                </button>
                <button
                  disabled={busy}
                  onClick={() =>
                    perform(async () => {
                      await api("/api/logout-all", {
                        method: "POST",
                        body: {},
                      });
                      forget();
                    }, "All sessions signed out.")
                  }
                >
                  Sign out everywhere
                </button>
                <button
                  disabled={busy}
                  onClick={() =>
                    perform(async () => {
                      const result = await api("/api/workspaces", {
                        method: "POST",
                        body: {},
                      });
                      setWorkspaces((old) => [
                        { tenantId: result.tenantId, role: "owner" },
                        ...old,
                      ]);
                      setSelected(result.tenantId);
                    }, "Workspace created.")
                  }
                >
                  Create workspace
                </button>
              </div>
              {recoveryCodes.length > 0 && (
                <section aria-label="One-time recovery codes">
                  <p>
                    Save your account ID above and these one-time codes offline. They will disappear when you
                    close this panel, and they cannot authorize an encrypted device.
                  </p>
                  <ol className="recovery-codes">
                    {recoveryCodes.map((code) => (
                      <li key={code}><code>{code}</code></li>
                    ))}
                  </ol>
                  <button onClick={clearCodes}>Clear recovery codes</button>
                </section>
              )}
              <label>
                Your workspace
                <select
                  aria-label="Your workspace"
                  disabled={busy}
                  value={selected}
                  onChange={(e) => setSelected(e.target.value)}
                >
                  <option value="">Choose a workspace</option>
                  {workspaces.map((room) => (
                    <option value={room.tenantId} key={room.tenantId}>
                      Workspace {room.tenantId.slice(0, 8)} · {room.role}
                    </option>
                  ))}
                </select>
              </label>
              {workspaceCursor && (
                <button
                  disabled={busy}
                  onClick={() =>
                    perform(
                      async () => {
                        const page = await api(
                          "/api/workspaces?after=" + workspaceCursor,
                        );
                        setWorkspaces((old) => [
                          ...old,
                          ...page.items.filter(
                            (x) => !old.some((y) => y.tenantId === x.tenantId),
                          ),
                        ]);
                        setWorkspaceCursor(page.nextCursor);
                      },
                      "More workspaces loaded.",
                      { refresh: false },
                    )
                  }
                >
                  Load more workspaces
                </button>
              )}
              {selected && (
                <section>
                  <h3>Workspace members</h3>
                  <p className="small">
                    Workspace ID: <code>{selected}</code>
                  </p>
                  <ul className="member-list">
                    {members.map((member) => (
                      <Member
                        key={member.accountId}
                        member={member}
                        authority={authority}
                        workspace={selected}
                        perform={perform}
                        busy={busy}
                      />
                    ))}
                  </ul>
                  {memberPage.tenantId === selected &&
                    memberPage.nextCursor && (
                      <button
                        disabled={busy}
                        onClick={() =>
                          perform(
                            async () => {
                              const page = await api(
                                `/api/workspaces/${selected}/members?after=${memberPage.nextCursor}`,
                              );
                              setMemberPage((old) =>
                                old.tenantId === selected
                                  ? {
                                      tenantId: selected,
                                      ...old,
                                      items: [...old.items, ...page.items],
                                      nextCursor: page.nextCursor,
                                    }
                                  : old,
                              );
                            },
                            "More members loaded.",
                            { refresh: false },
                          )
                        }
                      >
                        Load more members
                      </button>
                    )}
                  {["owner", "admin"].includes(authority) && (
                    <InvitationControls
                      key={selected}
                      workspace={selected}
                      authority={authority}
                      perform={perform}
                      busy={busy}
                      refresh={reload}
                      report={report}
                    />
                  )}
                </section>
              )}
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  perform(async () => {
                    const code = readInvitationPackage(joinCode);
                    const result = await api(
                      `/api/workspaces/${code.tenantId}/join`,
                      {
                        method: "POST",
                        body: { invitationToken: code.invitationToken },
                      },
                    );
                    setJoinCode("");
                    setWorkspaces((old) => [
                      ...old.filter((x) => x.tenantId !== code.tenantId),
                      { tenantId: code.tenantId, role: result.role },
                    ]);
                    setSelected(code.tenantId);
                  }, "Workspace joined.");
                }}
              >
                <h3>Join a workspace</h3>
                <label>
                  Invitation code
                  <textarea
                    required
                    value={joinCode}
                    onChange={(e) => setJoinCode(e.target.value)}
                    maxLength={512}
                  />
                </label>
                <button disabled={busy}>Accept invitation</button>
              </form>
              </>}
            </>
          )}
        </aside>
      )}
    </>
  );
}
