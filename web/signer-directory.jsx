import React,{useEffect,useState} from "react";
import {createAccountAPI} from "./account-api.mjs";
import {verifySignatureReceipt} from "../src/signatures.mjs";

const defaultApi=createAccountAPI();

/**
 * Public signer directory for one edition and signature kind. Shows only names
 * signers opted to publish, total versus publicly named counts, the latest
 * manifest downloads and an offline receipt check. Props: editionId, kind, api.
 */
export function SignerDirectory({editionId,kind="support",api=defaultApi}){
  const base="/api/public/editions/"+editionId;
  const [query,setQuery]=useState("");
  const [applied,setApplied]=useState("");
  const [page,setPage]=useState(null);
  const [items,setItems]=useState([]);
  const [manifest,setManifest]=useState(null);
  const [error,setError]=useState("");
  const [lookup,setLookup]=useState("");
  const [verdict,setVerdict]=useState("");
  const [busy,setBusy]=useState(false);
  const url=after=>base+"/directory?kind="+encodeURIComponent(kind)+(applied?"&q="+encodeURIComponent(applied):"")+(after?"&after="+encodeURIComponent(after):"")+"&limit=50";
  useEffect(()=>{const timer=setTimeout(()=>setApplied(query.trim()),250);return ()=>clearTimeout(timer);},[query]);
  useEffect(()=>{
    let live=true;
    setError("");
    api(url(null)).then(result=>{if(live){setPage(result);setItems(result.items);}}).catch(()=>{if(live)setError("The signer directory is unavailable.");});
    api(base+"/manifests?kind="+encodeURIComponent(kind)+"&limit=1").then(result=>{if(live)setManifest(result.items[0]??null);}).catch(()=>{if(live)setManifest(null);});
    return ()=>{live=false;};
  },[editionId,kind,applied]);
  async function more(){
    setBusy(true);
    try{const next=await api(url(page.nextCursor));setPage(next);setItems(current=>[...current,...next.items]);}
    catch{setError("Could not load more signers.");}
    finally{setBusy(false);}
  }
  async function check(event){
    event.preventDefault();
    setVerdict("");
    if(!/^[a-f0-9]{64}$/.test(lookup.trim())){setVerdict("Enter a 64-character record digest.");return;}
    try{
      const receipt=await api(base+"/receipts/"+lookup.trim());
      if(receipt.status!=="included"){setVerdict("Recorded, awaiting the next manifest freeze.");return;}
      const result=verifySignatureReceipt(receipt);
      setVerdict(result.valid?`Included at position ${receipt.position} of manifest version ${receipt.manifest.record.version}; proof verified in this browser.`
        :"The receipt did not verify. Do not rely on it.");
    }catch{setVerdict("No signature record with that digest was found for this edition.");}
  }
  return <section className="signer-directory" aria-label="Signer directory">
    <p className="eyebrow">PUBLIC SIGNERS</p>
    {page&&<p role="status">{page.total} active signature(s); {page.publiclyNamed} publicly named. Private signers appear in manifests only as record digests.</p>}
    {!!error&&<p role="alert">{error}</p>}
    <label>Search names beginning with <input type="search" value={query} maxLength={120} onChange={e=>setQuery(e.target.value)}/></label>
    <ol aria-label="Publicly named signers">{items.map(item=><li key={item.recordDigest}>{item.name} <small>{new Date(item.signedAt).toLocaleDateString()}</small></li>)}</ol>
    {page?.nextCursor&&<button disabled={busy} onClick={more}>Load more signers</button>}
    {manifest&&<div className="signer-manifest">
      <p>Manifest version {manifest.manifest.version}: {manifest.manifest.size} record(s), root <code>{manifest.manifest.rootHash}</code></p>
      <a href={`${base}/manifests/${kind}/${manifest.manifest.version}/entries.csv`} download>Download CSV</a>{" "}
      <a href={`${base}/manifests/${kind}/${manifest.manifest.version}/entries.json`} download>Download JSON</a>
    </div>}
    <form onSubmit={check}><label>Check a receipt by record digest <input value={lookup} onChange={e=>setLookup(e.target.value)} spellCheck={false}/></label>
      <button type="submit">Check</button></form>
    {!!verdict&&<p role="status">{verdict}</p>}
    <p className="signature-note">Names and marks are shown by the signer's choice and do not prove identity. A manifest proves which records were included, not that each person is who they claim.</p>
  </section>;
}
