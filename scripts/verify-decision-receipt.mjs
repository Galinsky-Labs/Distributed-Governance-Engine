import {readFile} from "node:fs/promises";
import {verifyPublicDecisionReceipt} from "../src/decision-verification.mjs";

// Utility verifies internal consistency only; external provenance is separate.
const filename=process.argv[2];
if(!filename||process.argv.length!==3){
  console.error("Usage: node scripts/verify-decision-receipt.mjs <receipt.json>");
  process.exitCode=2;
}else{
  try{
    const source=await readFile(filename);
    if(source.length>1000000)throw Error("Receipt exceeds 1 MiB");
    const result=verifyPublicDecisionReceipt(JSON.parse(source.toString("utf8")));
    console.log(JSON.stringify(result,null,2));
    if(!result.checksumValid)process.exitCode=1;
  }catch{
    console.error("Could not verify the supplied receipt. No authenticity claim.");
    process.exitCode=1;
  }
}
