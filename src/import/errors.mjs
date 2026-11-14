export const IMPORT_ERROR_CODES=Object.freeze([
 'UNSUPPORTED_FORMAT','ARCHIVE_LIMIT','ARCHIVE_INVALID','XML_DOCTYPE_FORBIDDEN','XML_INVALID',
 'DOCUMENT_TOO_LARGE','PDF_ENCRYPTED','PDF_NO_TEXT_LAYER','PDF_UNSUPPORTED','INVALID_TEXT'
]);
const KNOWN=new Set(IMPORT_ERROR_CODES);

/** The only error type untrusted input may produce. Messages never quote document content. */
export class ImportError extends Error {
 constructor(code,message) {
  if(!KNOWN.has(code))throw new TypeError('Unknown import error code');
  super(message);
  this.name='ImportError';
  this.code=code;
 }
}

export const fail=(code,message)=>{throw new ImportError(code,message);};
