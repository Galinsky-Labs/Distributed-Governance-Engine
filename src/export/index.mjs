/**
 * Export entry point: renders one exact legal edition to PDF, DOCX, HTML, plain
 * text or JSON (or a redline against an earlier edition) and returns the bytes
 * with a manifest binding edition digest, version and render profile.
 * Runs unchanged in Node 24 and browsers.
 */
import {validateLegalDocument,legalPlainText} from '../legal-structure.mjs';
import {normalizeLayoutOptions} from './layout.mjs';
import {renderPdf} from './pdf.mjs';
import {renderDocx,DOCX_MEDIA_TYPE} from './docx.mjs';
import {renderHtml} from './html.mjs';
import {renderRedlinePdf,renderRedlineDocx,renderRedlineHtml} from './redline.mjs';
import {ExportError,RENDER_PROFILE_ID,utf8,prepareExport,exportManifest,requireTimestamp,fileStem} from './common.mjs';

export {ExportError,RENDER_PROFILE_ID} from './common.mjs';
export {redactDocument,REDACTION_TOKEN} from './redaction.mjs';
export {redlineModel,redlineText} from './redline.mjs';
export {renderPdf,renderDocx,renderHtml};

export const EXPORT_FORMATS=Object.freeze({
 pdf:{mediaType:'application/pdf',extension:'pdf'},
 docx:{mediaType:DOCX_MEDIA_TYPE,extension:'docx'},
 html:{mediaType:'text/html; charset=utf-8',extension:'html'},
 text:{mediaType:'text/plain; charset=utf-8',extension:'txt'},
 json:{mediaType:'application/json',extension:'json'}
});

/**
 * exportDocument({document, format, editionDigest, version, fonts, options, compareTo?})
 * → {bytes, mediaType, fileName, manifest}. options.generatedAt (ISO UTC) is required;
 * options.redactionProvenance (from redactDocument) is copied into the manifest.
 */
export async function exportDocument({document,format,editionDigest,version,fonts,options={},compareTo}) {
 if(!Object.hasOwn(EXPORT_FORMATS,format))throw new ExportError('UNSUPPORTED_FORMAT','format must be pdf, docx, html, text or json');
 if(options===null||typeof options!=='object')throw new ExportError('INVALID_OPTIONS','options must be an object');
 const {redactionProvenance,...renderOptions}=options;
 const extra=redactionProvenance?{redaction:redactionProvenance}:{};
 let result;
 if(compareTo!==undefined) {
  const args={before:compareTo,after:document,fonts,editionDigest,version,options:renderOptions};
  if(format==='pdf')result=await renderRedlinePdf(args);
  else if(format==='docx')result=await renderRedlineDocx(args);
  else if(format==='html')result=await renderRedlineHtml(args);
  else throw new ExportError('UNSUPPORTED_FORMAT','Redlines are available as pdf, docx or html');
 } else if(format==='pdf')result=await renderPdf({document,fonts,editionDigest,version,options:renderOptions});
 else if(format==='docx')result=await renderDocx({document,editionDigest,version,options:renderOptions});
 else {
  const doc=await prepareExport({document,editionDigest,version,validate:validateLegalDocument});
  const profile=normalizeLayoutOptions(renderOptions);requireTimestamp(profile.generatedAt);
  let bytes,warnings=[];
  if(format==='html')({bytes,warnings}=renderHtml({document:doc,editionDigest,version,options:renderOptions}));
  else if(format==='text')bytes=utf8(legalPlainText(doc));
  else {
   // The manifest cannot contain the hash of the bytes that embed it, so the embedded copy omits artifactSha256.
   const {artifactSha256,...binding}=await exportManifest({doc,format,editionDigest,version,profile,bytes:new Uint8Array(0),warnings,extra});
   bytes=utf8(JSON.stringify({schema:'quill-export-json-v1',document:doc,manifest:binding},null,1)+'\n');
  }
  result={bytes,manifest:await exportManifest({doc,format,editionDigest,version,profile,bytes,warnings,extra})};
 }
 const manifest={...result.manifest,...extra};
 const stem=fileStem(validateLegalDocument(document));
 return {bytes:result.bytes,mediaType:EXPORT_FORMATS[format].mediaType,fileName:stem+'-v'+version+(compareTo!==undefined?'-redline':'')+'.'+EXPORT_FORMATS[format].extension,manifest};
}
