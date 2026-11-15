import React,{useEffect,useRef,useState} from "react";
import {createAccountAPI} from "./account-api.mjs";

/** Formats integer minor units exactly (no floating-point division). */
export function formatMoney({currency,amountMinor},locale){
  const format=new Intl.NumberFormat(locale,{style:"currency",currency});
  const digits=format.resolvedOptions().maximumFractionDigits;
  const text=String(amountMinor).padStart(digits+1,"0");
  return format.format(digits?text.slice(0,-digits)+"."+text.slice(-digits):text);
}
const OFFERS={
  "no-entitlement":"You have no document creations left. You can still read, discuss and vote. Purchase options are below when available.",
  "official-monthly-cap-reached":"Your verified-official allowance for this month is used. Nothing is charged automatically; a paid option is available if you choose it.",
  "official-heavy-use":"You are a heavy user of your verified-official allowance. It remains available; a paid plan is offered, never charged automatically.",
};
const PROVENANCE={"subscription":"Subscription","single-document":"Single document","credit-pack":"Credit pack","administrator":"Administrator grant",
  "verified-official":"Verified official","enterprise-license":"Enterprise license"};
const errorText=error=>error?.code==="PROVIDER_UNAVAILABLE"?"Payments are not available right now. Nothing was charged.":
  error?.code==="AUTHENTICATION_REQUIRED"?"Sign in to view billing.":error?.code==="ACCESS_DENIED"?"Only workspace owners and administrators can buy for the workspace.":
  "The billing service could not complete the request. Nothing is assumed paid.";

/**
 * Balances, grants and weekly allowance for the signed-in account (and the
 * workspace when the viewer manages it). Purchase controls appear only for
 * providers the server reports as configured.
 */
export function BillingPanel({tenantId=null,api=createAccountAPI(),navigate=url=>window.location.assign(url)}){
  const [account,setAccount]=useState(null);
  const [workspace,setWorkspace]=useState(null);
  const [options,setOptions]=useState(null);
  const [subject,setSubject]=useState("account");
  const [error,setError]=useState("");
  const [notice,setNotice]=useState("");
  const [busy,setBusy]=useState(false);
  const attempt=useRef(null);
  useEffect(()=>{
    const abort=new AbortController(),signal=abort.signal;
    setError("");
    Promise.all([api("/api/entitlements",{signal}),api("/api/billing/checkout",{signal}),
      tenantId?api("/api/workspaces/"+tenantId+"/entitlements",{signal}).catch(reason=>{if(reason.status===403)return null;throw reason;}):null])
      .then(([mine,offer,shared])=>{if(!signal.aborted){setAccount(mine);setOptions(offer);setWorkspace(shared);}})
      .catch(reason=>{if(!signal.aborted)setError(errorText(reason));});
    return ()=>abort.abort();
  },[tenantId]);
  async function purchase(provider,item){
    if(busy)return;
    setBusy(true);setError("");setNotice("");
    // A retry of the same purchase reuses its idempotency key, so it cannot create a second checkout.
    const request={provider,itemId:item.id,subject,...(subject==="tenant"?{tenantId}:{})};
    if(JSON.stringify(attempt.current?.request)!==JSON.stringify(request))attempt.current={request,key:crypto.randomUUID()};
    try{
      const result=await api("/api/billing/checkout",{method:"POST",body:{...request,idempotencyKey:attempt.current.key}});
      if(result.url&&result.url.startsWith("https://"))navigate(result.url);
      else if(result.status==="invoice-requested")setNotice("Invoice requested. Credits are added after an administrator confirms payment.");
      else setNotice("Checkout recorded with status "+result.status+".");
    }catch(reason){setError(errorText(reason));}
    finally{setBusy(false);}
  }
  if(!account||!options)return <section className="billing-panel" aria-label="Billing">{error?<p role="alert">{error}</p>:<p role="status">Loading billing…</p>}</section>;
  const allowance=account.allowance;
  const purchasable=options.providers.length>0&&options.catalog.length>0;
  return <section className="billing-panel" aria-label="Billing">
    <header><p className="eyebrow">BILLING</p><h2>Document creation</h2>
      <p className="small">{account.participation}</p></header>
    {!!error&&<p role="alert">{error}</p>}
    {!!notice&&<p role="status">{notice}</p>}
    <dl className="billing-balances">
      <dt>Free this week</dt><dd>{allowance.used} of {allowance.limit} used · resets {new Date(allowance.resetsAt).toLocaleString()} ({allowance.timeZone})</dd>
      <dt>Your credits</dt><dd>{account.credits}</dd>
      {workspace&&<><dt>Workspace credits</dt><dd>{workspace.credits}</dd></>}
    </dl>
    {account.paidOffer&&<p role="status" className="billing-offer">{OFFERS[account.paidOffer.reason]}</p>}
    {account.official&&<p className="small">Verified official: {account.official.usedThisMonth} documents this month{account.official.policy.mode==="monthly-cap"?" of "+account.official.policy.monthlyCap:" (unlimited)"}.</p>}
    <h3>Grants</h3>
    {[...account.grants,...(workspace?.grants??[])].length===0?<p>No grants.</p>:<ul className="billing-grants">
      {[...account.grants,...(workspace?.grants??[])].map(grant=><li key={grant.id}>
        {PROVENANCE[grant.provenance]} · {grant.subject.kind==="tenant"?"workspace":"you"} · {grant.unlimited?"unlimited":grant.quantity+(grant.period==="none"?"":" per "+grant.period)} · {grant.state}
        {grant.expiresAt&&<> · {grant.state==="expired"?"expired":"ends"} {new Date(grant.expiresAt).toLocaleDateString()}</>}
      </li>)}</ul>}
    {purchasable&&<div className="billing-purchase">
      <h3>Buy document creation</h3>
      {workspace&&<label>Buy for<select value={subject} onChange={e=>setSubject(e.target.value)} disabled={busy}>
        <option value="account">My account</option><option value="tenant">This workspace</option></select></label>}
      <ul>{options.catalog.filter(item=>[subject,"either"].includes(item.subject??"either")).map(item=><li key={item.id}>
        <strong>{item.label}</strong> · {formatMoney(item.price)}{item.kind==="subscription"?" per "+item.interval:""}
        {options.providers.map(provider=><button key={provider.id} type="button" disabled={busy} onClick={()=>purchase(provider.id,item)}>
          {provider.id==="manual"?"Request invoice":"Pay with "+provider.id[0].toUpperCase()+provider.id.slice(1)}{provider.mode==="test"?" (test mode)":""}</button>)}
      </li>)}</ul>
    </div>}
  </section>;
}
