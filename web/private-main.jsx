import React, {useEffect, useState} from 'react';
import {createRoot} from 'react-dom/client';
import {createAccountAPI} from './account-api.mjs';
import {PrivateWorkspace} from './private-workspace.jsx';

// The MLS endpoint is a separately built, pinned Wasm artifact served at /mls/.
async function loadMls() {
  const mls = await import('/mls/quill_mls.js');
  await mls.default({module_or_path: '/mls/quill_mls_bg.wasm'});
  return mls;
}
function PrivatePage() {
  const [api] = useState(() => createAccountAPI());
  const [session, setSession] = useState(null), [workspaces, setWorkspaces] = useState([]), [tenantId, setTenantId] = useState(''), [state, setState] = useState('loading');
  useEffect(() => {
    (async () => {
      try {
        const who = await api('/api/session');
        if (who.recoveryRestricted) { setSession(who); setState('recovery'); return; }
        const page = await api('/api/workspaces');
        setSession(who); setWorkspaces(page.items); setTenantId(page.items[0]?.tenantId ?? ''); setState('ready');
      } catch { setState('signed-out'); }
    })();
  }, []);
  return <main className="private-page">
    <header className="private-header"><a href="/account">Account</a> <a href="/governance">Governance</a></header>
    {state === 'loading' && <p role="status">Loading…</p>}
    {state === 'signed-out' && <p>Sign in to use private documents. <a className="button-link" href="/auth/start">Sign in</a></p>}
    {state === 'recovery' && <p role="alert">Recovery sessions cannot open private documents. Restore your provider sign-in first.</p>}
    {state === 'ready' && !workspaces.length && <p>Create or join a workspace on the Account page first.</p>}
    {state === 'ready' && workspaces.length > 0 && <>
      <label>Workspace <select aria-label="Private workspace" value={tenantId} onChange={e => setTenantId(e.target.value)}>
        {workspaces.map(w => <option key={w.tenantId} value={w.tenantId}>{w.tenantId} ({w.role})</option>)}
      </select></label>
      <PrivateWorkspace key={tenantId} api={api} tenantId={tenantId} accountId={session.accountId} loadMls={loadMls}/>
    </>}
  </main>;
}
createRoot(document.getElementById('root')).render(<PrivatePage/>);
