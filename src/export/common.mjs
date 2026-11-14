/** Shared, platform-neutral helpers for the export library (Node 24 and browsers). */
import {canonicalize} from '../integrity-values.mjs';

export const RENDER_PROFILE_ID='quill-render-v1';
export const PRODUCER='Quill export (quill-render-v1)';

/** Errors with stable machine-readable codes; messages never include document text. */
export class ExportError extends Error {
 constructor(code,message,{cause}={}) {super(message,cause===undefined?undefined:{cause});this.name='ExportError';this.code=code;}
}

const encoder=new TextEncoder();
export const utf8=text=>encoder.encode(text);

export function concatBytes(parts) {
 let length=0;for(const part of parts)length+=part.byteLength;
 const out=new Uint8Array(length);let at=0;
 for(const part of parts){out.set(part,at);at+=part.byteLength;}
 return out;
}

async function pipe(bytes,transform) {
 const stream=new Blob([bytes]).stream().pipeThrough(transform);
 return new Uint8Array(await new Response(stream).arrayBuffer());
}
/** zlib-wrapped deflate (PDF FlateDecode). */
export const deflate=bytes=>pipe(bytes,new CompressionStream('deflate'));
/** Raw deflate (ZIP method 8). */
export const deflateRaw=bytes=>pipe(bytes,new CompressionStream('deflate-raw'));

export const toHex=bytes=>Array.from(bytes,byte=>byte.toString(16).padStart(2,'0')).join('');
export async function sha256Hex(bytes) {
 return toHex(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256',typeof bytes==='string'?utf8(bytes):bytes)));
}

/** Same construction as legalDocumentDigest (src/legal-schema.mjs) without node:crypto. */
export function legalEditionDigest(document) {
 return sha256Hex('dce-c14n-v0-dev\0legal-document-v'+document.schemaVersion+'\0'+canonicalize(document));
}

/** Validates an ISO-8601 UTC timestamp supplied by the caller (exports never read the clock). */
export function requireTimestamp(value) {
 if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)||!Number.isFinite(Date.parse(value)))
  throw new ExportError('INVALID_GENERATED_AT','options.generatedAt must be an ISO-8601 UTC timestamp such as 2026-01-31T12:00:00Z');
 return value;
}

// XML 1.0 Char production: tab, LF, CR, U+0020–U+D7FF, U+E000–U+FFFD, astral.
const INVALID_XML=/[^\t\n\r -퟿-�\u{10000}-\u{10FFFF}]/gu;
/** Escape text for XML/HTML content or attributes, removing characters XML cannot carry. */
export function xmlEscape(text,warnings) {
 const cleaned=String(text).replace(INVALID_XML,ch=>{
  warnings?.add('Removed character U+'+ch.codePointAt(0).toString(16).toUpperCase().padStart(4,'0')+' that XML cannot represent');
  return '';
 });
 return cleaned.replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[ch]);
}

const RTL_LANGUAGES=new Set(['ar','he','fa','ur','ps','sd','yi','dv','ckb','ug']);
export const localeDirection=locale=>RTL_LANGUAGES.has(String(locale).split('-')[0])?'rtl':'ltr';

/** Text of a link or citation exactly as legalPlainText renders it. */
export function externalInlineText(run) {
 const metadata=run.citationMetadata?['publisher','publishedOn','pinpoint','accessedOn'].filter(key=>run.citationMetadata[key]!==undefined).map(key=>run.citationMetadata[key]).join('; '):'';
 return {label:run.label,suffix:' <'+run.targetUrl+'>'+(metadata?' ['+metadata+']':'')};
}

/** Only canonical https: URLs may become active links in any export format. */
export function safeHttpsUrl(value) {
 try {
  const url=new URL(value);
  return url.protocol==='https:'&&url.hostname&&!url.username&&!url.password&&url.href===value?value:null;
 } catch {return null;}
}

/** Validates the edition and binding inputs shared by every export format. */
export async function prepareExport({document,editionDigest,version,validate}) {
 let doc;
 try {doc=validate(document);}
 catch(error) {throw new ExportError('INVALID_DOCUMENT','The document failed legal schema validation: '+error.message,{cause:error});}
 if(typeof editionDigest!=='string'||!/^[a-f0-9]{64}$/.test(editionDigest))throw new ExportError('INVALID_EDITION_DIGEST','editionDigest must be a lowercase SHA-256 hex digest');
 if(await legalEditionDigest(doc)!==editionDigest)throw new ExportError('EDITION_DIGEST_MISMATCH','editionDigest does not match the supplied document edition');
 if(!Number.isSafeInteger(version)||version<1)throw new ExportError('INVALID_VERSION','version must be a positive integer');
 return doc;
}

/** Export manifest binding the exact edition, render profile and artifact bytes. */
export async function exportManifest({doc,format,editionDigest,version,profile,fonts=[],bytes,pageCount,warnings,extra={}}) {
 return {
  schema:'quill-export-manifest-v1',documentId:doc.id,tenantId:doc.tenantId,version,editionDigest,format,
  renderProfile:{id:RENDER_PROFILE_ID,pageSize:profile.pageSize,margins:{...profile.margins},fonts,lineNumbers:profile.lineNumbers,watermark:profile.watermark},
  artifactSha256:await sha256Hex(bytes),
  ...(pageCount===undefined?{}:{pageCount}),
  generatedAt:profile.generatedAt,
  warnings:[...warnings],
  conformance:{pdfa:'PDF/A-2b profile targeted; not validated by an external validator',tagged:true},
  ...extra
 };
}

/** Manifest font entries for the styles a renderer actually used. */
export async function fontEntries(parsedFonts,styles) {
 const entries=[];
 for(const style of styles) {
  const font=parsedFonts[style];
  entries.push({family:font.names.family??'unknown',style,version:font.names.version??'unknown',sha256:await sha256Hex(font.bytes)});
 }
 return entries;
}

export function fileStem(document) {
 const slug=document.metadata.title.normalize('NFKD').replace(/[^A-Za-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,60).toLowerCase();
 return (slug||document.id.replace(/[^A-Za-z0-9_-]+/g,'-'))+'-r'+document.revision;
}
