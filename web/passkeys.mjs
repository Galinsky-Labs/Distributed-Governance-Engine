import {startRegistration, startAuthentication} from '@simplewebauthn/browser';

const descriptors = items => items.map(item => ({...item, type: 'public-key'}));
export async function enrollPasskey(api) {
  const options = await api('/api/passkeys/enrollment/options', {method: 'POST', body: {}});
  const response = await startRegistration({optionsJSON: {
    challenge: options.challenge, rp: {id: options.rpId, name: 'Quill'},
    user: {
      id: btoa(options.user.id).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_'),
      name: options.user.id, displayName: 'Quill account',
    },
    pubKeyCredParams: [{type: 'public-key', alg: -7}, {type: 'public-key', alg: -257}],
    timeout: 300000, attestation: 'none',
    authenticatorSelection: {residentKey: 'preferred', userVerification: 'required'},
    excludeCredentials: descriptors(options.excludeCredentials),
  }});
  return api('/api/passkeys/enrollment/verify', {
    method: 'POST', body: {challenge: options.challenge, response},
  });
}
export async function verifyPasskey(api) {
  const options = await api('/api/passkeys/authentication/options', {method: 'POST', body: {}});
  const response = await startAuthentication({optionsJSON: {
    challenge: options.challenge, rpId: options.rpId, timeout: 300000,
    userVerification: 'required', allowCredentials: descriptors(options.allowCredentials),
  }});
  return api('/api/passkeys/authentication/verify', {
    method: 'POST', body: {challenge: options.challenge, response},
  });
}
