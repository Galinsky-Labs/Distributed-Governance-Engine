/**
 * Deterministic ZIP writer (no ZIP64, no encryption): fixed DOS timestamps,
 * CRC-32, raw deflate when it helps and stored otherwise, entries in the order given.
 */
import {ExportError,concatBytes,deflateRaw,utf8} from './common.mjs';

const CRC_TABLE=(()=>{
 const table=new Uint32Array(256);
 for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;table[n]=c>>>0;}
 return table;
})();
export function crc32(bytes) {
 let crc=0xffffffff;
 for(let i=0;i<bytes.length;i++)crc=CRC_TABLE[(crc^bytes[i])&0xff]^(crc>>>8);
 return (crc^0xffffffff)>>>0;
}

// 1980-01-01 00:00:00, the earliest DOS date: keeps archives independent of the clock.
const DOS_TIME=0,DOS_DATE=(1<<5)|1;
const MAX_ENTRY=0xfffffffe;

/** entries: [{name, data: Uint8Array|string, store?: boolean}] → ZIP bytes. */
export async function writeZip(entries) {
 if(!Array.isArray(entries)||entries.length===0||entries.length>65535)throw new ExportError('ZIP_INVALID','A ZIP needs 1-65535 entries');
 const names=new Set(),locals=[],central=[];let offset=0;
 for(const entry of entries) {
  const name=entry.name;
  if(typeof name!=='string'||!name||name.startsWith('/')||name.includes('\\')||name.split('/').some(part=>part===''||part==='.'||part==='..'))throw new ExportError('ZIP_INVALID','Unsafe ZIP entry name');
  if(names.has(name))throw new ExportError('ZIP_INVALID','Duplicate ZIP entry name');
  names.add(name);
  const data=typeof entry.data==='string'?utf8(entry.data):entry.data;
  if(!(data instanceof Uint8Array)||data.length>MAX_ENTRY)throw new ExportError('ZIP_INVALID','ZIP entry data must be bytes under 4 GiB');
  const crc=crc32(data);
  let method=0,payload=data;
  if(!entry.store&&data.length>0){const packed=await deflateRaw(data);if(packed.length<data.length){method=8;payload=packed;}}
  const nameBytes=utf8(name);
  const local=new DataView(new ArrayBuffer(30));
  local.setUint32(0,0x04034b50,true);local.setUint16(4,20,true);local.setUint16(6,0x0800,true);local.setUint16(8,method,true);
  local.setUint16(10,DOS_TIME,true);local.setUint16(12,DOS_DATE,true);local.setUint32(14,crc,true);
  local.setUint32(18,payload.length,true);local.setUint32(22,data.length,true);local.setUint16(26,nameBytes.length,true);
  const record=new DataView(new ArrayBuffer(46));
  record.setUint32(0,0x02014b50,true);record.setUint16(4,20,true);record.setUint16(6,20,true);record.setUint16(8,0x0800,true);record.setUint16(10,method,true);
  record.setUint16(12,DOS_TIME,true);record.setUint16(14,DOS_DATE,true);record.setUint32(16,crc,true);
  record.setUint32(20,payload.length,true);record.setUint32(24,data.length,true);record.setUint16(28,nameBytes.length,true);record.setUint32(42,offset,true);
  locals.push(new Uint8Array(local.buffer),nameBytes,payload);
  central.push(new Uint8Array(record.buffer),nameBytes);
  offset+=30+nameBytes.length+payload.length;
  if(offset>MAX_ENTRY)throw new ExportError('ZIP_INVALID','ZIP archive exceeds 4 GiB');
 }
 const directory=concatBytes(central);
 const end=new DataView(new ArrayBuffer(22));
 end.setUint32(0,0x06054b50,true);end.setUint16(8,entries.length,true);end.setUint16(10,entries.length,true);
 end.setUint32(12,directory.length,true);end.setUint32(16,offset,true);
 return concatBytes([...locals,directory,new Uint8Array(end.buffer)]);
}
