import {randomBytes,randomUUID,createHmac,createHash,timingSafeEqual,createCipheriv,createDecipheriv} from 'node:crypto';
import {readFile} from 'node:fs/promises';

export class AccessError extends Error {
  constructor(code='ACCESS_DENIED') { super(code); this.name='AccessError'; this.code=code; }
}
const deny=(condition,code)=>{if(!condition)throw new AccessError(code);};
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
const token=()=>randomBytes(32).toString('base64url');
const isToken=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{43}$/.test(value);
const role=value=>['owner','admin','editor','participant','viewer'].includes(value);
const date=value=>new Date(value).getTime();
const policyId=value=>typeof value==='string'&&/^[a-z0-9][a-z0-9._-]{0,63}$/.test(value);
const attestationFormat=value=>typeof value==='string'&&/^[a-z0-9][a-z0-9._-]{0,63}$/.test(value);
const aaguid=value=>typeof value==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
export const identityMigration=()=>readFile(new URL('../migrations/001-identity.sql',import.meta.url),'utf8');
const migrationRecords=()=>Promise.all(['001-identity.sql','002-session-authentication-time.sql','003-account-directory.sql','004-public-documents.sql','005-text-proposals.sql','006-structured-points.sql','007-account-recovery.sql','008-session-assurance.sql','009-passkey-device-assurance.sql','010-passkey-attestation-policy.sql','011-passkey-revocation.sql','012-provider-restoration.sql','013-public-crdt-snapshots.sql','014-private-encrypted-documents.sql','015-private-update-frames.sql','016-governance-ballots.sql'].map(async(name,index)=>{
    const sql=await readFile(new URL('../migrations/'+name,import.meta.url),'utf8');
    return {version:index+1,sql,checksum:createHash('sha256').update(sql).digest('hex')};
  }));
export async function verifyIdentityRuntime(db){
  const elevated=(await db.query(`WITH RECURSIVE granted AS (
    SELECT oid,rolsuper,rolbypassrls,rolcreaterole,rolcreatedb,rolreplication FROM pg_roles WHERE rolname=current_user
    UNION SELECT r.oid,r.rolsuper,r.rolbypassrls,r.rolcreaterole,r.rolcreatedb,r.rolreplication FROM pg_roles r
    JOIN pg_auth_members m ON m.roleid=r.oid JOIN granted g ON m.member=g.oid)
    SELECT bool_or(rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication) AS elevated FROM granted`)).rows[0];
  const ownership=(await db.query("SELECT bool_or(pg_has_role(current_user,tableowner,'MEMBER') OR has_schema_privilege(current_user,schemaname,'CREATE')) AS owns_schema FROM pg_tables WHERE schemaname IN ('dge_identity','dge_documents','dge_proposals','dge_discussion','dge_private','dge_decisions')")).rows[0];
  if(!elevated||elevated.elevated!==false||!ownership||ownership.owns_schema)throw Error('Unprivileged request credential required');
  const expected=await migrationRecords(),observed=(await db.query('SELECT version,checksum FROM dge_identity.migrations ORDER BY version')).rows;
  if(observed.length!==expected.length||expected.some((item,index)=>item.version!==observed[index]?.version||item.checksum!==observed[index]?.checksum))throw Error('Expected identity schema required');
  return true;
}
export async function applyIdentityMigrations(transaction) {
  const migrations=await migrationRecords();
  return transaction(async db=>{
    const exec=statement=>db.exec?db.exec(statement):db.query(statement);
    await db.query('SELECT pg_advisory_xact_lock(1245995845)');
    await exec('CREATE SCHEMA IF NOT EXISTS dge_identity; REVOKE ALL ON SCHEMA dge_identity FROM PUBLIC; CREATE TABLE IF NOT EXISTS dge_identity.migrations(version integer PRIMARY KEY,checksum char(64) NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())');
    let applied=false;
    for(const {version,sql,checksum} of migrations){
      const prior=(await db.query('SELECT checksum FROM dge_identity.migrations WHERE version=$1',[version])).rows[0];
      if(prior){if(prior.checksum!==checksum)throw Error('Identity migration checksum changed');continue;}
      await exec(sql);await db.query('INSERT INTO dge_identity.migrations(version,checksum) VALUES($1,$2)',[version,checksum]);applied=true;
    }
    return {applied};
  });
}

/** One pooled connection per transaction. Never share tenant context across requests. */
export function pgTransactions(pool) {
  return async callback=>{
    const db=await pool.connect();
    try {await db.query('BEGIN');const result=await callback(db);await db.query('COMMIT');return result;}
    catch(error){await db.query('ROLLBACK');throw error;}
    finally{db.release();}
  };
}

/** Trusted server service, not a browser module or an HTTP identity assertion API. */
export function createIdentityStore({transaction,sessionKey,stateKey,origin,clock=Date.now,sessionSeconds=28800,maxOwnedWorkspaces=10,maxPendingInvitations=500,maxSessions=20,verifyPasskeyRegistration,verifyPasskeyAuthentication,passkeyAttestationPolicy}) {
  if(typeof transaction!=='function'||!Buffer.isBuffer(sessionKey)||sessionKey.length!==32||!Buffer.isBuffer(stateKey)||stateKey.length!==32||sessionKey.equals(stateKey))throw Error('Independent 32-byte identity keys required');
  const site=new URL(origin);
  if(site.protocol!=='https:'||site.origin!==origin)throw Error('An exact HTTPS origin is required');
  if(!Number.isSafeInteger(sessionSeconds)||sessionSeconds<60||sessionSeconds>86400)throw Error('Session duration must be 60–86400 seconds');
  for(const n of [maxOwnedWorkspaces,maxPendingInvitations,maxSessions])if(!Number.isSafeInteger(n)||n<1||n>10000)throw Error('Invalid identity resource limit');
  if(verifyPasskeyRegistration!==undefined&&typeof verifyPasskeyRegistration!=='function')throw Error('Invalid passkey registration verifier');
  if(verifyPasskeyAuthentication!==undefined&&typeof verifyPasskeyAuthentication!=='function')throw Error('Invalid passkey authentication verifier');
  let attestationPolicy=null;
  if(verifyPasskeyRegistration!==undefined){
    const formats=passkeyAttestationPolicy?.allowedFormats,aaguids=passkeyAttestationPolicy?.allowedAaguids;
    if(!policyId(passkeyAttestationPolicy?.id)||!Array.isArray(formats)||formats.length<1||formats.length>16||new Set(formats).size!==formats.length||!formats.every(attestationFormat)||
      !Array.isArray(aaguids)||aaguids.length<1||aaguids.length>256||new Set(aaguids).size!==aaguids.length||!aaguids.every(aaguid))
      throw Error('Explicit passkey attestation policy required');
    attestationPolicy=Object.freeze({id:passkeyAttestationPolicy.id,allowedFormats:Object.freeze([...formats]),allowedAaguids:Object.freeze([...aaguids])});
  }
  // Copy configuration so a caller cannot mutate keys after initialization.
  sessionKey=Buffer.from(sessionKey);stateKey=Buffer.from(stateKey);
  const digest=(purpose,value)=>createHmac('sha256',sessionKey).update(purpose+'\0'+value).digest('hex');
  const now=()=>{const n=clock();if(!Number.isSafeInteger(n)||n<0)throw Error('Invalid server clock');return new Date(n);};
  const base64url=value=>typeof value==='string'&&value.length>=1&&value.length<=16384&&/^[A-Za-z0-9_-]+$/.test(value);
  const thumbprint=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
  const transports=value=>Array.isArray(value)&&value.length<=8&&new Set(value).size===value.length&&value.every(item=>['ble','hybrid','internal','nfc','smart-card','usb'].includes(item));
  const checkWrite=credentials=>deny(credentials?.origin===origin&&isToken(credentials.csrfToken));
  async function session(db,credentials,write=false,recent=false,allowRecoveryWrite=false,requiredAssurance='primary') {
    deny(isToken(credentials?.sessionToken),'AUTHENTICATION_REQUIRED');
    if(write)checkWrite(credentials);
    const result=await db.query(`SELECT a.id,a.auth_epoch,s.token_digest,s.csrf_digest,s.created_at,s.authenticated_at,s.expires_at,s.authentication_method,s.authentication_assurance,s.passkey_verified_at,s.passkey_credential_id FROM dge_identity.sessions s
      JOIN dge_identity.accounts a ON a.id=s.account_id WHERE s.token_digest=$1 AND s.revoked_at IS NULL
      AND s.expires_at>$2 AND s.created_at<=$2 AND s.authenticated_at IS NOT NULL
      AND a.status='active' AND s.auth_epoch=a.auth_epoch FOR SHARE OF a,s`,[digest('session',credentials.sessionToken),now()]);
    const row=result.rows[0];deny(row,'AUTHENTICATION_REQUIRED');
    if(write)deny(timingSafeEqual(Buffer.from(row.csrf_digest),Buffer.from(digest('csrf',credentials.csrfToken))));
    if(row.authentication_method!=='oidc'&&(recent||(write&&!allowRecoveryWrite)))deny(false,'RECOVERY_SESSION_RESTRICTED');
    const assurances=['primary','multifactor','hardware-bound'];
    deny(assurances.indexOf(row.authentication_assurance)>=assurances.indexOf(requiredAssurance),'STEP_UP_REQUIRED');
    if(recent)deny(date(row.authenticated_at)>now().getTime()-300000,'REAUTHENTICATION_REQUIRED');
    return row;
  }
  const scope=(db,tenantId)=>{deny(uuid(tenantId));return db.query("SELECT set_config('dge.tenant_id',$1,true)",[tenantId]);};
  const event=(db,tenantId,actorId,subjectId,kind)=>db.query('INSERT INTO dge_identity.events(id,tenant_id,actor_id,subject_id,kind,occurred_at) VALUES($1,$2,$3,$4,$5,$6)',[randomUUID(),tenantId,actorId,subjectId,kind,now()]);
  async function tenantContext(db,credentials,tenantId,write=false,recent=write) {
    const actor=await session(db,credentials,write,recent);
    deny(actor.authentication_method==='oidc','RECOVERY_SESSION_RESTRICTED');
    await scope(db,tenantId);
    const tenant=await db.query(`SELECT id FROM dge_identity.tenants WHERE id=$1 FOR ${write?'UPDATE':'SHARE'}`,[tenantId]);
    deny(tenant.rows.length);
    const member=await db.query('SELECT role FROM dge_identity.memberships WHERE tenant_id=$1 AND account_id=$2 AND active=true',[tenantId,actor.id]);
    deny(member.rows.length);
    return {...actor,role:member.rows[0].role};
  }
  const manage=actor=>deny(['owner','admin'].includes(actor.role));
  const securityEvent=(db,accountId,kind,occurredAt=now())=>db.query('INSERT INTO dge_identity.account_security_events(id,account_id,kind,occurred_at) VALUES($1,$2,$3,$4)',[randomUUID(),accountId,kind,occurredAt]);
  async function createPasskeyChallenge(db,credentials,purpose,{recent=false,requiredAssurance='primary',allowRecoveryWrite=false}={}) {
    const actor=await session(db,credentials,true,recent,allowRecoveryWrite,requiredAssurance),challenge=token(),createdAt=now(),expiresAt=new Date(createdAt.getTime()+300000);
    await db.query('DELETE FROM dge_identity.passkey_challenges WHERE account_id=$1 AND purpose=$2',[actor.id,purpose]);
    await db.query('INSERT INTO dge_identity.passkey_challenges(challenge_digest,account_id,session_digest,purpose,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6)',[digest('passkey-challenge',challenge),actor.id,actor.token_digest,purpose,createdAt,expiresAt]);
    return {actor,challenge,expiresAt};
  }
  async function consumePasskeyChallenge(db,credentials,challenge,purpose,{recent=false,requiredAssurance='primary',allowRecoveryWrite=false}={}) {
    deny(isToken(challenge));const actor=await session(db,credentials,true,recent,allowRecoveryWrite,requiredAssurance),usedAt=now();
    const row=(await db.query(`UPDATE dge_identity.passkey_challenges SET consumed_at=$4 WHERE challenge_digest=$1 AND account_id=$2 AND session_digest=$3
      AND purpose=$5 AND consumed_at IS NULL AND expires_at>$4 RETURNING challenge_digest`,[digest('passkey-challenge',challenge),actor.id,actor.token_digest,usedAt,purpose])).rows[0];
    deny(row,'PASSKEY_CHALLENGE_INVALID');return {actor,usedAt};
  }
  return Object.freeze({
    // Call only with claims authenticated by the configured OIDC adapter. Never link by email.
    establishSession:({issuer,subject,authenticatedAt,authenticationMethods=[]})=>transaction(async db=>{
      const issuedAt=now();
      deny(Array.isArray(authenticationMethods)&&authenticationMethods.length<=16&&authenticationMethods.every(value=>typeof value==='string'&&value.length>0&&value.length<=64&&!value.includes('\0')));
      const authenticationAssurance=authenticationMethods.includes('hwk')?'hardware-bound':authenticationMethods.includes('mfa')?'multifactor':'primary';
      deny(Number.isSafeInteger(authenticatedAt)&&authenticatedAt>=issuedAt.getTime()-300000&&authenticatedAt<=issuedAt.getTime()+30000);
      const uri=new URL(issuer);
      deny(uri.protocol==='https:'&&!uri.username&&!uri.password&&!uri.hash&&!uri.search&&issuer.length<=2048);
      deny(typeof subject==='string'&&subject.length>0&&subject.length<=255&&!subject.includes('\0'));
      const account=await db.query(`INSERT INTO dge_identity.accounts(id,issuer,subject,created_at) VALUES($1,$2,$3,$4)
        ON CONFLICT(issuer,subject) DO UPDATE SET subject=excluded.subject RETURNING id,status,auth_epoch`,[randomUUID(),issuer,subject,now()]);
      deny(account.rows[0].status==='active');
      await db.query(`UPDATE dge_identity.sessions SET revoked_at=$2 WHERE token_digest IN (
        SELECT token_digest FROM dge_identity.sessions WHERE account_id=$1 AND revoked_at IS NULL AND expires_at>$2
        ORDER BY created_at DESC,token_digest DESC OFFSET $3)`,[account.rows[0].id,issuedAt,maxSessions-1]);
      const sessionToken=token(),csrfToken=token(),expiresAt=new Date(now().getTime()+sessionSeconds*1000);
      await db.query('INSERT INTO dge_identity.sessions(token_digest,account_id,auth_epoch,csrf_digest,created_at,expires_at,authenticated_at,authentication_assurance) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[digest('session',sessionToken),account.rows[0].id,account.rows[0].auth_epoch,digest('csrf',csrfToken),issuedAt,expiresAt,new Date(authenticatedAt),authenticationAssurance]);
      return {accountId:account.rows[0].id,sessionToken,csrfToken,expiresAt:expiresAt.toISOString(),authenticationAssurance};
    }),
    account:sessionToken=>transaction(async db=>({accountId:(await session(db,{sessionToken})).id})),
    sessionInfo:sessionToken=>transaction(async db=>{
      const actor=await session(db,{sessionToken});
      return {accountId:actor.id,expiresAt:new Date(actor.expires_at).toISOString(),authenticatedAt:new Date(actor.authenticated_at).toISOString(),authenticationMethod:actor.authentication_method,authenticationAssurance:actor.authentication_assurance,passkeyStepUpExpiresAt:actor.passkey_verified_at?new Date(date(actor.passkey_verified_at)+300000).toISOString():null,recoveryRestricted:actor.authentication_method==='recovery'};
    }),
    organizations:(credentials,{after=null,limit=100}={})=>transaction(async db=>{
      deny((after===null||uuid(after))&&Number.isSafeInteger(limit)&&limit>=1&&limit<=200);
      const actor=await session(db,credentials);
      await db.query("SELECT set_config('dge.account_id',$1,true)",[actor.id]);
      const rows=(await db.query('SELECT tenant_id AS "tenantId",role FROM dge_identity.memberships WHERE account_id=$1 AND active=true AND ($2::uuid IS NULL OR tenant_id>$2::uuid) ORDER BY tenant_id LIMIT $3',[actor.id,after,limit+1])).rows;
      return {items:rows.slice(0,limit),nextCursor:rows.length>limit?rows[limit-1].tenantId:null};
    }),
    issueRecoveryCodes:credentials=>transaction(async db=>{
      const actor=await session(db,credentials,true,true,false,'multifactor'),createdAt=now(),expiresAt=new Date(createdAt.getTime()+30*86400000);
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",['recovery-codes:'+actor.id]);
      await db.query('UPDATE dge_identity.recovery_codes SET revoked_at=$2 WHERE account_id=$1 AND consumed_at IS NULL AND revoked_at IS NULL',[actor.id,createdAt]);
      const recoveryCodes=[];
      for(let index=0;index<8;index++){
        const recoveryCode=token();recoveryCodes.push(recoveryCode);
        await db.query('INSERT INTO dge_identity.recovery_codes(id,account_id,token_digest,created_at,expires_at) VALUES($1,$2,$3,$4,$5)',[randomUUID(),actor.id,digest('recovery',recoveryCode),createdAt,expiresAt]);
      }
      await db.query("INSERT INTO dge_identity.account_security_events(id,account_id,kind,occurred_at) VALUES($1,$2,'recovery-codes-issued',$3)",[randomUUID(),actor.id,createdAt]);
      return {accountId:actor.id,recoveryCodes,expiresAt:expiresAt.toISOString()};
    }),
    recoverAccount:(accountId,recoveryCode)=>transaction(async db=>{
      deny(uuid(accountId)&&isToken(recoveryCode));const redeemedAt=now();
      const code=(await db.query(`SELECT id FROM dge_identity.recovery_codes WHERE account_id=$1 AND token_digest=$2
        AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at>$3 FOR UPDATE`,[accountId,digest('recovery',recoveryCode),redeemedAt])).rows[0];
      deny(code);
      await db.query('UPDATE dge_identity.recovery_codes SET consumed_at=$2 WHERE id=$1',[code.id,redeemedAt]);
      const account=(await db.query("UPDATE dge_identity.accounts SET auth_epoch=auth_epoch+1 WHERE id=$1 AND status='active' RETURNING auth_epoch",[accountId])).rows[0];deny(account);
      await db.query('UPDATE dge_identity.sessions SET revoked_at=$2 WHERE account_id=$1 AND revoked_at IS NULL',[accountId,redeemedAt]);
      const sessionToken=token(),csrfToken=token(),expiresAt=new Date(redeemedAt.getTime()+900000);
      await db.query(`INSERT INTO dge_identity.sessions(token_digest,account_id,auth_epoch,csrf_digest,created_at,expires_at,authenticated_at,authentication_method)
        VALUES($1,$2,$3,$4,$5,$6,$5,'recovery')`,[digest('session',sessionToken),accountId,account.auth_epoch,digest('csrf',csrfToken),redeemedAt,expiresAt]);
      await db.query("INSERT INTO dge_identity.account_security_events(id,account_id,kind,occurred_at) VALUES($1,$2,'recovery-code-redeemed',$3)",[randomUUID(),accountId,redeemedAt]);
      return {accountId,sessionToken,csrfToken,expiresAt:expiresAt.toISOString(),authenticationMethod:'recovery',recoveryRestricted:true};
    }),
    beginPasskeyEnrollment:credentials=>transaction(async db=>{
      deny(typeof verifyPasskeyRegistration==='function'&&attestationPolicy,'PASSKEY_VERIFIER_UNAVAILABLE');
      const {actor,challenge,expiresAt}=await createPasskeyChallenge(db,credentials,'enrollment',{recent:true,requiredAssurance:'multifactor'});
      const excludeCredentials=(await db.query('SELECT credential_id AS id,transports FROM dge_identity.passkey_credentials WHERE account_id=$1 AND revoked_at IS NULL ORDER BY created_at,id',[actor.id])).rows;
      return {challenge,expiresAt:expiresAt.toISOString(),rpId:site.hostname,user:{id:actor.id},excludeCredentials,attestationPolicyId:attestationPolicy.id};
    }),
    finishPasskeyEnrollment:async(credentials,challenge,response)=>{
      deny(typeof verifyPasskeyRegistration==='function','PASSKEY_VERIFIER_UNAVAILABLE');
      const consumed=await transaction(async db=>{const {actor,usedAt}=await consumePasskeyChallenge(db,credentials,challenge,'enrollment',{recent:true,requiredAssurance:'multifactor'});return {accountId:actor.id,usedAt};});
      const result=await verifyPasskeyRegistration({response,expectedChallenge:challenge,expectedOrigin:origin,expectedRpId:site.hostname,accountId:consumed.accountId,attestationPolicy});
      const credential=result?.credential;
      deny(result?.verified===true&&credential&&base64url(credential.id)&&credential.id.length<=2048&&base64url(credential.publicKey)&&Number.isSafeInteger(credential.counter)&&credential.counter>=0&&transports(credential.transports??[])&&typeof credential.backedUp==='boolean'&&
        attestationFormat(credential.attestationFormat)&&attestationPolicy.allowedFormats.includes(credential.attestationFormat)&&aaguid(credential.aaguid)&&attestationPolicy.allowedAaguids.includes(credential.aaguid),'PASSKEY_ATTESTATION_POLICY_REJECTED');
      return transaction(async db=>{const actor=await session(db,credentials,true,true,false,'multifactor');deny(actor.id===consumed.accountId);const id=randomUUID();
        try{await db.query('INSERT INTO dge_identity.passkey_credentials(id,account_id,credential_id,public_key,sign_count,transports,backed_up,created_at,attestation_policy_id,attestation_format,aaguid) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',[id,actor.id,credential.id,credential.publicKey,credential.counter,credential.transports??[],credential.backedUp,consumed.usedAt,attestationPolicy.id,credential.attestationFormat,credential.aaguid]);}
        catch(error){if(error?.code==='23505')throw new AccessError('PASSKEY_ALREADY_REGISTERED');throw error;}
        await securityEvent(db,actor.id,'passkey-enrolled',consumed.usedAt);return {credentialId:id,createdAt:consumed.usedAt.toISOString(),attestationPolicyId:attestationPolicy.id};});
    },
    beginPasskeyAuthentication:credentials=>transaction(async db=>{
      const {actor,challenge,expiresAt}=await createPasskeyChallenge(db,credentials,'authentication',{allowRecoveryWrite:true});
      const allowCredentials=(await db.query('SELECT credential_id AS id,transports FROM dge_identity.passkey_credentials WHERE account_id=$1 AND revoked_at IS NULL ORDER BY created_at,id',[actor.id])).rows;
      deny(allowCredentials.length,'PASSKEY_NOT_ENROLLED');
      return {challenge,expiresAt:expiresAt.toISOString(),rpId:site.hostname,allowCredentials};
    }),
    finishPasskeyAuthentication:async(credentials,challenge,response)=>{
      deny(typeof verifyPasskeyAuthentication==='function','PASSKEY_VERIFIER_UNAVAILABLE');
      const consumed=await transaction(async db=>{const {actor,usedAt}=await consumePasskeyChallenge(db,credentials,challenge,'authentication',{allowRecoveryWrite:true});
        const records=(await db.query('SELECT id,credential_id AS "credentialId",public_key AS "publicKey",sign_count::text AS "counter",transports,backed_up AS "backedUp" FROM dge_identity.passkey_credentials WHERE account_id=$1 AND revoked_at IS NULL ORDER BY created_at,id',[actor.id])).rows.map(item=>({...item,counter:Number(item.counter)}));return {accountId:actor.id,usedAt,records};});
      const records=consumed.records;
      deny(records.length,'PASSKEY_NOT_ENROLLED');
      const result=await verifyPasskeyAuthentication({response,credentials:records,expectedChallenge:challenge,expectedOrigin:origin,expectedRpId:site.hostname,accountId:consumed.accountId});
      deny(result?.verified===true&&result.userVerified===true&&base64url(result.credentialId)&&result.credentialId.length<=2048&&Number.isSafeInteger(result.newCounter)&&result.newCounter>=0,'PASSKEY_VERIFICATION_FAILED');
      const verified=records.find(item=>item.credentialId===result.credentialId);deny(verified,'PASSKEY_VERIFICATION_FAILED');
      return transaction(async db=>{const actor=await session(db,credentials,true,false,true);deny(actor.id===consumed.accountId);
        const credential=(await db.query('SELECT id,sign_count::text AS counter FROM dge_identity.passkey_credentials WHERE id=$1 AND account_id=$2 AND revoked_at IS NULL FOR UPDATE',[verified.id,actor.id])).rows[0];deny(credential,'PASSKEY_VERIFICATION_FAILED');const current=Number(credential.counter);
        deny((current===0&&result.newCounter===0)||result.newCounter>current,'PASSKEY_COUNTER_ROLLBACK');
        await db.query('UPDATE dge_identity.passkey_credentials SET sign_count=$2,last_used_at=$3 WHERE id=$1',[credential.id,result.newCounter,consumed.usedAt]);
        await db.query('UPDATE dge_identity.sessions SET passkey_verified_at=$2,passkey_credential_id=$3 WHERE token_digest=$1',[actor.token_digest,consumed.usedAt,credential.id]);
        await securityEvent(db,actor.id,'passkey-authenticated',consumed.usedAt);return {verified:true,expiresAt:new Date(consumed.usedAt.getTime()+300000).toISOString()};});
    },
    passkeys:credentials=>transaction(async db=>{
      const actor=await session(db,credentials);
      const items=(await db.query(`SELECT id,created_at AS "createdAt",last_used_at AS "lastUsedAt",backed_up AS "backedUp",
        attestation_policy_id AS "attestationPolicyId",attestation_format AS "attestationFormat",aaguid::text
        FROM dge_identity.passkey_credentials WHERE account_id=$1 AND revoked_at IS NULL ORDER BY created_at,id`,[actor.id])).rows;
      return {items};
    }),
    revokePasskey:(credentials,credentialId)=>transaction(async db=>{
      const actor=await session(db,credentials,true,true,false,'multifactor');deny(uuid(credentialId));const revokedAt=now();
      const existing=await db.query('SELECT id FROM dge_identity.passkey_credentials WHERE id=$1 AND account_id=$2 AND revoked_at IS NULL',[credentialId,actor.id]);
      deny(existing.rows.length);
      await db.query('UPDATE dge_identity.sessions SET passkey_verified_at=NULL,passkey_credential_id=NULL WHERE account_id=$1 AND passkey_credential_id=$2',[actor.id,credentialId]);
      const changed=await db.query('UPDATE dge_identity.passkey_credentials SET revoked_at=$3 WHERE id=$1 AND account_id=$2 AND revoked_at IS NULL RETURNING id',[credentialId,actor.id,revokedAt]);
      deny(changed.rows.length);
      const devices=await db.query('UPDATE dge_identity.authorized_devices SET revoked_at=$2 WHERE passkey_credential_id=$1 AND revoked_at IS NULL RETURNING id',[credentialId,revokedAt]);
      await securityEvent(db,actor.id,'passkey-revoked',revokedAt);
      return {revoked:true,devicesRevoked:devices.rows.length};
    }),
    restoreProviderIdentity:(credentials,{issuer,subject,authenticatedAt,authenticationMethods=[]})=>transaction(async db=>{
      const restoredAt=now(),actor=await session(db,credentials,true,false,true);
      deny(actor.authentication_method==='recovery','RECOVERY_SESSION_REQUIRED');
      deny(actor.passkey_credential_id&&actor.passkey_verified_at&&date(actor.passkey_verified_at)>restoredAt.getTime()-300000,'PASSKEY_STEP_UP_REQUIRED');
      deny(Array.isArray(authenticationMethods)&&authenticationMethods.length<=16&&authenticationMethods.every(value=>typeof value==='string'&&value.length>0&&value.length<=64&&!value.includes('\0')));
      const authenticationAssurance=authenticationMethods.includes('hwk')?'hardware-bound':authenticationMethods.includes('mfa')?'multifactor':'primary';
      deny(Number.isSafeInteger(authenticatedAt)&&authenticatedAt>=restoredAt.getTime()-300000&&authenticatedAt<=restoredAt.getTime()+30000);
      const uri=new URL(issuer);
      deny(uri.protocol==='https:'&&!uri.username&&!uri.password&&!uri.hash&&!uri.search&&issuer.length<=2048);
      deny(typeof subject==='string'&&subject.length>0&&subject.length<=255&&!subject.includes('\0'));
      let account;
      try{
        account=(await db.query("UPDATE dge_identity.accounts SET issuer=$2,subject=$3,auth_epoch=auth_epoch+1 WHERE id=$1 AND status='active' RETURNING id,auth_epoch",[actor.id,issuer,subject])).rows[0];
      }catch(error){if(error?.code==='23505')throw new AccessError('IDENTITY_ALREADY_LINKED');throw error;}
      deny(account);
      await db.query('UPDATE dge_identity.sessions SET revoked_at=$2 WHERE account_id=$1 AND revoked_at IS NULL',[actor.id,restoredAt]);
      const sessionToken=token(),csrfToken=token(),expiresAt=new Date(restoredAt.getTime()+sessionSeconds*1000);
      await db.query("INSERT INTO dge_identity.sessions(token_digest,account_id,auth_epoch,csrf_digest,created_at,expires_at,authenticated_at,authentication_method,authentication_assurance) VALUES($1,$2,$3,$4,$5,$6,$7,'oidc',$8)",[digest('session',sessionToken),actor.id,account.auth_epoch,digest('csrf',csrfToken),restoredAt,expiresAt,new Date(authenticatedAt),authenticationAssurance]);
      await securityEvent(db,actor.id,'provider-identity-restored',restoredAt);
      return {accountId:actor.id,sessionToken,csrfToken,expiresAt:expiresAt.toISOString(),authenticationMethod:'oidc',authenticationAssurance};
    }),
    devices:credentials=>transaction(async db=>{
      const actor=await session(db,credentials);
      const items=(await db.query('SELECT id,key_thumbprint AS "keyThumbprint",authorized_at AS "authorizedAt" FROM dge_identity.authorized_devices WHERE account_id=$1 AND revoked_at IS NULL ORDER BY authorized_at,id',[actor.id])).rows;
      return {items};
    }),
    authorizeDevice:(credentials,keyThumbprint)=>transaction(async db=>{
      const actor=await session(db,credentials,true);deny(thumbprint(keyThumbprint));
      deny(actor.passkey_credential_id&&actor.passkey_verified_at&&date(actor.passkey_verified_at)>now().getTime()-300000,'PASSKEY_STEP_UP_REQUIRED');
      const active=await db.query('SELECT id FROM dge_identity.passkey_credentials WHERE id=$1 AND account_id=$2 AND revoked_at IS NULL FOR SHARE',[actor.passkey_credential_id,actor.id]);
      deny(active.rows.length,'PASSKEY_STEP_UP_REQUIRED');
      const id=randomUUID(),authorizedAt=now();
      await db.query(`INSERT INTO dge_identity.authorized_devices(id,account_id,passkey_credential_id,key_thumbprint,authorized_at) VALUES($1,$2,$3,$4,$5)
        ON CONFLICT(account_id,key_thumbprint) DO UPDATE SET passkey_credential_id=excluded.passkey_credential_id,authorized_at=excluded.authorized_at,revoked_at=NULL`,[id,actor.id,actor.passkey_credential_id,keyThumbprint,authorizedAt]);
      await securityEvent(db,actor.id,'device-authorized',authorizedAt);return {authorized:true,keyThumbprint,authorizedAt:authorizedAt.toISOString()};
    }),
    revokeDevice:(credentials,deviceId)=>transaction(async db=>{
      const actor=await session(db,credentials,true);deny(uuid(deviceId));const revokedAt=now();
      const changed=await db.query('UPDATE dge_identity.authorized_devices SET revoked_at=$3 WHERE id=$1 AND account_id=$2 AND revoked_at IS NULL RETURNING id',[deviceId,actor.id,revokedAt]);deny(changed.rows.length);
      await securityEvent(db,actor.id,'device-revoked',revokedAt);return {revoked:true};
    }),
    // Trusted server extension boundary: authorization and the operation share one transaction.
    withTenant:(credentials,tenantId,{write=false,recent=false,roles=['owner','admin','editor','participant','viewer']}={},operation)=>transaction(async db=>{
      deny(typeof operation==='function'&&Array.isArray(roles)&&roles.every(role));
      const actor=await tenantContext(db,credentials,tenantId,write,recent);deny(roles.includes(actor.role));
      return operation(db,{accountId:actor.id,role:actor.role,tenantId});
    }),
    createTenant:credentials=>transaction(async db=>{
      const actor=await session(db,credentials,true,true),id=randomUUID();
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",['workspace-create:'+actor.id]);
      await db.query("SELECT set_config('dge.account_id',$1,true)",[actor.id]);
      const owned=(await db.query("SELECT count(*)::int AS n FROM dge_identity.memberships WHERE account_id=$1 AND role='owner' AND active=true",[actor.id])).rows[0].n;
      deny(owned<maxOwnedWorkspaces,'WORKSPACE_LIMIT_REACHED');await scope(db,id);
      await db.query('INSERT INTO dge_identity.tenants(id,created_at) VALUES($1,$2)',[id,now()]);
      await db.query("INSERT INTO dge_identity.memberships(tenant_id,account_id,role,updated_at) VALUES($1,$2,'owner',$3)",[id,actor.id,now()]);
      await event(db,id,actor.id,actor.id,'tenant-created');return {tenantId:id};
    }),
    members:(credentials,tenantId,{after=null,limit=100}={})=>transaction(async db=>{
      deny((after===null||uuid(after))&&Number.isSafeInteger(limit)&&limit>=1&&limit<=200);
      const actor=await tenantContext(db,credentials,tenantId);
      const rows=(await db.query('SELECT account_id AS "accountId",role FROM dge_identity.memberships WHERE tenant_id=$1 AND active=true AND ($2::uuid IS NULL OR account_id>$2::uuid) ORDER BY account_id LIMIT $3',[tenantId,after,limit+1])).rows;
      return {items:rows.slice(0,limit),nextCursor:rows.length>limit?rows[limit-1].accountId:null,viewerRole:actor.role};
    }),
    invite:(credentials,tenantId,accountId,requestedRole)=>transaction(async db=>{
      const actor=await tenantContext(db,credentials,tenantId,true);manage(actor);
      deny(uuid(accountId)&&role(requestedRole)&&requestedRole!=='owner');
      if(requestedRole==='admin')deny(actor.role==='owner');
      const target=await db.query("SELECT id FROM dge_identity.accounts WHERE id=$1 AND status='active'",[accountId]);deny(target.rows.length);
      const pending=(await db.query('SELECT count(*)::int AS n FROM dge_identity.invitations WHERE tenant_id=$1 AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at>$2',[tenantId,now()])).rows[0].n;
      deny(pending<maxPendingInvitations,'INVITATION_LIMIT_REACHED');
      const invitationToken=token();
      const invitationId=randomUUID(),expiresAt=new Date(now().getTime()+86400000);
      await db.query('INSERT INTO dge_identity.invitations(id,token_digest,tenant_id,account_id,role,expires_at,created_by) VALUES($1,$2,$3,$4,$5,$6,$7)',[invitationId,digest('invite',invitationToken),tenantId,accountId,requestedRole,expiresAt,actor.id]);
      await event(db,tenantId,actor.id,accountId,'invited');return {invitationToken,invitationId,expiresAt:expiresAt.toISOString()};
    }),
    invitations:(credentials,tenantId,{after=null,limit=100}={})=>transaction(async db=>{
      deny((after===null||uuid(after))&&Number.isSafeInteger(limit)&&limit>=1&&limit<=200);
      const actor=await tenantContext(db,credentials,tenantId);manage(actor);
      const rows=(await db.query(`SELECT id,"account_id" AS "accountId",role,expires_at AS "expiresAt",created_by AS "createdBy" FROM dge_identity.invitations
        WHERE tenant_id=$1 AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at>$2 AND ($3::uuid IS NULL OR id>$3::uuid) ORDER BY id LIMIT $4`,[tenantId,now(),after,limit+1])).rows;
      return {items:rows.slice(0,limit),nextCursor:rows.length>limit?rows[limit-1].id:null};
    }),
    revokeInvitation:(credentials,tenantId,invitationId)=>transaction(async db=>{
      const actor=await tenantContext(db,credentials,tenantId,true);manage(actor);deny(uuid(invitationId));
      const invitation=(await db.query('SELECT account_id,role,consumed_at,revoked_at FROM dge_identity.invitations WHERE id=$1 AND tenant_id=$2 FOR UPDATE',[invitationId,tenantId])).rows[0];deny(invitation);
      if(invitation.role==='admin')deny(actor.role==='owner');
      deny(!invitation.consumed_at,'INVITATION_ALREADY_USED');
      if(!invitation.revoked_at){await db.query('UPDATE dge_identity.invitations SET revoked_at=$3 WHERE id=$1 AND tenant_id=$2',[invitationId,tenantId,now()]);await event(db,tenantId,actor.id,invitation.account_id,'invitation-revoked');}
      return {revoked:true};
    }),
    acceptInvitation:(credentials,tenantId,invitationToken)=>transaction(async db=>{
      const actor=await session(db,credentials,true,true);deny(isToken(invitationToken));await scope(db,tenantId);
      const tenant=await db.query('SELECT id FROM dge_identity.tenants WHERE id=$1 FOR UPDATE',[tenantId]);deny(tenant.rows.length);
      const invitation=await db.query(`UPDATE dge_identity.invitations SET consumed_at=$1 WHERE token_digest=$2 AND tenant_id=$3
        AND account_id=$4 AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at>$1 RETURNING role`,[now(),digest('invite',invitationToken),tenantId,actor.id]);deny(invitation.rows.length);
      const existing=await db.query('SELECT active FROM dge_identity.memberships WHERE tenant_id=$1 AND account_id=$2',[tenantId,actor.id]);deny(!existing.rows[0]?.active);
      await db.query(`INSERT INTO dge_identity.memberships(tenant_id,account_id,role,updated_at) VALUES($1,$2,$3,$4)
        ON CONFLICT(tenant_id,account_id) DO UPDATE SET active=true,role=excluded.role,updated_at=excluded.updated_at`,[tenantId,actor.id,invitation.rows[0].role,now()]);
      await event(db,tenantId,actor.id,actor.id,'joined');return {joined:true,tenantId,role:invitation.rows[0].role};
    }),
    changeMember:(credentials,tenantId,accountId,nextRole)=>transaction(async db=>{
      const actor=await tenantContext(db,credentials,tenantId,true);manage(actor);deny(uuid(accountId)&&(nextRole===null||role(nextRole)));
      const target=(await db.query('SELECT role FROM dge_identity.memberships WHERE tenant_id=$1 AND account_id=$2 AND active=true',[tenantId,accountId])).rows[0];deny(target);
      if(target.role==='owner'||target.role==='admin'||nextRole==='owner'||nextRole==='admin')deny(actor.role==='owner');
      if(target.role==='owner'&&nextRole!=='owner'){
        const count=await db.query("SELECT count(*)::int AS n FROM dge_identity.memberships WHERE tenant_id=$1 AND role='owner' AND active=true",[tenantId]);deny(count.rows[0].n>1);
      }
      await db.query('UPDATE dge_identity.memberships SET role=COALESCE($3,role),active=$4,updated_at=$5 WHERE tenant_id=$1 AND account_id=$2',[tenantId,accountId,nextRole,nextRole!==null,now()]);
      // A removed member cannot reuse an invitation issued before removal.
      if(nextRole===null)await db.query('UPDATE dge_identity.invitations SET revoked_at=$3 WHERE tenant_id=$1 AND account_id=$2 AND consumed_at IS NULL',[tenantId,accountId,now()]);
      await event(db,tenantId,actor.id,accountId,nextRole===null?'removed':'role-changed');return {changed:true};
    }),
    logout:credentials=>transaction(async db=>{
      await session(db,credentials,true,false,true);
      await db.query('UPDATE dge_identity.sessions SET revoked_at=$2 WHERE token_digest=$1',[digest('session',credentials.sessionToken),now()]);return {revoked:true};
    }),
    logoutAll:credentials=>transaction(async db=>{
      const actor=await session(db,credentials,true);
      await db.query('UPDATE dge_identity.accounts SET auth_epoch=auth_epoch+1 WHERE id=$1',[actor.id]);return {revoked:true};
    }),
    putLogin:(state,browserToken,secret)=>transaction(async db=>{
      deny(isToken(state)&&isToken(browserToken)&&typeof secret==='object');
      const stateDigest=digest('login-state',state),iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',stateKey,iv);
      cipher.setAAD(Buffer.from('dge-login-v1:'+stateDigest));
      const encrypted=Buffer.concat([cipher.update(JSON.stringify(secret),'utf8'),cipher.final()]);
      deny(encrypted.length<8192);
      const sealed=Buffer.concat([iv,cipher.getAuthTag(),encrypted]).toString('base64url');
      await db.query('INSERT INTO dge_identity.login_challenges(state_digest,browser_digest,sealed_state,expires_at) VALUES($1,$2,$3,$4)',[stateDigest,digest('login-browser',browserToken),sealed,new Date(now().getTime()+600000)]);
    }),
    consumeLogin:(state,browserToken)=>transaction(async db=>{
      deny(isToken(state)&&isToken(browserToken));const stateDigest=digest('login-state',state);
      const result=await db.query('DELETE FROM dge_identity.login_challenges WHERE state_digest=$1 AND browser_digest=$2 AND expires_at>$3 RETURNING sealed_state',[stateDigest,digest('login-browser',browserToken),now()]);deny(result.rows.length);
      const bytes=Buffer.from(result.rows[0].sealed_state,'base64url'),decipher=createDecipheriv('aes-256-gcm',stateKey,bytes.subarray(0,12));
      decipher.setAAD(Buffer.from('dge-login-v1:'+stateDigest));decipher.setAuthTag(bytes.subarray(12,28));
      return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)),decipher.final()]).toString('utf8'));
    }),
    pruneExpiredLogins:()=>transaction(async db=>(await db.query('DELETE FROM dge_identity.login_challenges WHERE state_digest IN (SELECT state_digest FROM dge_identity.login_challenges WHERE expires_at<=$1 ORDER BY expires_at LIMIT 500) RETURNING state_digest',[now()])).rows.length)
  });
}

export function sessionCookie(sessionToken,{maxAge=28800}={}) {
  deny(isToken(sessionToken)&&Number.isSafeInteger(maxAge)&&maxAge>=0&&maxAge<=86400);
  return `__Host-dge_session=${sessionToken}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}
