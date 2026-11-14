import React, {useEffect, useRef, useState} from 'react';
import {verifyPasskey} from './passkeys.mjs';
import {createPrivateApi, createPrivateWorkspaceClient, openLocalStore} from './private-workspace-client.mjs';
import {openMlsStateStore} from './mls-state-vault.mjs';
import {mountPrivateEditor} from '../editor/private-realtime-editor.mjs';

const STATUS_TEXT = {
  own: 'This device',
  approved: 'Verified by you',
  new: 'Not verified — compare the safety number before approving',
  added: 'New device for this member — compare before approving',
  changed: 'SECURITY WARNING: this device key changed — do not approve unless the member confirms the new safety number',
};
const MESSAGES = {
  PASSKEY_STEP_UP_REQUIRED: 'Verify with a passkey first. Device enrollment needs a fresh passkey check.',
  PASSKEY_NOT_ENROLLED: 'Add a passkey on the Account page before enrolling a private device.',
  RECOVERY_SESSION_RESTRICTED: 'Recovery sessions cannot enroll devices or open private documents.',
  KEY_APPROVAL_REQUIRED: 'A device key needs your explicit approval. Compare its safety number with the member, then approve it.',
  PRIVATE_WELCOME_PENDING: 'You have not been added to this document yet.',
  PRIVATE_REKEY_PENDING: 'Waiting for a member to re-encrypt this document for your device. Try again shortly.',
  PRIVATE_ACCESS_REMOVED: 'This device was removed from the document.',
  DEVICE_REVOKED: 'This device was revoked. Enroll it again as a new device.',
  NO_ENROLLED_DEVICES: 'That member has not enrolled a private device yet.',
  KEY_PACKAGE_UNAVAILABLE: 'That member device has no unused key packages. Ask them to open Private documents once.',
  PRIVATE_MEMBERSHIP_ADMIN_REQUIRED: 'Only a workspace owner/admin or the document creator can change document members.',
  MEMBERSHIP_CHANGE_CONFLICT: 'Another membership change happened first. Reopen the document and try again.',
};
const message = error => MESSAGES[error?.code] ?? 'The private workspace request could not be completed.';
const short = id => id.slice(0, 8);

function DeviceList({entries, onApprove, busy}) {
  if (!entries.length) return <p>No enrolled devices yet.</p>;
  return <ul className="private-devices">{entries.map(entry => <li key={entry.deviceId} className={'private-device private-device-' + entry.status}>
    <span>Member <code>{short(entry.accountId)}</code> device <code>{short(entry.deviceId)}</code></span>
    <code className="safety-number" aria-label={'Safety number for device ' + entry.deviceId}>{entry.safetyNumber}</code>
    {entry.status === 'changed'
      ? <strong role="alert">{STATUS_TEXT.changed}</strong>
      : <span className="device-status">{STATUS_TEXT[entry.status]}</span>}
    {!['own', 'approved'].includes(entry.status) && <button disabled={busy} aria-label={'Approve device ' + entry.deviceId}
      onClick={() => onApprove(entry)}>{entry.status === 'changed' ? 'Re-approve changed key' : 'Approve device'}</button>}
  </li>)}</ul>;
}

/**
 * Private (end-to-end encrypted) workspace view: device enrollment and safety
 * numbers, key approvals, private document list, members and the encrypted
 * editor. Mount it with a signed-in session and a selected workspace.
 */
export function PrivateWorkspace({api, tenantId, accountId, origin = location.origin, loadMls}) {
  const [client, setClient] = useState(null), [own, setOwn] = useState(null), [needsEnrollment, setNeedsEnrollment] = useState(false);
  const [directory, setDirectory] = useState([]), [documents, setDocuments] = useState([]), [members, setMembers] = useState([]);
  const [status, setStatus] = useState('Loading private workspace…'), [busy, setBusy] = useState(false), [warnings, setWarnings] = useState([]);
  const [open, setOpen] = useState(null), [openMembers, setOpenMembers] = useState([]), [removed, setRemoved] = useState(false);
  const [title, setTitle] = useState(''), [addAccount, setAddAccount] = useState('');
  const editorRef = useRef(null), editor = useRef(null), sessionRef = useRef(null);

  async function refreshLists(active = client) {
    if (!active?.device) return;
    const [dir, docs, mem] = await Promise.all([active.directory(), active.documents(), api('/api/workspaces/' + tenantId + '/members')]);
    setDirectory(dir); setDocuments(docs); setMembers(mem.items);
  }
  useEffect(() => {
    let alive = true, created;
    (async () => {
      try {
        const mls = await loadMls();
        created = createPrivateWorkspaceClient({api: createPrivateApi(), mls, stateStore: await openMlsStateStore(),
          local: await openLocalStore(), tenantId, accountId, origin});
        const device = await created.open();
        if (!alive) return;
        setClient(created); setOwn(device); setNeedsEnrollment(!device);
        setStatus(device ? 'Private device ready.' : 'Enroll this device to use private documents.');
        if (device) await refreshLists(created);
      } catch (error) { if (alive) setStatus(message(error)); }
    })();
    return () => { alive = false; sessionRef.current?.close(); editor.current?.destroy(); created?.close(); };
  }, [tenantId, accountId]);

  async function perform(action, done) {
    setBusy(true);
    try { const result = await action(); if (done) setStatus(done); setWarnings([]); return result; }
    catch (error) {
      setStatus(message(error));
      if (error.code === 'KEY_APPROVAL_REQUIRED') setWarnings(error.details ?? []);
      return undefined;
    } finally { setBusy(false); }
  }
  async function enroll() {
    await perform(async () => {
      const device = await client.enroll({stepUp: () => verifyPasskey(api)});
      setOwn(device); setNeedsEnrollment(false); await refreshLists();
    }, 'This device is enrolled. Share its safety number with members through a separate channel.');
  }
  async function approve(entry) {
    await perform(async () => { await client.approveDevice(entry); await refreshLists(); }, 'Device approved and pinned on this device.');
  }
  async function create(event) {
    event.preventDefault();
    await perform(async () => { const {documentId} = await client.createDocument(title); setTitle(''); await refreshLists(); await openDocument(documentId); },
      'Private document created. Only devices you add can decrypt it.');
  }
  async function openDocument(documentId) {
    sessionRef.current?.close(); editor.current?.destroy(); editor.current = null; sessionRef.current = null; setRemoved(false);
    const session = await client.openDocument(documentId, {
      onStatus: setStatus,
      onError: error => setStatus(message(error)),
      onMembership: change => { if (change.removed) { setRemoved(true); editor.current?.setReadOnly(true); } else setOpenMembers(change.members); },
    });
    sessionRef.current = session; setOpen({documentId, title: session.base.metadata.title}); setOpenMembers(session.members());
    editor.current = mountPrivateEditor(editorRef.current, session, {onError: setStatus});
    setStatus('Private document open. Edits are encrypted on this device before they are sent.');
  }
  async function addMember() {
    await perform(async () => { await sessionRef.current.addMember(addAccount); setOpenMembers(sessionRef.current.members()); await refreshLists(); },
      'Member added. The document was re-encrypted for the new membership epoch.');
  }
  async function removeMember(target) {
    await perform(async () => { await sessionRef.current.removeMember(target); setOpenMembers(sessionRef.current.members()); await refreshLists(); },
      'Member removed. The document was re-encrypted; removed devices cannot read new edits.');
  }
  async function removeStale() {
    await perform(async () => { await sessionRef.current.removeStaleDevices(); setOpenMembers(sessionRef.current.members()); },
      'Stale devices removed from the document.');
  }
  const activeAccounts = [...new Set(openMembers.filter(m => m.active).map(m => m.accountId))];
  const stale = openMembers.filter(m => m.active && m.stale);

  return <section className="private-workspace" aria-labelledby="private-heading">
    <h2 id="private-heading">Private documents</h2>
    <p className="private-disclosure">End-to-end encrypted with MLS (RFC 9420): document text is decrypted only on enrolled member devices.
      Removing a member stops access to new edits; it cannot erase anything they already saw or saved.
      Not independently audited or certified.</p>
    <p role="status" className="private-status">{status}</p>
    <section aria-labelledby="private-device-heading">
      <h3 id="private-device-heading">This device</h3>
      {needsEnrollment && <button disabled={busy || !client} onClick={enroll}>Enroll this device</button>}
      {own && <p>Safety number <code className="own-safety-number" aria-label="This device safety number">{own.safetyNumber}</code>
        <span className="small"> Compare it with other members through a separate trusted channel.</span></p>}
    </section>
    {warnings.length > 0 && <section role="alert" aria-label="Device key approvals required" className="private-warnings">
      <h3>Device approval required</h3><DeviceList entries={warnings} onApprove={approve} busy={busy}/>
    </section>}
    {own && <>
      <section aria-labelledby="private-members-heading">
        <h3 id="private-members-heading">Members' devices</h3>
        <DeviceList entries={directory} onApprove={approve} busy={busy}/>
      </section>
      <section aria-labelledby="private-list-heading">
        <h3 id="private-list-heading">Your private documents</h3>
        <form onSubmit={create} className="private-create">
          <label>Private document title<input value={title} maxLength={200} required onChange={e => setTitle(e.target.value)}/></label>
          <button disabled={busy || !title.trim()}>Create private document</button>
        </form>
        <ul className="private-document-list">{documents.filter(d => d.member).map(d => <li key={d.documentId}>
          <button disabled={busy} aria-label={'Open private document ' + d.documentId}
            onClick={() => perform(() => openDocument(d.documentId))}>Open {short(d.documentId)} (epoch {d.epoch})</button>
        </li>)}</ul>
      </section>
    </>}
    <section hidden={!open} aria-label="Open private document" className="private-document">
      {open && <h3 className="private-title">{open.title}</h3>}
      {removed && <p role="alert">This device was removed from the document. New edits can no longer be decrypted here.</p>}
      <div className="private-editor" ref={editorRef}/>
      {open && !removed && <div className="private-membership">
        <h4>Document members</h4>
        <ul>{activeAccounts.map(id => <li key={id}><code>{short(id)}</code>
          {id !== accountId && <button disabled={busy} aria-label={'Remove member ' + id} onClick={() => removeMember(id)}>Remove from document</button>}
        </li>)}</ul>
        {stale.length > 0 && <p role="alert">{stale.length} device(s) belong to removed members or revoked devices.
          <button disabled={busy} onClick={removeStale}>Remove stale devices</button></p>}
        <label>Add workspace member<select value={addAccount} onChange={e => setAddAccount(e.target.value)}>
          <option value="">Choose a member</option>
          {members.filter(m => !activeAccounts.includes(m.accountId)).map(m => <option key={m.accountId} value={m.accountId}>{m.accountId}</option>)}
        </select></label>
        <button disabled={busy || !addAccount} onClick={addMember}>Add to document</button>
      </div>}
    </section>
  </section>;
}
