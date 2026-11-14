// Entry point: detect the real format of an untrusted upload and convert it to a draft legal document.
import {fail} from './errors.mjs';
import {readZip} from './zip.mjs';
import {importDocx} from './docx.mjs';
import {importOdt,ODT_MEDIA_TYPE} from './odt.mjs';
import {importHtml} from './html.mjs';
import {importPlainText} from './text.mjs';
import {importPdfText} from './pdf.mjs';

export {ImportError,IMPORT_ERROR_CODES} from './errors.mjs';
export {importDocx,importOdt,importHtml,importPlainText,importPdfText};

export const IMPORT_DEFAULT_LIMITS=Object.freeze({maxInputBytes:50*1024*1024});
const FORMATS={
 docx:{extensions:['docx','docm','dotx','dotm'],mediaTypes:['application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/vnd.ms-word.document.macroenabled.12','application/vnd.openxmlformats-officedocument.wordprocessingml.template','application/vnd.ms-word.template.macroenabled.12']},
 odt:{extensions:['odt'],mediaTypes:[ODT_MEDIA_TYPE]},
 pdf:{extensions:['pdf'],mediaTypes:['application/pdf']},
 html:{extensions:['html','htm','xhtml'],mediaTypes:['text/html','application/xhtml+xml']},
 text:{extensions:['txt','text','md','markdown'],mediaTypes:['text/plain','text/markdown']}
};
const GENERIC_MEDIA_TYPES=new Set(['application/octet-stream','binary/octet-stream','']);
const startsWith=(bytes,...signature)=>signature.every((b,i)=>bytes[i]===b);

function extensionOf(fileName) {
 if(typeof fileName!=='string')return null;
 const base=fileName.replace(/^.*[\\/]/,'');
 const dot=base.lastIndexOf('.');
 return dot>0?base.slice(dot+1).toLowerCase():null;
}

async function sniffArchive(bytes,limits) {
 const zip=await readZip(bytes,limits);
 const names=new Set(zip.names);
 if(names.has('mimetype')) {
  const mimetype=await zip.read('mimetype');
  if(mimetype.length<=200&&new TextDecoder().decode(mimetype)===ODT_MEDIA_TYPE)return 'odt';
 }
 if(names.has('[Content_Types].xml')&&(names.has('word/document.xml')||names.has('_rels/.rels')))return 'docx';
 fail('UNSUPPORTED_FORMAT','The archive is not a Word or OpenDocument text document');
}

function decodeText(bytes,warnings) {
 if(startsWith(bytes,0xef,0xbb,0xbf))return new TextDecoder('utf-8').decode(bytes);
 if(startsWith(bytes,0xff,0xfe))return new TextDecoder('utf-16le').decode(bytes);
 if(startsWith(bytes,0xfe,0xff))return new TextDecoder('utf-16be').decode(bytes);
 try{return new TextDecoder('utf-8',{fatal:true}).decode(bytes);}
 catch {
  warnings.push({code:'ENCODING_FALLBACK',message:'The file is not valid UTF-8 and was decoded as Windows-1252; check special characters',count:1});
  return new TextDecoder('windows-1252').decode(bytes);
 }
}

const looksLikeHtml=text=>/^\s*(?:<!--[\s\S]*?-->\s*)*<(?:!doctype\s+html|html|head|body)\b/i.test(text.slice(0,4096))
 ||/<(?:p|div|h[1-6]|table|ul|ol|br|span|a\s+href)\b[^>]*>/i.test(text.slice(0,4096));

/**
 * Import untrusted bytes. The format is decided by content (magic bytes first), never by the
 * file name or declared media type alone; a disagreement is reported as a warning.
 */
export async function importDocument({bytes,fileName,mediaType,tenantId,documentId,title,locale,idFactory,limits={}}={}) {
 if(!(bytes instanceof Uint8Array))throw new TypeError('bytes must be a Uint8Array');
 const caps={...IMPORT_DEFAULT_LIMITS,...limits};
 if(bytes.length>caps.maxInputBytes)fail('DOCUMENT_TOO_LARGE','The file is larger than the import limit');
 const options={tenantId,documentId,title,fileName,locale,idFactory,limits};
 const extension=extensionOf(fileName);
 const declared=typeof mediaType==='string'?mediaType.split(';')[0].trim().toLowerCase():'';
 const claimsText=FORMATS.text.extensions.includes(extension)||FORMATS.html.extensions.includes(extension)||declared.startsWith('text/');
 const warnings=[];
 let format,result;
 if(startsWith(bytes,0x50,0x4b,0x03,0x04)||startsWith(bytes,0x50,0x4b,0x05,0x06)) {
  format=await sniffArchive(bytes,limits);
  result=format==='odt'?await importOdt(bytes,options):await importDocx(bytes,options);
 } else if(new TextDecoder('latin1').decode(bytes.subarray(0,1024)).includes('%PDF-')) {
  format='pdf';
  result=await importPdfText(bytes,options);
 } else if(bytes.includes(0)&&!startsWith(bytes,0xff,0xfe)&&!startsWith(bytes,0xfe,0xff)) {
  if(!claimsText)fail('UNSUPPORTED_FORMAT','Unrecognized binary file format');
  fail('INVALID_TEXT','Text contains NUL characters');
 } else {
  const text=decodeText(bytes,warnings);
  const htmlByName=FORMATS.html.extensions.includes(extension)||FORMATS.html.mediaTypes.includes(declared);
  format=looksLikeHtml(text)||htmlByName&&/<[A-Za-z!]/.test(text)?'html':'text';
  result=format==='html'?importHtml(text,options):importPlainText(text,options);
 }
 const expected=FORMATS[format];
 if(extension!==null&&!expected.extensions.includes(extension))
  warnings.push({code:'EXTENSION_MISMATCH',message:`The file name extension does not match its detected ${format.toUpperCase()} content`,count:1});
 if(!GENERIC_MEDIA_TYPES.has(declared)&&!expected.mediaTypes.includes(declared))
  warnings.push({code:'MEDIA_TYPE_MISMATCH',message:`The declared media type does not match the detected ${format.toUpperCase()} content`,count:1});
 result.report.warnings.unshift(...warnings);
 return result;
}
