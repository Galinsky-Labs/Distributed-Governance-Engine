import {readFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
const path = process.env.DGE_IDENTITY_TEST_STATE;
if (!path) throw Error('DGE_IDENTITY_TEST_STATE must reference the local TLS fixture');
const state = JSON.parse(await readFile(path, 'utf8'));
if (!/^https:\/\/localhost:[0-9]+\/realms\/quill$/.test(state.issuer) ||
    !/^[a-f0-9]{16}$/.test(state.nonce) || !state.root.includes('quill-idp-test-' + state.nonce + '-'))
  throw Error('Only a local identity integration fixture is accepted');
const child = spawn(process.execPath, ['--test', new URL('../tests/identity-provider.integration.mjs', import.meta.url).pathname],
  {stdio: 'inherit', env: {...process.env, NODE_EXTRA_CA_CERTS: state.root + '/client-ca.pem'}});
child.on('error', () => {console.error('Could not start the identity integration runner'); process.exitCode = 1;});
child.on('exit', code => {process.exitCode = code ?? 1;});
