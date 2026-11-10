import React, {useEffect, useState} from 'react';
import {enrollPasskey, verifyPasskey} from './passkeys.mjs';

export function PasskeyControls({api, session, perform, busy, reload}) {
  const [items, setItems] = useState([]), [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    api('/api/passkeys').then(result => {
      if (active) {setItems(result.items); setError('');}
    }).catch(() => {if (active) setError('Passkey inventory is unavailable.');});
    return () => {active = false;};
  }, [session.accountId, reload]);
  return <section aria-labelledby="passkeys-heading">
    <h3 id="passkeys-heading">Passkeys</h3>
    <p>Use a passkey to verify sensitive account changes.</p>
    {error && <p role="status">{error}</p>}
    <button disabled={busy || session.recoveryRestricted}
      onClick={() => perform(() => enrollPasskey(api), 'Passkey added.')}>Add a passkey</button>
    <button disabled={busy || items.length === 0}
      onClick={() => perform(() => verifyPasskey(api), 'Account verified for five minutes.')}>Verify with a passkey</button>
    <ul>{items.map(item => <li key={item.id}>
      Passkey added {new Date(item.createdAt).toLocaleDateString()}
      <button disabled={busy || session.recoveryRestricted}
        aria-label={'Revoke passkey ' + item.id}
        onClick={() => perform(() => api('/api/passkeys/' + item.id, {method: 'DELETE', body: {}}), 'Passkey revoked.')}>Revoke passkey</button>
    </li>)}</ul>
  </section>;
}
