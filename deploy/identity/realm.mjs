import {readFile, writeFile, realpath} from 'node:fs/promises';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {resolve, dirname, basename, sep} from 'node:path';

const exactOrigin = value => {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.origin !== value || url.username || url.password || url.hostname.includes('*'))
    throw Error('An exact public HTTPS application origin is required');
  return value;
};
export function createQuillRealm({civicOrigin, charterOrigin, civicSecret, charterSecret}) {
  for (const value of [civicSecret, charterSecret])
    if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw Error('Independent random 32-byte client secrets required');
  if (civicSecret === charterSecret) throw Error('Independent client secrets required');
  const clients = [['quill-civic', exactOrigin(civicOrigin), civicSecret],
    ['quill-charter', exactOrigin(charterOrigin), charterSecret]].map(([clientId, origin, secret]) => ({
      clientId, name: clientId === 'quill-civic' ? 'CivicQuill' : 'CharterQuill',
      protocol: 'openid-connect', publicClient: false, clientAuthenticatorType: 'client-secret', secret,
      enabled: true, standardFlowEnabled: true, implicitFlowEnabled: false,
      directAccessGrantsEnabled: false, serviceAccountsEnabled: false,
      redirectUris: [origin + '/auth/callback'], webOrigins: [origin],
      attributes: {'pkce.code.challenge.method': 'S256'},
      protocolMappers: [{name: 'completed-authentication-methods', protocol: 'openid-connect',
        protocolMapper: 'oidc-amr-mapper', consentRequired: false,
        config: {'id.token.claim': 'true', 'access.token.claim': 'true'}}],
    }));
  return {
    realm: 'quill', enabled: true, displayName: 'Quill accounts', sslRequired: 'all',
    registrationAllowed: false, resetPasswordAllowed: false,
    otpPolicyCodeReusable: false,
    rememberMe: false, loginWithEmailAllowed: false, duplicateEmailsAllowed: false,
    bruteForceProtected: true, failureFactor: 5, waitIncrementSeconds: 30,
    maxFailureWaitSeconds: 900, permanentLockout: false,
    passwordPolicy: 'length(14)', defaultSignatureAlgorithm: 'RS256',
    accessTokenLifespan: 300, ssoSessionIdleTimeout: 1800, ssoSessionMaxLifespan: 28800,
    browserFlow: 'quill-browser',
    requiredActions: [{alias: 'CONFIGURE_TOTP', name: 'Configure OTP', providerId: 'CONFIGURE_TOTP',
      enabled: true, defaultAction: true, priority: 10}],
    authenticationFlows: [
      {alias: 'quill-browser', description: 'Fresh password and OTP for Quill', providerId: 'basic-flow',
        topLevel: true, builtIn: false, authenticationExecutions: [
          {authenticatorFlow: true, flowAlias: 'quill-password-otp', requirement: 'REQUIRED', priority: 10},
        ]},
      {alias: 'quill-password-otp', providerId: 'basic-flow', topLevel: false, builtIn: false,
        authenticationExecutions: [
          {authenticator: 'auth-username-password-form', authenticatorConfig: 'quill-password-amr', authenticatorFlow: false, requirement: 'REQUIRED', priority: 10},
          {authenticator: 'auth-otp-form', authenticatorConfig: 'quill-otp-amr', authenticatorFlow: false, requirement: 'REQUIRED', priority: 20},
        ]},
    ],
    authenticatorConfig: [
      {alias: 'quill-password-amr', config: {'default.reference.value': 'pwd', 'default.reference.maxAge': '300'}},
      {alias: 'quill-otp-amr', config: {'default.reference.value': 'mfa', 'default.reference.maxAge': '300'}},
    ], clients,
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const realm = createQuillRealm({civicOrigin: process.env.CIVIC_PUBLIC_ORIGIN,
      charterOrigin: process.env.CHARTER_PUBLIC_ORIGIN,
      civicSecret: (await readFile(process.env.CIVIC_OIDC_CLIENT_SECRET_FILE, 'utf8')).trim(),
      charterSecret: (await readFile(process.env.CHARTER_OIDC_CLIENT_SECRET_FILE, 'utf8')).trim()});
    if (!process.argv[2]) throw Error('Private realm output path required');
    const repository = await realpath(fileURLToPath(new URL('../../', import.meta.url)));
    const output = resolve(await realpath(dirname(resolve(process.argv[2]))), basename(process.argv[2]));
    if (output === repository || output.startsWith(repository + sep)) throw Error('Keep secret imports outside the source checkout');
    await writeFile(output, JSON.stringify(realm, null, 2) + '\n', {flag: 'wx', mode: 0o600});
    console.log('Created private realm import. Secret values were not logged.');
  } catch {console.error('Realm preparation failed. Check origins, distinct secret files and an unused private output path.'); process.exitCode = 1;}
}
