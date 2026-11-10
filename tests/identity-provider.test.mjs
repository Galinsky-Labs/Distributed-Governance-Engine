import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, writeFile, stat, rm, symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes, randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {createQuillRealm} from '../deploy/identity/realm.mjs';

const options = () => ({civicOrigin: 'https://civic.example', charterOrigin: 'https://charter.example',
  civicSecret: randomBytes(32).toString('hex'), charterSecret: randomBytes(32).toString('hex')});
test('identity realm scopes confidential clients to exact callbacks and PKCE; password grants are disabled', () => {
  const input = options(), realm = createQuillRealm(input);
  assert.equal(realm.clients.length, 2);
  assert.notEqual(realm.clients[0].secret, realm.clients[1].secret);
  for (const [i, client] of realm.clients.entries()) {
    assert.deepEqual(client.redirectUris, [(i === 0 ? input.civicOrigin : input.charterOrigin) + '/auth/callback']);
    assert.equal(client.publicClient, false);
    assert.equal(client.implicitFlowEnabled, false);
    assert.equal(client.directAccessGrantsEnabled, false);
    assert.equal(client.serviceAccountsEnabled, false);
    assert.equal(client.attributes['pkce.code.challenge.method'], 'S256');
  }
});
test('MFA claims derive from required password/OTP executions, not a hardcoded token claim', () => {
  const realm = createQuillRealm(options());
  assert.equal(realm.sslRequired, 'all');
  assert.equal(realm.registrationAllowed, false);
  assert.equal(realm.otpPolicyCodeReusable, false);
  const flow = realm.authenticationFlows.find(x => x.alias === 'quill-password-otp');
  assert.deepEqual(flow.authenticationExecutions.map(x => [x.authenticator, x.requirement]),
    [['auth-username-password-form', 'REQUIRED'], ['auth-otp-form', 'REQUIRED']]);
  assert.equal(realm.authenticatorConfig.find(x => x.alias === 'quill-otp-amr').config['default.reference.value'], 'mfa');
  for (const client of realm.clients) assert.equal(client.protocolMappers[0].protocolMapper, 'oidc-amr-mapper');
  assert.equal(realm.users, undefined, 'No test or administrator credentials belong in the production import');
});
test('HTTP, wildcard/path/credential-bearing origins and reused/weak client secrets are refused', () => {
  for (const civicOrigin of ['http://civic.example', 'https://civic.example/', 'https://civic.example/path',
    'https://*.civic.example',
    'https://user:password@civic.example', 'https://civic.example?x=1', 'https://civic.example#fragment'])
    assert.throws(() => createQuillRealm({...options(), civicOrigin}));
  const same = options(); same.charterSecret = same.civicSecret;
  assert.throws(() => createQuillRealm(same));
  for (const secret of ['', 'short', 'x'.repeat(64)]) assert.throws(() => createQuillRealm({...options(), civicSecret: secret}));
});
test('realm CLI writes a private import once and never logs or overwrites its client secrets', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'quill-realm-test-'));
  try {
    const input = options(), civic = join(directory, 'civic'), charter = join(directory, 'charter'), output = join(directory, 'realm.json');
    await writeFile(civic, input.civicSecret, {mode: 0o600});
    await writeFile(charter, input.charterSecret, {mode: 0o600});
    const invoke = (target = output) => spawnSync(process.execPath, [fileURLToPath(new URL('../deploy/identity/realm.mjs', import.meta.url)), target],
      {encoding: 'utf8', env: {...process.env, CIVIC_PUBLIC_ORIGIN: input.civicOrigin,
        CHARTER_PUBLIC_ORIGIN: input.charterOrigin, CIVIC_OIDC_CLIENT_SECRET_FILE: civic, CHARTER_OIDC_CLIENT_SECRET_FILE: charter}});
    const first = invoke(); assert.equal(first.status, 0);
    assert.equal((await stat(output)).mode & 0o777, 0o600);
    const original = await readFile(output, 'utf8');
    const second = invoke(); assert.notEqual(second.status, 0);
    assert.equal(await readFile(output, 'utf8'), original);
    for (const result of [first, second]) for (const value of [input.civicSecret, input.charterSecret])
      assert.equal((result.stdout + result.stderr).includes(value), false);
    await symlink(fileURLToPath(new URL('../', import.meta.url)), join(directory, 'checkout'));
    const forbidden = join(directory, 'checkout', 'quill-private-' + randomUUID() + '.json');
    assert.notEqual(invoke(forbidden).status, 0, 'A symlink must not place credentials inside the checkout');
    await assert.rejects(stat(forbidden), {code: 'ENOENT'});
  } finally {await rm(directory, {recursive: true, force: true});}
});
