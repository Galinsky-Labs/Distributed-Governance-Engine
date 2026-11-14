import {createHash} from 'node:crypto';

/**
 * Confidential version store. This service NEVER accepts or interprets a legal
 * document or Yjs plaintext. A trusted, separate device/epoch authorizer is
 * mandatory; there is deliberately no insecure production default.
 */
export class PrivateDocumentError extends Error {
 constructor(code,status=400){super(code);this.code=code;this.status=status;}
}
const UUID=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const MAX_CIPHERTEXT=2_900_000;
const MAX_VERSIONS=1000;
const allowWrite=['owner','admin','editor'];
function requireValue(ok,code,status){if(!ok)throw new PrivateDocumentError(code,status);}
function strictObject(value,fields) {
 requireValue(value&&typeof value==='object'&&!Array.isArray(value)&&
  Object.getPrototypeOf(value)===Object.prototype&&
  Object.getOwnPropertySymbols(value).length===0&&
  Object.keys(value).sort().join(',')===fields.slice().sort().join(',')&&
  Object.keys(value).every(key=>{
   const descriptor=Object.getOwnPropertyDescriptor(value,key);
   return descriptor?.enumerable===true&&Object.hasOwn(descriptor,'value');
  }),'INVALID_PRIVATE_FIELDS');
}
function binary(value,min,max){
 requireValue(typeof value==='string'&&value.length>=1&&value.length<=Math.ceil(max*4/3)+8&&
  /^[A-Za-z0-9_-]+$/.test(value),'INVALID_PRIVATE_ENVELOPE');
 const bytes=Buffer.from(value,'base64url');
 requireValue(bytes.length>=min&&bytes.length<=max&&bytes.toString('base64url')===value,'INVALID_PRIVATE_ENVELOPE');
 return bytes;
}
function parseEnvelope(envelope) {
 strictObject(envelope,['version','cipher','keyEpoch','nonce','ciphertext']);
 requireValue(envelope.version===1&&envelope.cipher==='AES-256-GCM'&&
  Number.isSafeInteger(envelope.keyEpoch)&&envelope.keyEpoch>=0&&envelope.keyEpoch<=1000000,
  'INVALID_PRIVATE_ENVELOPE');
 return {
  keyEpoch:envelope.keyEpoch,cipher:'AES-256-GCM',
  nonce:binary(envelope.nonce,12,12),
  ciphertext:binary(envelope.ciphertext,17,MAX_CIPHERTEXT)
 };
}
const hash=(domain,value)=>createHash('sha256').update(domain+'\0').update(JSON.stringify(value)).digest('hex');
function versionDigest({tenantId,documentId,version,keyEpoch,nonce,ciphertext,previousDigest}){
 return hash('dge-encrypted-document-v1',[
  tenantId,documentId,version,keyEpoch,previousDigest,
  nonce.toString('base64url'),ciphertext.toString('base64url')
 ]);
}
function snapshot(row,tenantId,documentId){
 const nonce=Buffer.from(row.nonce),ciphertext=Buffer.from(row.ciphertext);
 requireValue(
  row.digest===versionDigest({tenantId,documentId,version:row.version,
   keyEpoch:row.key_epoch,nonce,ciphertext,previousDigest:row.previous_digest??null}),
  'PRIVATE_INTEGRITY_ERROR',503
 );
 return {
  visibility:'private',documentId,version:row.version,keyEpoch:row.key_epoch,
  cipher:row.cipher,nonce:nonce.toString('base64url'),
  ciphertext:ciphertext.toString('base64url'),digest:row.digest,
  previousDigest:row.previous_digest??null
 };
}
function validateIds(tenantId,documentId){requireValue(UUID.test(tenantId),'INVALID_WORKSPACE');requireValue(UUID.test(documentId),'INVALID_DOCUMENT_ID');}
const commandId=id=>requireValue(UUID.test(id),'INVALID_COMMAND_ID');
const positiveVersion=n=>Number.isSafeInteger(n)&&n>=1&&n<=1000000;

/**
 * Neither the account system nor an HTTP body may assert device authority.
 * authorizeDevice and authorizeEpochAdvance are installed ONLY by a trusted
 * server bootstrap backed by verified device membership and group key policy.
 */
export function createPrivateDocumentStore({
 identity,authorizeDevice,authorizeEpochAdvance,clock=Date.now,
 maxDocuments=100,maxVersions=MAX_VERSIONS,maxStoredBytes=30_000_000
}={}) {
 if(typeof identity?.withTenant!=='function'||typeof authorizeDevice!=='function'||
    authorizeEpochAdvance!==undefined&&typeof authorizeEpochAdvance!=='function')
  throw Error('Verified private device authorization adapter required');
 for(const n of [maxDocuments,maxVersions]){
  if(!Number.isSafeInteger(n)||n<1||n>1000000)throw Error('Invalid private document limit');
 }
 if(!Number.isSafeInteger(maxStoredBytes)||maxStoredBytes<1||maxStoredBytes>1000000000)
  throw Error('Invalid private storage limit');
 const now=()=>{
  const value=clock();if(!Number.isSafeInteger(value)||value<0)throw Error('Invalid private clock');
  return new Date(value);
 };
 const context=(credentials,tenantId,write,operation)=>identity.withTenant(
  credentials,tenantId,{write,roles:write?allowWrite:undefined},operation);
 async function requireDevice(db,actor,credentials,documentId,keyEpoch,operation,deviceId){
  const accepted=await authorizeDevice({db,actor,credentials,tenantId:actor.tenantId,documentId,keyEpoch,operation,deviceId});
  requireValue(accepted===true,'PRIVATE_DEVICE_NOT_AUTHORIZED',403);
 }
 async function prior(db,tenantId,id,requestDigest,documentId){
  const row=(await db.query(
   'SELECT * FROM dge_private.versions WHERE tenant_id=$1 AND command_id=$2',
   [tenantId,id]
  )).rows[0];
  if(!row)return null;
  requireValue(row.request_digest===requestDigest,'COMMAND_REUSED',409);
  requireValue(row.document_id===documentId,'COMMAND_REUSED',409);
  return snapshot(row,tenantId,documentId);
 }
 async function append(db,actor,documentId,parsed,{
  version,previousDigest,id,requestDigest
 }){
  const digest=versionDigest({tenantId:actor.tenantId,documentId,version,
   keyEpoch:parsed.keyEpoch,nonce:parsed.nonce,ciphertext:parsed.ciphertext,previousDigest});
  const at=now();
  await db.query(
   'INSERT INTO dge_private.usage(tenant_id,stored_bytes) VALUES($1,0) ON CONFLICT DO NOTHING',
   [actor.tenantId]
  );
  const bytes=parsed.nonce.length+parsed.ciphertext.length;
  const usage=(await db.query(
   'UPDATE dge_private.usage SET stored_bytes=stored_bytes+$2 WHERE tenant_id=$1 AND stored_bytes+$2<=$3 RETURNING stored_bytes',
   [actor.tenantId,bytes,maxStoredBytes]
  )).rows;
  requireValue(usage.length===1,'PRIVATE_STORAGE_LIMIT_REACHED',429);
  await db.query(
   'INSERT INTO dge_private.versions(tenant_id,document_id,version,key_epoch,cipher,nonce,ciphertext,digest,previous_digest,command_id,request_digest,actor_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)',
   [actor.tenantId,documentId,version,parsed.keyEpoch,parsed.cipher,parsed.nonce,
    parsed.ciphertext,digest,previousDigest,id,requestDigest,actor.accountId,at]
  );
  return {
   visibility:'private',documentId,version,keyEpoch:parsed.keyEpoch,cipher:parsed.cipher,
   nonce:parsed.nonce.toString('base64url'),ciphertext:parsed.ciphertext.toString('base64url'),
   digest,previousDigest
  };
 }
 return Object.freeze({
  async create(credentials,tenantId,payload,{deviceId}={}){
   strictObject(payload,['documentId','envelope','commandId']);
   const {documentId,envelope,commandId:id}=payload;
   validateIds(tenantId,documentId);commandId(id);
   const parsed=parseEnvelope(envelope);
   const requestDigest=hash('dge-private-document-command-v1',{action:'create',documentId,envelope});
   return context(credentials,tenantId,true,async(db,actor)=>{
    await requireDevice(db,actor,credentials,documentId,parsed.keyEpoch,'create',deviceId);
    const previous=await prior(db,tenantId,id,requestDigest,documentId);
    if(previous)return previous;
    const count=(await db.query(
     'SELECT count(*)::int AS n FROM dge_private.documents WHERE tenant_id=$1',[tenantId]
    )).rows[0].n;
    requireValue(count<maxDocuments,'PRIVATE_DOCUMENT_LIMIT_REACHED',429);
    const at=now();
    const digest=versionDigest({tenantId,documentId,version:1,keyEpoch:parsed.keyEpoch,
     nonce:parsed.nonce,ciphertext:parsed.ciphertext,previousDigest:null});
    try {
     await db.query(
      'INSERT INTO dge_private.documents(tenant_id,id,version,key_epoch,current_digest,created_by,created_at) VALUES($1,$2,1,$3,$4,$5,$6)',
      [tenantId,documentId,parsed.keyEpoch,digest,actor.accountId,at]
     );
    }catch(e){
     if(e.code==='23505')throw new PrivateDocumentError('PRIVATE_DOCUMENT_EXISTS',409);
     throw e;
    }
    return append(db,actor,documentId,parsed,{
     version:1,previousDigest:null,id,requestDigest
    });
   });
  },
  async read(credentials,tenantId,documentId,{deviceId}={}){
   validateIds(tenantId,documentId);
   return context(credentials,tenantId,false,async(db,actor)=>{
    const row=(await db.query(
     'SELECT v.*,d.current_digest,d.key_epoch AS pointer_epoch FROM dge_private.documents d JOIN dge_private.versions v ON v.tenant_id=d.tenant_id AND v.document_id=d.id AND v.version=d.version WHERE d.tenant_id=$1 AND d.id=$2',
     [tenantId,documentId]
    )).rows[0];
    requireValue(row,'PRIVATE_DOCUMENT_NOT_FOUND',404);
    requireValue(row.current_digest===row.digest&&row.pointer_epoch===row.key_epoch,'PRIVATE_INTEGRITY_ERROR',503);
    await requireDevice(db,actor,credentials,documentId,row.key_epoch,'read',deviceId);
    return snapshot(row,tenantId,documentId);
   });
  },
  async save(credentials,tenantId,documentId,payload,{deviceId}={}){
   strictObject(payload,['envelope','expectedVersion','commandId']);
   validateIds(tenantId,documentId);commandId(payload.commandId);
   requireValue(positiveVersion(payload.expectedVersion),'INVALID_PRIVATE_VERSION');
   const parsed=parseEnvelope(payload.envelope);
   const requestDigest=hash('dge-private-document-command-v1',{
    action:'save',documentId,expectedVersion:payload.expectedVersion,envelope:payload.envelope
   });
   return context(credentials,tenantId,true,async(db,actor)=>{
    await requireDevice(db,actor,credentials,documentId,parsed.keyEpoch,'save',deviceId);
    const replay=await prior(db,tenantId,payload.commandId,requestDigest,documentId);
    if(replay)return replay;
    const row=(await db.query(
     'SELECT * FROM dge_private.documents WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
     [tenantId,documentId]
    )).rows[0];
    requireValue(row,'PRIVATE_DOCUMENT_NOT_FOUND',404);
    requireValue(row.version===payload.expectedVersion,'PRIVATE_VERSION_CONFLICT',409);
    const current=(await db.query(
     'SELECT * FROM dge_private.versions WHERE tenant_id=$1 AND document_id=$2 AND version=$3',
     [tenantId,documentId,row.version]
    )).rows[0];
    requireValue(current&&current.digest===row.current_digest&&current.key_epoch===row.key_epoch,'PRIVATE_INTEGRITY_ERROR',503);
    snapshot(current,tenantId,documentId);
    requireValue(row.version<maxVersions,'PRIVATE_VERSION_LIMIT_REACHED',429);
    if(parsed.keyEpoch!==row.key_epoch) {
     // Several membership commits may precede one rekeyed snapshot; the
     // trusted authorizer binds the target epoch to the ordered group epoch.
     requireValue(parsed.keyEpoch>row.key_epoch&&
      typeof authorizeEpochAdvance==='function','PRIVATE_REKEY_REQUIRED',409);
     const allowed=await authorizeEpochAdvance({db,actor,credentials,tenantId,documentId,
      previousEpoch:row.key_epoch,nextEpoch:parsed.keyEpoch});
     requireValue(allowed===true,'PRIVATE_REKEY_REQUIRED',409);
    }
    const nextVersion=row.version+1;
    const digest=versionDigest({tenantId,documentId,version:nextVersion,
     keyEpoch:parsed.keyEpoch,nonce:parsed.nonce,ciphertext:parsed.ciphertext,
     previousDigest:row.current_digest});
    await db.query(
     'UPDATE dge_private.documents SET version=$3,key_epoch=$4,current_digest=$5 WHERE tenant_id=$1 AND id=$2',
     [tenantId,documentId,nextVersion,parsed.keyEpoch,digest]
    );
    return append(db,actor,documentId,parsed,{
     version:nextVersion,previousDigest:row.current_digest,
     id:payload.commandId,requestDigest
    });
   });
  }
 });
}
