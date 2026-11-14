import {fail} from './errors.mjs';
import {boundedInflate} from './inflate.mjs';

export const ZIP_DEFAULT_LIMITS=Object.freeze({
 maxEntries:2000,
 maxEntryBytes:20*1024*1024,
 maxTotalBytes:50*1024*1024,
 maxRatio:200,
 // Small entries (e.g. a run of identical XML) legitimately exceed 200:1; the ratio applies beyond this floor.
 ratioFloorBytes:64*1024
});
const EOCD_SIGNATURE=0x06054b50,CENTRAL_SIGNATURE=0x02014b50,LOCAL_SIGNATURE=0x04034b50,ZIP64_LOCATOR_SIGNATURE=0x07064b50;
const EOCD_SIZE=22,CENTRAL_SIZE=46,LOCAL_SIZE=30;
const FLAG_ENCRYPTED=0x0001,FLAG_DATA_DESCRIPTOR=0x0008,FLAG_STRONG_ENCRYPTION=0x0040,FLAG_UTF8=0x0800,FLAG_MASKED_HEADERS=0x2000;
const utf8=new TextDecoder('utf-8',{fatal:true});
const invalid=message=>fail('ARCHIVE_INVALID',message);

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

function u16(bytes,offset) {
 if(offset<0||offset+2>bytes.length)invalid('Archive structure is truncated');
 return bytes[offset]|(bytes[offset+1]<<8);
}
function u32(bytes,offset) {
 if(offset<0||offset+4>bytes.length)invalid('Archive structure is truncated');
 return (bytes[offset]|(bytes[offset+1]<<8)|(bytes[offset+2]<<16))+bytes[offset+3]*0x1000000;
}

function findEndOfCentralDirectory(bytes) {
 if(bytes.length<EOCD_SIZE)invalid('Archive is too small');
 const lowest=Math.max(0,bytes.length-EOCD_SIZE-0xffff);
 for(let offset=bytes.length-EOCD_SIZE;offset>=lowest;offset--) {
  // The comment must extend exactly to the end of the file; anything else is ambiguous.
  if(u32(bytes,offset)===EOCD_SIGNATURE&&offset+EOCD_SIZE+u16(bytes,offset+20)===bytes.length)return offset;
 }
 invalid('Archive end record not found');
}

function checkName(name) {
 if(name.length===0||name.length>1024)invalid('Archive entry name is empty or too long');
 if(name.includes('\0'))invalid('Archive entry name contains NUL');
 if(name.includes('\\'))invalid('Archive entry name contains a backslash');
 if(name.startsWith('/')||/^[A-Za-z]:/.test(name))invalid('Archive entry name is absolute');
 if(name.split('/').some(part=>part==='..'||part==='.'))invalid('Archive entry name escapes its directory');
}

function decodeName(raw,flags) {
 try{return utf8.decode(raw);}
 catch{invalid(flags&FLAG_UTF8?'Archive entry name is not valid UTF-8':'Archive entry name uses an unsupported legacy encoding');}
}

function hasZip64Extra(bytes,start,length) {
 for(let offset=start;offset+4<=start+length;) {
  const id=u16(bytes,offset),size=u16(bytes,offset+2);
  if(id===0x0001)return true;
  offset+=4+size;
 }
 return false;
}

/**
 * Strict ZIP reader for untrusted packages. Entries are inflated lazily; every read is
 * charged against cumulative limits so a package cannot be read repeatedly to exhaust memory.
 */
export async function readZip(bytes,limits={}) {
 if(!(bytes instanceof Uint8Array))throw new TypeError('readZip expects a Uint8Array');
 const caps={...ZIP_DEFAULT_LIMITS,...limits};
 const eocd=findEndOfCentralDirectory(bytes);
 if(eocd>=20&&u32(bytes,eocd-20)===ZIP64_LOCATOR_SIGNATURE)invalid('ZIP64 archives are not supported');
 const disk=u16(bytes,eocd+4),cdDisk=u16(bytes,eocd+6),diskEntries=u16(bytes,eocd+8),count=u16(bytes,eocd+10);
 const cdSize=u32(bytes,eocd+12),cdOffset=u32(bytes,eocd+16);
 if(count===0xffff||cdSize===0xffffffff||cdOffset===0xffffffff)invalid('ZIP64 archives are not supported');
 if(disk!==0||cdDisk!==0||diskEntries!==count)invalid('Multi-disk archives are not supported');
 if(count>caps.maxEntries)fail('ARCHIVE_LIMIT','Archive has too many entries');
 if(cdOffset+cdSize>eocd)invalid('Central directory overlaps the end record');

 const entries=new Map();
 let offset=cdOffset;
 for(let i=0;i<count;i++) {
  if(offset+CENTRAL_SIZE>cdOffset+cdSize||u32(bytes,offset)!==CENTRAL_SIGNATURE)invalid('Central directory entry is malformed');
  const flags=u16(bytes,offset+8),method=u16(bytes,offset+10),crc=u32(bytes,offset+16);
  const compressedSize=u32(bytes,offset+20),size=u32(bytes,offset+24);
  const nameLength=u16(bytes,offset+28),extraLength=u16(bytes,offset+30),commentLength=u16(bytes,offset+32);
  const startDisk=u16(bytes,offset+34),localOffset=u32(bytes,offset+42);
  const nameStart=offset+CENTRAL_SIZE,next=nameStart+nameLength+extraLength+commentLength;
  if(next>cdOffset+cdSize)invalid('Central directory entry is truncated');
  if(flags&(FLAG_ENCRYPTED|FLAG_STRONG_ENCRYPTION|FLAG_MASKED_HEADERS))invalid('Encrypted archive entries are not supported');
  if(compressedSize===0xffffffff||size===0xffffffff||localOffset===0xffffffff||hasZip64Extra(bytes,nameStart+nameLength,extraLength))invalid('ZIP64 archives are not supported');
  if(startDisk!==0)invalid('Multi-disk archives are not supported');
  if(method!==0&&method!==8)invalid('Unsupported compression method');
  const name=decodeName(bytes.subarray(nameStart,nameStart+nameLength),flags);
  checkName(name);
  if(entries.has(name))invalid('Archive has duplicate entry names');
  entries.set(name,{name,flags,method,crc,compressedSize,size,localOffset});
  offset=next;
 }
 if(offset!==cdOffset+cdSize)invalid('Central directory size does not match its entries');

 for(const entry of entries.values()) {
  const local=entry.localOffset;
  if(u32(bytes,local)!==LOCAL_SIGNATURE)invalid('Local header is missing');
  const flags=u16(bytes,local+6),method=u16(bytes,local+8);
  const nameLength=u16(bytes,local+26),extraLength=u16(bytes,local+28);
  if(flags!==entry.flags||method!==entry.method)invalid('Local header disagrees with the central directory');
  if(!(flags&FLAG_DATA_DESCRIPTOR)&&(u32(bytes,local+14)!==entry.crc||u32(bytes,local+18)!==entry.compressedSize||u32(bytes,local+22)!==entry.size))
   invalid('Local header disagrees with the central directory');
  const localName=bytes.subarray(local+LOCAL_SIZE,local+LOCAL_SIZE+nameLength);
  if(local+LOCAL_SIZE+nameLength>bytes.length||decodeName(localName,flags)!==entry.name)invalid('Local header name disagrees with the central directory');
  entry.dataStart=local+LOCAL_SIZE+nameLength+extraLength;
  entry.dataEnd=entry.dataStart+entry.compressedSize;
  if(entry.dataEnd>cdOffset)invalid('Entry data overlaps the central directory');
 }
 const ordered=[...entries.values()].sort((a,b)=>a.localOffset-b.localOffset);
 for(let i=1;i<ordered.length;i++)if(ordered[i].localOffset<ordered[i-1].dataEnd)invalid('Archive entries overlap');

 let consumed=0;
 async function read(name) {
  const entry=entries.get(name);
  if(!entry)invalid('Archive entry not found');
  if(entry.size>caps.maxEntryBytes)fail('ARCHIVE_LIMIT','Archive entry is too large');
  if(consumed+entry.size>caps.maxTotalBytes)fail('ARCHIVE_LIMIT','Archive expands beyond the total size limit');
  const ratioAllowance=Math.max(caps.ratioFloorBytes,entry.compressedSize*caps.maxRatio);
  if(entry.size>ratioAllowance)fail('ARCHIVE_LIMIT','Archive entry exceeds the compression ratio limit');
  // Reserve the declared size before awaiting so concurrent reads cannot overshoot the total.
  consumed+=entry.size;
  const raw=bytes.subarray(entry.dataStart,entry.dataEnd);
  let data;
  if(entry.method===0) {
   if(entry.compressedSize!==entry.size)invalid('Stored entry sizes disagree');
   data=raw.slice();
  } else {
   data=await boundedInflate(raw,'deflate-raw',{
    maxBytes:entry.size,
    invalidCode:'ARCHIVE_INVALID',limitCode:'ARCHIVE_LIMIT',limitMessage:'Entry inflates beyond its declared size or the archive limits'
   });
   if(data.length!==entry.size)invalid('Entry size disagrees with its header');
  }
  if(crc32(data)!==entry.crc)invalid('Archive entry checksum mismatch');
  return data;
 }
 return Object.freeze({names:Object.freeze([...entries.keys()]),read});
}
