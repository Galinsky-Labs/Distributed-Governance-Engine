import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync, randomBytes, createHash, sign} from 'node:crypto';
import {isoCBOR} from '@simplewebauthn/server/helpers';
import {createPasskeyVerifiers, configuredPasskeys} from '../server/passkey-verifier.mjs';

const verifier = createPasskeyVerifiers();
const origin = 'https://quill.example', rpId = 'quill.example';
function assertion({uv = true, counter = 1, client = {}, signed = true, rp = rpId} = {}) {
  const {privateKey, publicKey} = generateKeyPairSync('ec', {namedCurve: 'prime256v1'});
  const jwk = publicKey.export({format: 'jwk'}), id = randomBytes(32).toString('base64url');
  const key = isoCBOR.encode(new Map([
    [1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')],
  ]));
  const challenge = randomBytes(32).toString('base64url');
  const data = Buffer.from(JSON.stringify({type: 'webauthn.get', challenge, origin, crossOrigin: false, ...client}));
  const auth = Buffer.alloc(37);
  createHash('sha256').update(rp).digest().copy(auth);
  auth[32] = uv ? 5 : 1;
  auth.writeUInt32BE(counter, 33);
  const signature = sign('sha256', Buffer.concat([auth, createHash('sha256').update(data).digest()]), privateKey);
  if (!signed) signature[signature.length - 1] ^= 1;
  return {
    response: {id, rawId: id, type: 'public-key', clientExtensionResults: {}, response: {
      authenticatorData: auth.toString('base64url'), clientDataJSON: data.toString('base64url'),
      signature: signature.toString('base64url'),
    }},
    credentials: [{credentialId: id, publicKey: Buffer.from(key).toString('base64url'), counter: 0, transports: ['internal']}],
    expectedChallenge: challenge, expectedOrigin: origin, expectedRpId: rpId,
  };
}
async function rejected(options) {
  assert.equal((await verifier.verifyPasskeyAuthentication(options)).verified, false);
}
test('pinned WebAuthn verifier checks a real ES256 signature and returns the signed counter', async () => {
  const options = assertion();
  assert.deepEqual(await verifier.verifyPasskeyAuthentication(options), {
    verified: true, userVerified: true, credentialId: options.response.id, newCounter: 1,
  });
});
test('bad signature, missing UV, wrong RP, origin, challenge, and iframe assertions fail closed', async () => {
  for (const change of [
    {signed: false}, {uv: false}, {rp: 'attacker.example'},
    {client: {origin: 'https://attacker.example'}}, {client: {challenge: 'wrong'}},
    {client: {crossOrigin: true}}, {client: {topOrigin: origin}},
  ]) await rejected(assertion(change));
});
test('unknown credentials and non-increasing authenticator counters cannot verify', async () => {
  const unknown = assertion(); unknown.credentials = [];
  await rejected(unknown);
  const stale = assertion(); stale.credentials[0].counter = 1;
  await rejected(stale);
});
test('passkeys remain disabled without a policy; malformed configuration cannot enable them', () => {
  assert.deepEqual(configuredPasskeys(undefined), {});
  assert.deepEqual(configuredPasskeys(''), {});
  for (const value of ['null', '[]', '{}', 'x'.repeat(8193), '{"id":"x","allowedFormats":[],"allowedAaguids":[],"extra":true}'])
    assert.throws(() => configuredPasskeys(value));
  const policy = {id: 'named-test-policy', allowedFormats: ['none'], allowedAaguids: ['00000000-0000-0000-0000-000000000000']};
  const config = configuredPasskeys(JSON.stringify(policy));
  assert.deepEqual(config.passkeyAttestationPolicy, policy);
  assert.equal(typeof config.verifyPasskeyRegistration, 'function');
});
