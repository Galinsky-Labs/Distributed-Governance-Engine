/**
 * Shared, deterministic encodings for private workspaces. These are domain-
 * separated SHA-2 encodings of public values (identifiers and public keys); no
 * cipher, key agreement or signature scheme is defined here. Group keys come
 * only from the RFC 9420 MLS exporter inside the endpoint module.
 */
const enc=new TextEncoder();
const UUID=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
export const EXPORT_LABELS=Object.freeze({snapshot:'dge-private-snapshot-v1',update:'dge-private-update-v1'});

function concat(...parts){
 const total=parts.reduce((n,p)=>n+p.length,0),out=new Uint8Array(total);let at=0;
 for(const part of parts){out.set(part,at);at+=part.length;}
 return out;
}
const field=value=>concat(typeof value==='string'?enc.encode(value):value,new Uint8Array([0]));
const hex=bytes=>Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
function ids(tenantId,documentId){
 if(!UUID.test(tenantId??'')||!UUID.test(documentId??''))throw Error('Invalid private document scope');
}
export function groupIdInput(tenantId,documentId){ids(tenantId,documentId);return concat(field('dge-private-group-v1'),field(tenantId),field(documentId));}
export function exporterContext(tenantId,documentId){ids(tenantId,documentId);return concat(field('dge-private-exporter-context-v1'),field(tenantId),field(documentId));}
export function thumbprintInput(signatureKey){
 if(!(signatureKey instanceof Uint8Array)||signatureKey.length!==32)throw Error('Invalid device signature key');
 return concat(field('dge-mls-signature-key-v1'),signatureKey);
}
/** Synchronous server forms take node:crypto createHash explicitly. */
export const privateGroupId=(tenantId,documentId,createHash)=>new Uint8Array(createHash('sha256').update(groupIdInput(tenantId,documentId)).digest());
export const deviceKeyThumbprintHex=(signatureKey,createHash)=>createHash('sha256').update(thumbprintInput(new Uint8Array(signatureKey))).digest('hex');
/** Asynchronous endpoint forms use WebCrypto. */
export async function privateGroupIdAsync(tenantId,documentId,subtle=globalThis.crypto.subtle){return new Uint8Array(await subtle.digest('SHA-256',groupIdInput(tenantId,documentId)));}
export async function deviceKeyThumbprint(signatureKey,subtle=globalThis.crypto.subtle){return hex(new Uint8Array(await subtle.digest('SHA-256',thumbprintInput(signatureKey))));}

/** MLS credential identity: bound to the account and a random installation ID, never an email or name. */
export function deviceIdentity(accountId,installationId){
 if(!UUID.test(accountId??'')||!UUID.test(installationId??''))throw Error('Invalid device identity');
 return enc.encode('dge-device-v1:'+accountId+':'+installationId);
}
export function parseDeviceIdentity(bytes){
 let text;
 try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{return null;}
 const match=/^dge-device-v1:([a-f0-9-]{36}):([a-f0-9-]{36})$/.exec(text);
 if(!match||!UUID.test(match[1])||!UUID.test(match[2]))return null;
 return {accountId:match[1],installationId:match[2]};
}

/**
 * Human-comparable device safety number: 12 groups of 5 digits from SHA-512
 * over the device identity and Ed25519 signature key. Members compare it out of
 * band; it changes whenever the key changes.
 */
export async function deviceSafetyNumber(identity,signatureKey,subtle=globalThis.crypto.subtle){
 if(!(identity instanceof Uint8Array)||!identity.length||identity.length>512)throw Error('Invalid device identity');
 const digest=new Uint8Array(await subtle.digest('SHA-512',concat(field('dge-device-safety-number-v1'),field(identity),thumbprintInput(signatureKey))));
 const groups=[];
 for(let i=0;i<12;i++){
  let value=0;
  for(let j=0;j<5;j++)value=value*256+digest[i*5+j];
  groups.push(String(value%100000).padStart(5,'0'));
 }
 return groups.join(' ');
}
export const base64url=bytes=>{let s='';for(let i=0;i<bytes.length;i+=8192)s+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');};
export function fromBase64url(value,max=4_000_000){
 if(typeof value!=='string'||!value.length||value.length>Math.ceil(max*4/3)+8||!/^[A-Za-z0-9_-]+$/.test(value))throw Error('Invalid binary encoding');
 const bytes=Uint8Array.from(atob(value.replace(/-/g,'+').replace(/_/g,'/')+'='.repeat((4-value.length%4)%4)),c=>c.charCodeAt(0));
 if(bytes.length>max||base64url(bytes)!==value)throw Error('Invalid binary encoding');
 return bytes;
}
