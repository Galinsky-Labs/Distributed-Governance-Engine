// Offline verifier for a personal signature inclusion receipt and, optionally,
// a downloaded full manifest (JSON export). Uses only the portable engine
// modules: no network, database or service key is consulted.
import {readFile} from "node:fs/promises";
import {verifySignatureReceipt,manifestDigest,manifestRoot,validateManifest} from "../src/signatures.mjs";

const usage="Usage: node scripts/verify-signature-receipt.mjs <receipt.json> [--manifest <manifest-entries.json>]";
const args=process.argv.slice(2);
const read=async(path,limit)=>{
  const source=await readFile(path);
  if(source.length>limit)throw Error("File exceeds the verifier size limit");
  return JSON.parse(source.toString("utf8"));
};
/** Recomputes the root over every entry, in position order, without trusting any server field. */
function verifyManifestExport(exported,receipt){
  const manifest=validateManifest(exported.manifest);
  const entries=exported.entries;
  const ordered=Array.isArray(entries)&&entries.length===manifest.size&&entries.every((entry,i)=>entry?.position===i);
  const recomputed=ordered?manifestRoot(entries.map(entry=>entry.recordDigest)):null;
  return {
    manifestDigest:manifestDigest(manifest)===exported.digest,
    rootRecomputed:recomputed?.rootHash===manifest.rootHash&&recomputed.size===manifest.size,
    sameManifestAsReceipt:receipt?.manifest?.digest===exported.digest,
    containsReceiptRecord:ordered&&entries[receipt?.position]?.recordDigest===receipt?.recordDigest,
    activeSigners:manifest.activeSigners,publicSigners:manifest.publicSigners,size:manifest.size,
  };
}

if(!(args.length===1||(args.length===3&&args[1]==="--manifest"))){
  console.error(usage);
  process.exitCode=2;
}else{
  try{
    const receipt=await read(args[0],4*1024*1024);
    const result={receipt:verifySignatureReceipt(receipt)};
    if(args[2])result.manifest=verifyManifestExport(await read(args[2],1024*1024*1024),receipt);
    result.note="Inclusion in a manifest is proven offline. Identity, legal effect and external anchoring are not established by this check; verify the ledger entry and anchor separately.";
    console.log(JSON.stringify(result,null,2));
    const manifestOk=!result.manifest||(result.manifest.manifestDigest&&result.manifest.rootRecomputed);
    if(!result.receipt.valid||!manifestOk)process.exitCode=1;
  }catch{
    console.error("Could not verify the supplied files. No inclusion claim is made.");
    process.exitCode=1;
  }
}
