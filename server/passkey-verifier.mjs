import {
  verifyRegistrationResponse,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';

function requireSameOriginCeremony(response) {
  const data = JSON.parse(Buffer.from(response?.response?.clientDataJSON ?? '', 'base64url').toString('utf8'));
  // This service has no embedded/third-party account ceremony. Reject it even
  // when a browser omits topOrigin, which upstream accepts for compatibility.
  if ((data.crossOrigin !== undefined && data.crossOrigin !== false) || data.topOrigin !== undefined)
    throw Error('Cross-origin passkey ceremony rejected');
}
const denyInvalidCeremony = verify => async options => {
  try {return await verify(options);}
  catch {return {verified: false};} // Upstream errors can include ceremony data.
};

// Authentication is verified by the pinned upstream library. These adapters only
// translate its verified results into the identity store's existing contract.
export function createPasskeyVerifiers() {
  return {
    verifyPasskeyRegistration: denyInvalidCeremony(async ({response, expectedChallenge, expectedOrigin, expectedRpId}) => {
      requireSameOriginCeremony(response);
      const result = await verifyRegistrationResponse({
        response, expectedChallenge, expectedOrigin, expectedRPID: expectedRpId,
        requireUserPresence: true, requireUserVerification: true,
        supportedAlgorithmIDs: [-7, -257],
      });
      if (!result.verified || !result.registrationInfo.userVerified) return {verified: false};
      const info = result.registrationInfo;
      return {verified: true, credential: {
        id: info.credential.id,
        publicKey: Buffer.from(info.credential.publicKey).toString('base64url'),
        counter: info.credential.counter,
        transports: info.credential.transports ?? [],
        backedUp: info.credentialBackedUp,
        attestationFormat: info.fmt, aaguid: info.aaguid,
      }};
    }),
    verifyPasskeyAuthentication: denyInvalidCeremony(async ({response, credentials, expectedChallenge, expectedOrigin, expectedRpId}) => {
      requireSameOriginCeremony(response);
      const credential = credentials.find(item => item.credentialId === response?.id);
      if (!credential) return {verified: false};
      const result = await verifyAuthenticationResponse({
        response, expectedChallenge, expectedOrigin, expectedRPID: expectedRpId,
        requireUserVerification: true,
        credential: {
          id: credential.credentialId,
          publicKey: new Uint8Array(Buffer.from(credential.publicKey, 'base64url')),
          counter: credential.counter, transports: credential.transports,
        },
      });
      if (!result.verified) return {verified: false};
      return {
        verified: true, userVerified: result.authenticationInfo.userVerified,
        credentialId: credential.credentialId,
        newCounter: result.authenticationInfo.newCounter,
      };
    }),
  };
}

// No default attestation policy: operators must choose and name their allowlist.
// The identity store validates and freezes the actual policy before serving.
export function configuredPasskeys(rawPolicy) {
  if (rawPolicy === undefined || rawPolicy === '') return {};
  if (typeof rawPolicy !== 'string' || rawPolicy.length > 8192)
    throw Error('Invalid passkey policy configuration');
  const policy = JSON.parse(rawPolicy);
  if (!policy || Array.isArray(policy) || typeof policy !== 'object' ||
      Object.keys(policy).sort().join(',') !== 'allowedAaguids,allowedFormats,id')
    throw Error('Invalid passkey policy configuration');
  return {...createPasskeyVerifiers(), passkeyAttestationPolicy: policy};
}
