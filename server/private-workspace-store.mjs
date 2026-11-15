import {createHash,randomUUID} from 'node:crypto';
import {PrivateDocumentError} from './private-document-store.mjs';
import {privateGroupId,deviceKeyThumbprintHex,parseDeviceIdentity} from '../src/private-workspace-protocol.mjs';

/**
 * Private workspace coordination service (DCE-003/DCE-008).
 *
 * Holds ONLY public MLS material (signature keys, single-use key packages),
 * opaque group bindings and an ordered handshake mailbox of MLS Commit/Welcome
 * bytes. It never receives plaintext, private keys or exported epoch secrets,
 * and it cannot decrypt anything it stores. Its authorization decisions are a
 * relay/storage access control layered UNDER the end-to-end MLS boundary; the
 * confidentiality of content never depends on them.
 */
const UUID=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const WRITERS=['owner','admin','editor'];
const MANAGERS=['owner','admin'];
const MAX_HANDSHAKE=1_000_000;
const MAX_PACKAGE=65536;
const demand=(ok,code,status=400)=>{if(!ok)throw new PrivateDocumentError(code,status);};
function strict(value,fields){
 demand(value&&typeof value==='object'&&!Array.isArray(value)&&
  Object.getPrototypeOf(value)===Object.prototype&&
  Object.getOwnPropertySymbols(value).length===0&&
  Object.keys(value).sort().join(',')===fields.slice().sort().join(',')&&
  Object.keys(value).every(key=>{
   const descriptor=Object.getOwnPropertyDescriptor(value,key);
   return descriptor?.enumerable===true&&Object.hasOwn(descriptor,'value');
  }),'INVALID_PRIVATE_FIELDS');
}
function bytes(value,min,max,code='INVALID_PRIVATE_MATERIAL'){
 demand(typeof value==='string'&&value.length>=1&&value.length<=Math.ceil(max*4/3)+8&&
  /^[A-Za-z0-9_-]+$/.test(value),code);
 const buffer=Buffer.from(value,'base64url');
 demand(buffer.length>=min&&buffer.length<=max&&buffer.toString('base64url')===value,code);
 return buffer;
}
const b64=value=>Buffer.from(value).toString('base64url');
const sha=(domain,...parts)=>{
 const hash=createHash('sha256').update(domain+'\0');
 for(const part of parts)hash.update(typeof part==='string'?part:Buffer.from(part)).update('\0');
 return hash.digest('hex');
};
const uuid=(value,code='INVALID_DEVICE')=>demand(typeof value==='string'&&UUID.test(value),code);

export function createPrivateWorkspaceStore({
 identity,clock=Date.now,keyPackageTtlMs=30*86400000,maxActivePackages=32,
 maxPackagesPerDevice=1000,maxGroups=100,maxMessagesPerGroup=10000,
 maxStoredBytes=30_000_000,enrollmentWindowMs=600000
}={}){
 if(typeof identity?.withTenant!=='function')throw Error('Identity service required');
 for(const n of [keyPackageTtlMs,maxActivePackages,maxPackagesPerDevice,maxGroups,maxMessagesPerGroup,maxStoredBytes,enrollmentWindowMs])
  if(!Number.isSafeInteger(n)||n<1||n>1e12)throw Error('Invalid private workspace limit');
 const now=()=>{const n=clock();if(!Number.isSafeInteger(n)||n<0)throw Error('Invalid private clock');return new Date(n);};
 const tenant=(credentials,tenantId,options,fn)=>{
  demand(typeof tenantId==='string'&&UUID.test(tenantId),'INVALID_WORKSPACE');
  return identity.withTenant(credentials,tenantId,options,fn);
 };
 // The device must be the actor's own, still-authorized (not revoked) device
 // with published MLS material. A claimed device ID alone grants nothing.
 async function ownDevice(db,actor,deviceId){
  if(typeof deviceId!=='string'||!UUID.test(deviceId))return null;
  return (await db.query(`SELECT k.device_id,k.identity,k.signature_key FROM dge_private.device_keys k
   JOIN dge_identity.authorized_devices d ON d.id=k.device_id
   WHERE k.device_id=$1 AND k.account_id=$2 AND d.account_id=$2 AND d.revoked_at IS NULL`,[deviceId,actor.accountId])).rows[0]??null;
 }
 async function requireOwnDevice(db,actor,deviceId){
  const device=await ownDevice(db,actor,deviceId);
  demand(device,'PRIVATE_DEVICE_NOT_AUTHORIZED',403);
  return device;
 }
 async function usage(db,tenantId,amount){
  await db.query('INSERT INTO dge_private.usage(tenant_id,stored_bytes) VALUES($1,0) ON CONFLICT DO NOTHING',[tenantId]);
  demand((await db.query('UPDATE dge_private.usage SET stored_bytes=stored_bytes+$2 WHERE tenant_id=$1 AND stored_bytes+$2<=$3 RETURNING stored_bytes',
   [tenantId,amount,maxStoredBytes])).rows.length===1,'PRIVATE_STORAGE_LIMIT_REACHED',429);
 }
 async function group(db,tenantId,documentId,lock=false){
  return (await db.query('SELECT * FROM dge_private.groups WHERE tenant_id=$1 AND document_id=$2'+(lock?' FOR UPDATE':''),[tenantId,documentId])).rows[0]??null;
 }
 async function activeMember(db,tenantId,documentId,deviceId){
  return (await db.query('SELECT * FROM dge_private.group_members WHERE tenant_id=$1 AND document_id=$2 AND device_id=$3 AND removed_epoch IS NULL',[tenantId,documentId,deviceId])).rows[0]??null;
 }
 async function roster(db,tenantId,documentId){
  return (await db.query('SELECT device_id FROM dge_private.group_members WHERE tenant_id=$1 AND document_id=$2 AND removed_epoch IS NULL ORDER BY device_id',[tenantId,documentId])).rows.map(r=>r.device_id);
 }
 const messageView=row=>({
  position:row.position,kind:row.kind,epoch:row.epoch,senderDeviceId:row.sender_device_id,
  recipientDeviceId:row.recipient_device_id??null,roster:[...row.roster].sort(),
  payload:b64(row.payload),digest:row.digest
 });
 function messageDigest(tenantId,documentId,position,kind,epoch,sender,recipient,list,payload){
  return sha('dge-private-group-message-v1',tenantId,documentId,String(position),kind,String(epoch),sender,recipient??'',list.join(','),payload);
 }
 return Object.freeze({
  /** Bind the step-up authorized device to exactly one immutable MLS key. */
  publishDevice(credentials,tenantId,payload){
   strict(payload,['deviceId','identity','signatureKey']);
   uuid(payload.deviceId);
   const identityBytes=bytes(payload.identity,1,512),signatureKey=bytes(payload.signatureKey,32,32);
   return tenant(credentials,tenantId,{write:true},async(db,actor)=>{
    const parsed=parseDeviceIdentity(identityBytes);
    demand(parsed&&parsed.accountId===actor.accountId,'INVALID_DEVICE_IDENTITY');
    const authorized=(await db.query('SELECT id,key_thumbprint,authorized_at FROM dge_identity.authorized_devices WHERE id=$1 AND account_id=$2 AND revoked_at IS NULL',[payload.deviceId,actor.accountId])).rows[0];
    demand(authorized,'PRIVATE_DEVICE_NOT_AUTHORIZED',403);
    demand(authorized.key_thumbprint===deviceKeyThumbprintHex(signatureKey,createHash),'DEVICE_KEY_MISMATCH',403);
    const existing=(await db.query('SELECT identity,signature_key FROM dge_private.device_keys WHERE device_id=$1',[payload.deviceId])).rows[0];
    if(existing){
     demand(Buffer.from(existing.identity).equals(identityBytes)&&Buffer.from(existing.signature_key).equals(signatureKey),'DEVICE_KEY_IMMUTABLE',409);
     return {deviceId:payload.deviceId,published:false};
    }
    // Binding a key requires the fresh passkey step-up that authorized it.
    demand(new Date(authorized.authorized_at).getTime()>now().getTime()-enrollmentWindowMs,'PASSKEY_STEP_UP_REQUIRED',403);
    try{
     await db.query('INSERT INTO dge_private.device_keys(device_id,account_id,identity,signature_key,published_at) VALUES($1,$2,$3,$4,$5)',
      [payload.deviceId,actor.accountId,identityBytes,signatureKey,now()]);
    }catch(error){if(error?.code==='23505')throw new PrivateDocumentError('DEVICE_KEY_IMMUTABLE',409);throw error;}
    return {deviceId:payload.deviceId,published:true};
   });
  },
  publishKeyPackages(credentials,tenantId,deviceId,payload){
   uuid(deviceId);strict(payload,['packages']);
   demand(Array.isArray(payload.packages)&&payload.packages.length>=1&&payload.packages.length<=16,'INVALID_KEY_PACKAGES');
   const packages=payload.packages.map(p=>bytes(p,1,MAX_PACKAGE,'INVALID_KEY_PACKAGES'));
   return tenant(credentials,tenantId,{write:true},async(db,actor)=>{
    await requireOwnDevice(db,actor,deviceId);
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",['key-packages:'+deviceId]);
    const at=now();
    const counts=(await db.query('SELECT count(*) FILTER (WHERE consumed_at IS NULL AND expires_at>$2)::int AS active,count(*)::int AS total FROM dge_private.key_packages WHERE device_id=$1',[deviceId,at])).rows[0];
    demand(counts.active+packages.length<=maxActivePackages,'KEY_PACKAGE_LIMIT_REACHED',429);
    demand(counts.total+packages.length<=maxPackagesPerDevice,'KEY_PACKAGE_LIMIT_REACHED',429);
    for(const pkg of packages){
     try{
      await db.query('INSERT INTO dge_private.key_packages(id,device_id,package,package_digest,published_at,expires_at) VALUES($1,$2,$3,$4,$5,$6)',
       [randomUUID(),deviceId,pkg,sha('dge-mls-key-package-v1',pkg),at,new Date(at.getTime()+keyPackageTtlMs)]);
     }catch(error){if(error?.code==='23505')throw new PrivateDocumentError('KEY_PACKAGE_REUSED',409);throw error;}
    }
    return {deviceId,published:packages.length,available:counts.active+packages.length};
   });
  },
  /** Directory of public device material for ACTIVE members of this workspace only. */
  directory(credentials,tenantId){
   return tenant(credentials,tenantId,{},async db=>{
    const rows=(await db.query(`SELECT k.account_id,k.device_id,k.identity,k.signature_key,k.published_at,
      (SELECT count(*) FROM dge_private.key_packages p WHERE p.device_id=k.device_id AND p.consumed_at IS NULL AND p.expires_at>$2)::int AS available
      FROM dge_private.device_keys k
      JOIN dge_identity.authorized_devices d ON d.id=k.device_id AND d.revoked_at IS NULL
      JOIN dge_identity.memberships m ON m.account_id=k.account_id AND m.tenant_id=$1 AND m.active=true
      ORDER BY k.account_id,k.published_at,k.device_id LIMIT 1000`,[tenantId,now()])).rows;
    return {items:rows.map(r=>({accountId:r.account_id,deviceId:r.device_id,identity:b64(r.identity),
     signatureKey:b64(r.signature_key),publishedAt:new Date(r.published_at).toISOString(),availableKeyPackages:r.available}))};
   });
  },
  /** Atomically consume ONE unexpired key package for a member device. */
  claimKeyPackage(credentials,tenantId,deviceId,payload){
   uuid(deviceId);strict(payload,[]);
   return tenant(credentials,tenantId,{write:true,roles:WRITERS},async(db,actor)=>{
    const target=(await db.query(`SELECT k.account_id,k.identity,k.signature_key FROM dge_private.device_keys k
      JOIN dge_identity.authorized_devices d ON d.id=k.device_id AND d.revoked_at IS NULL
      JOIN dge_identity.memberships m ON m.account_id=k.account_id AND m.tenant_id=$2 AND m.active=true
      WHERE k.device_id=$1`,[deviceId,tenantId])).rows[0];
    demand(target,'PRIVATE_DEVICE_NOT_FOUND',404);
    const at=now();
    const pkg=(await db.query('SELECT id,package FROM dge_private.key_packages WHERE device_id=$1 AND consumed_at IS NULL AND expires_at>$2 ORDER BY published_at,id LIMIT 1 FOR UPDATE',[deviceId,at])).rows[0];
    demand(pkg,'KEY_PACKAGE_UNAVAILABLE',409);
    const consumed=await db.query('UPDATE dge_private.key_packages SET consumed_at=$2,consumed_tenant_id=$3,consumed_by=$4 WHERE id=$1 AND consumed_at IS NULL RETURNING id',[pkg.id,at,tenantId,actor.accountId]);
    demand(consumed.rows.length===1,'KEY_PACKAGE_UNAVAILABLE',409);
    return {deviceId,accountId:target.account_id,identity:b64(target.identity),signatureKey:b64(target.signature_key),
     keyPackageId:pkg.id,keyPackage:b64(pkg.package)};
   });
  },
  /** Register the opaque MLS group for a NEW private document (epoch 0, creator only). */
  createGroup(credentials,tenantId,payload){
   strict(payload,['documentId','groupId','deviceId']);
   uuid(payload.documentId,'INVALID_DOCUMENT_ID');uuid(payload.deviceId);
   const groupId=bytes(payload.groupId,32,32,'INVALID_GROUP');
   demand(groupId.equals(Buffer.from(privateGroupId(tenantId,payload.documentId,createHash))),'INVALID_GROUP');
   return tenant(credentials,tenantId,{write:true,roles:WRITERS},async(db,actor)=>{
    await requireOwnDevice(db,actor,payload.deviceId);
    demand((await db.query('SELECT count(*)::int AS n FROM dge_private.groups WHERE tenant_id=$1',[tenantId])).rows[0].n<maxGroups,'PRIVATE_DOCUMENT_LIMIT_REACHED',429);
    demand(!(await db.query('SELECT 1 FROM dge_private.documents WHERE tenant_id=$1 AND id=$2',[tenantId,payload.documentId])).rows.length,'PRIVATE_DOCUMENT_EXISTS',409);
    const at=now();
    try{
     await db.query('INSERT INTO dge_private.groups(tenant_id,document_id,group_id,epoch,created_by,creator_device_id,created_at) VALUES($1,$2,$3,0,$4,$5,$6)',
      [tenantId,payload.documentId,groupId,actor.accountId,payload.deviceId,at]);
    }catch(error){if(error?.code==='23505')throw new PrivateDocumentError('PRIVATE_DOCUMENT_EXISTS',409);throw error;}
    await db.query('INSERT INTO dge_private.group_members(tenant_id,document_id,device_id,account_id,added_epoch) VALUES($1,$2,$3,$4,0)',
     [tenantId,payload.documentId,payload.deviceId,actor.accountId]);
    return {documentId:payload.documentId,epoch:0,roster:[payload.deviceId]};
   });
  },
  /** Members see their documents; owners/admins also see every group for removal duty. */
  groups(credentials,tenantId){
   return tenant(credentials,tenantId,{},async(db,actor)=>{
    const rows=(await db.query(`SELECT g.document_id,g.epoch,g.created_by,g.created_at,d.key_epoch,d.version,
      ARRAY(SELECT m.device_id FROM dge_private.group_members m WHERE m.tenant_id=g.tenant_id AND m.document_id=g.document_id AND m.account_id=$2 AND m.removed_epoch IS NULL ORDER BY m.device_id) AS mine
      FROM dge_private.groups g LEFT JOIN dge_private.documents d ON d.tenant_id=g.tenant_id AND d.id=g.document_id
      WHERE g.tenant_id=$1 ORDER BY g.created_at,g.document_id LIMIT 500`,[tenantId,actor.accountId])).rows;
    return {items:rows.filter(r=>r.mine.length||MANAGERS.includes(actor.role)).map(r=>({
     documentId:r.document_id,epoch:r.epoch,keyEpoch:r.key_epoch??null,version:r.version??null,
     createdBy:r.created_by,createdAt:new Date(r.created_at).toISOString(),myDevices:[...r.mine]}))};
   });
  },
  group(credentials,tenantId,documentId){
   uuid(documentId,'INVALID_DOCUMENT_ID');
   return tenant(credentials,tenantId,{},async(db,actor)=>{
    const g=await group(db,tenantId,documentId);demand(g,'PRIVATE_DOCUMENT_NOT_FOUND',404);
    const members=(await db.query(`SELECT m.device_id,m.account_id,m.added_epoch,m.removed_epoch,k.identity,k.signature_key,
      (d.revoked_at IS NOT NULL OR ms.active IS DISTINCT FROM true) AS stale
      FROM dge_private.group_members m JOIN dge_private.device_keys k ON k.device_id=m.device_id
      JOIN dge_identity.authorized_devices d ON d.id=m.device_id
      LEFT JOIN dge_identity.memberships ms ON ms.tenant_id=m.tenant_id AND ms.account_id=m.account_id
      WHERE m.tenant_id=$1 AND m.document_id=$2 ORDER BY m.device_id`,[tenantId,documentId])).rows;
    demand(MANAGERS.includes(actor.role)||members.some(m=>m.account_id===actor.accountId),'PRIVATE_DOCUMENT_NOT_FOUND',404);
    const doc=(await db.query('SELECT key_epoch,version FROM dge_private.documents WHERE tenant_id=$1 AND id=$2',[tenantId,documentId])).rows[0];
    return {documentId,groupId:b64(g.group_id),epoch:g.epoch,keyEpoch:doc?.key_epoch??null,version:doc?.version??null,
     createdBy:g.created_by,creatorDeviceId:g.creator_device_id,
     members:members.map(m=>({deviceId:m.device_id,accountId:m.account_id,identity:b64(m.identity),signatureKey:b64(m.signature_key),
      addedEpoch:m.added_epoch,removedEpoch:m.removed_epoch,active:m.removed_epoch===null,stale:m.removed_epoch===null&&m.stale}))};
   });
  },
  /**
   * Sequenced commit (+ optional Welcome) for exactly one add or removal. The
   * commit must be built on the CURRENT service epoch; competing commits for the
   * same epoch lose deterministically. Retries with the same command are idempotent.
   */
  postCommit(credentials,tenantId,documentId,payload){
   uuid(documentId,'INVALID_DOCUMENT_ID');
   strict(payload,['deviceId','epoch','commit','welcome','add','remove','commandId']);
   uuid(payload.deviceId);uuid(payload.commandId,'INVALID_COMMAND_ID');
   demand(Number.isSafeInteger(payload.epoch)&&payload.epoch>=0&&payload.epoch<1000000,'INVALID_EPOCH');
   demand((payload.add===null)!==(payload.remove===null),'INVALID_MEMBERSHIP_CHANGE');
   if(payload.add!==null)uuid(payload.add);
   if(payload.remove!==null)uuid(payload.remove);
   demand((payload.add===null)===(payload.welcome===null),'INVALID_MEMBERSHIP_CHANGE');
   const commit=bytes(payload.commit,1,MAX_HANDSHAKE,'INVALID_HANDSHAKE');
   const welcome=payload.welcome===null?null:bytes(payload.welcome,1,MAX_HANDSHAKE,'INVALID_HANDSHAKE');
   const requestDigest=sha('dge-private-commit-command-v1',documentId,JSON.stringify(payload));
   return tenant(credentials,tenantId,{write:true},async(db,actor)=>{
    const g=await group(db,tenantId,documentId,true);demand(g,'PRIVATE_DOCUMENT_NOT_FOUND',404);
    await requireOwnDevice(db,actor,payload.deviceId);
    const prior=(await db.query("SELECT * FROM dge_private.group_messages WHERE tenant_id=$1 AND command_id=$2 AND kind='commit'",[tenantId,payload.commandId])).rows[0];
    if(prior){
     demand(prior.request_digest===requestDigest&&prior.document_id===documentId,'COMMAND_REUSED',409);
     return {position:prior.position,epoch:prior.epoch+1,roster:[...prior.roster].sort(),replayed:true};
    }
    demand(payload.epoch===g.epoch,'PRIVATE_EPOCH_CONFLICT',409);
    demand(await activeMember(db,tenantId,documentId,payload.deviceId),'PRIVATE_DEVICE_NOT_AUTHORIZED',403);
    // Only an owner/admin (or the document creator) device may change membership.
    demand(MANAGERS.includes(actor.role)||g.created_by===actor.accountId,'PRIVATE_MEMBERSHIP_ADMIN_REQUIRED',403);
    let members=await roster(db,tenantId,documentId);
    const next=g.epoch+1;
    if(payload.add){
     const target=(await db.query(`SELECT k.account_id FROM dge_private.device_keys k
       JOIN dge_identity.authorized_devices d ON d.id=k.device_id AND d.revoked_at IS NULL
       JOIN dge_identity.memberships m ON m.account_id=k.account_id AND m.tenant_id=$2 AND m.active=true
       WHERE k.device_id=$1`,[payload.add,tenantId])).rows[0];
     demand(target,'PRIVATE_DEVICE_NOT_FOUND',404);
     const existing=(await db.query('SELECT removed_epoch FROM dge_private.group_members WHERE tenant_id=$1 AND document_id=$2 AND device_id=$3',[tenantId,documentId,payload.add])).rows[0];
     // A removed device never rejoins under the same key: enroll a new device.
     demand(!existing,existing?.removed_epoch===null?'PRIVATE_DEVICE_ALREADY_MEMBER':'PRIVATE_DEVICE_PREVIOUSLY_REMOVED',409);
     demand(members.length<1000,'PRIVATE_GROUP_LIMIT_REACHED',429);
     members=[...members,payload.add].sort();
     await db.query('INSERT INTO dge_private.group_members(tenant_id,document_id,device_id,account_id,added_epoch) VALUES($1,$2,$3,$4,$5)',
      [tenantId,documentId,payload.add,target.account_id,next]);
    }else{
     demand(payload.remove!==payload.deviceId,'INVALID_MEMBERSHIP_CHANGE');
     demand(members.includes(payload.remove),'PRIVATE_DEVICE_NOT_FOUND',404);
     members=members.filter(id=>id!==payload.remove);
     await db.query('UPDATE dge_private.group_members SET removed_epoch=$4 WHERE tenant_id=$1 AND document_id=$2 AND device_id=$3',
      [tenantId,documentId,payload.remove,next]);
    }
    const count=(await db.query('SELECT count(*)::int AS n,COALESCE(max(position),0)::int AS last FROM dge_private.group_messages WHERE tenant_id=$1 AND document_id=$2',[tenantId,documentId])).rows[0];
    demand(count.n+2<=maxMessagesPerGroup,'PRIVATE_MAILBOX_LIMIT_REACHED',429);
    await usage(db,tenantId,commit.length+(welcome?.length??0));
    const at=now(),position=count.last+1;
    const insert=(pos,kind,epoch,recipient,bytes)=>db.query(
     'INSERT INTO dge_private.group_messages(tenant_id,document_id,position,kind,epoch,sender_device_id,recipient_device_id,roster,payload,digest,command_id,request_digest,actor_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)',
     [tenantId,documentId,pos,kind,epoch,payload.deviceId,recipient,members,bytes,
      messageDigest(tenantId,documentId,pos,kind,epoch,payload.deviceId,recipient,members,bytes),
      payload.commandId,requestDigest,actor.accountId,at]);
    await insert(position,'commit',g.epoch,null,commit);
    if(welcome)await insert(position+1,'welcome',next,payload.add,welcome);
    await db.query('UPDATE dge_private.groups SET epoch=$3 WHERE tenant_id=$1 AND document_id=$2',[tenantId,documentId,next]);
    return {position,epoch:next,roster:members,replayed:false};
   });
  },
  /**
   * Ordered handshake delivery for one of the caller's devices: commits from the
   * device's admission epoch until (and including) its own removal, plus Welcome
   * messages addressed to it. Integrity digests are rechecked on every read.
   */
  messages(credentials,tenantId,documentId,{deviceId,after=0,limit=50}={}){
   uuid(documentId,'INVALID_DOCUMENT_ID');uuid(deviceId);
   demand(Number.isSafeInteger(after)&&after>=0&&after<=1000000&&Number.isSafeInteger(limit)&&limit>=1&&limit<=100,'INVALID_PRIVATE_PAGE');
   return tenant(credentials,tenantId,{},async(db,actor)=>{
    await requireOwnDevice(db,actor,deviceId);
    const member=(await db.query('SELECT added_epoch,removed_epoch FROM dge_private.group_members WHERE tenant_id=$1 AND document_id=$2 AND device_id=$3',[tenantId,documentId,deviceId])).rows[0];
    demand(member,'PRIVATE_DEVICE_NOT_AUTHORIZED',403);
    const rows=(await db.query(`SELECT * FROM dge_private.group_messages WHERE tenant_id=$1 AND document_id=$2 AND position>$3 AND (
      (kind='welcome' AND recipient_device_id=$4) OR
      (kind='commit' AND epoch>=$5 AND ($6::int IS NULL OR epoch<$6::int)))
      ORDER BY position LIMIT $7`,[tenantId,documentId,after,deviceId,member.added_epoch,member.removed_epoch,limit+1])).rows;
    for(const row of rows)
     demand(row.digest===messageDigest(tenantId,documentId,row.position,row.kind,row.epoch,row.sender_device_id,row.recipient_device_id,[...row.roster],row.payload),'PRIVATE_MAILBOX_INTEGRITY_ERROR',503);
    const items=rows.slice(0,limit).map(messageView);
    return {documentId,items,nextCursor:rows.length>limit?items.at(-1).position:null,removed:member.removed_epoch!==null};
   });
  },
  /**
   * Adapter for the private document store and update ledger: the actor's own
   * authorized device must be in the CURRENT roster; writes must use the
   * current group epoch, so stale-epoch writes stop as soon as a commit lands.
   */
  async authorizeDevice({db,actor,tenantId,documentId,keyEpoch,senderDeviceId,deviceId,operation}){
   const device=senderDeviceId??deviceId;
   if(!await ownDevice(db,actor,device))return false;
   const g=await group(db,tenantId,documentId);
   if(!g||!await activeMember(db,tenantId,documentId,device))return false;
   if(operation==='create')return g.epoch===0&&keyEpoch===0&&g.created_by===actor.accountId&&g.creator_device_id===device;
   if(operation==='save'||operation==='append')return keyEpoch===g.epoch;
   return operation==='read'||operation==='list';
  },
  async authorizeEpochAdvance({db,tenantId,documentId,previousEpoch,nextEpoch}){
   const g=await group(db,tenantId,documentId);
   return !!g&&nextEpoch===g.epoch&&nextEpoch>previousEpoch;
  }
 });
}
