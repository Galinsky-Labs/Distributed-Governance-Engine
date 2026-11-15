import React,{useEffect,useRef,useState} from "react";
import {startAuthentication} from "@simplewebauthn/browser";
import {createAccountAPI} from "./account-api.mjs";
import {SIGNATURE_FONTS,INK_LIMITS,EDITION_SIGNATURE_KINDS} from "../src/signatures.mjs";

const defaultApi=createAccountAPI();
const KIND_LABEL={support:"Support",approval:"Approval",execution:"Legal execution"};
const MARK_NOTE="Your typed or drawn mark is presentation only. It is not proof of your identity; the authenticated signing event is.";
const message=error=>({
  CONSENT_REQUIRED:"Tick the consent box to sign. Nothing was recorded.",
  ALREADY_SIGNED:"You already have an active signature of this kind on this edition.",
  INTENT_ALREADY_USED:"This signing request was already used or declined. Start again.",
  INTENT_EXPIRED:"This signing request expired. Start again to review the text.",
  INTENT_EDITION_MISMATCH:"The signing request does not match this edition. Start again.",
  SIGNING_ORDER_VIOLATION:"An earlier signatory has not signed yet.",
  NOT_A_SIGNATORY:"You are not a configured signatory for this edition.",
  PASSKEY_REQUIRED:"Legal execution requires confirming with your passkey.",
  PASSKEY_NOT_ENROLLED:"Add a passkey to your account before executing.",
  PASSKEY_VERIFICATION_FAILED:"The passkey confirmation did not match this signing request.",
  PASSKEY_VERIFIER_UNAVAILABLE:"Passkey verification is not configured for this service.",
  INVALID_SIGNATURE:"The mark or display choice is not valid. Check the name and drawing.",
  AUTHENTICATION_REQUIRED:"Sign in to continue.",
  ACCESS_DENIED:"Your workspace role does not allow this signature.",
})[error?.code]??"The signing service could not complete the request. No signature is assumed.";

const clamp=(n,max)=>Math.max(0,Math.min(max,Math.round(n)));
const pointCount=strokes=>strokes.reduce((n,s)=>n+s.length/2,0);
/**
 * Pointer, touch and keyboard drawing surface producing bounded integer strokes
 * on a 1000x400 grid. Keyboard: arrows move the pen (Shift for larger steps),
 * Enter or Space lowers/lifts it, Escape lifts it.
 */
export function DrawingPad({strokes,onChange,disabled=false}){
  const [cursor,setCursor]=useState({x:500,y:200});
  const [down,setDown]=useState(false);
  const surface=useRef(null),pointer=useRef(null);
  const room=pointCount(strokes)<INK_LIMITS.points;
  const add=(x,y,start)=>{
    if(!room)return;
    if(start){if(strokes.length<INK_LIMITS.strokes)onChange([...strokes,[x,y]]);return;}
    const last=strokes[strokes.length-1];
    if(!last||last.length>=INK_LIMITS.pointsPerStroke*2)return;
    onChange([...strokes.slice(0,-1),[...last,x,y]]);
  };
  const local=event=>{
    const box=surface.current.getBoundingClientRect();
    return {x:clamp((event.clientX-box.left)/Math.max(box.width,1)*INK_LIMITS.width,INK_LIMITS.width),
      y:clamp((event.clientY-box.top)/Math.max(box.height,1)*INK_LIMITS.height,INK_LIMITS.height)};
  };
  function key(event){
    if(disabled)return;
    const step=event.shiftKey?50:10,moves={ArrowLeft:[-step,0],ArrowRight:[step,0],ArrowUp:[0,-step],ArrowDown:[0,step]};
    if(moves[event.key]){
      event.preventDefault();
      const next={x:clamp(cursor.x+moves[event.key][0],INK_LIMITS.width),y:clamp(cursor.y+moves[event.key][1],INK_LIMITS.height)};
      setCursor(next);
      if(down)add(next.x,next.y,false);
    }else if(event.key==="Enter"||event.key===" "){
      event.preventDefault();
      if(!down)add(cursor.x,cursor.y,true);
      setDown(!down);
    }else if(event.key==="Escape")setDown(false);
  }
  return <div className="drawing-pad">
    <div ref={surface} role="application" tabIndex={disabled?-1:0} onKeyDown={key}
      aria-label="Signature drawing pad. Arrow keys move the pen, Enter or Space lowers or lifts it."
      aria-describedby="drawing-pad-status"
      style={{touchAction:"none",border:"1px solid #b9cbbf",borderRadius:6,background:"white",aspectRatio:"5 / 2",maxWidth:500}}
      onPointerDown={event=>{
        if(disabled)return;
        surface.current.setPointerCapture?.(event.pointerId);pointer.current=event.pointerId;
        const p=local(event);add(p.x,p.y,true);
      }}
      onPointerMove={event=>{
        if(pointer.current!==event.pointerId)return;
        const p=local(event),last=strokes[strokes.length-1];
        if(last&&Math.abs(last[last.length-2]-p.x)+Math.abs(last[last.length-1]-p.y)>=3)add(p.x,p.y,false);
      }}
      onPointerUp={()=>{pointer.current=null;}} onPointerCancel={()=>{pointer.current=null;}}>
      <svg viewBox={`0 0 ${INK_LIMITS.width} ${INK_LIMITS.height}`} width="100%" height="100%" aria-hidden="true">
        {strokes.map((s,i)=><polyline key={i} fill="none" stroke="#1d2f27" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round"
          points={s.reduce((out,n,j)=>out+(j%2?","+n:(j?" ":"")+n),"")}/>)}
        <circle cx={cursor.x} cy={cursor.y} r={down?7:5} fill={down?"#275c49":"none"} stroke="#9d8425" strokeWidth="2"/>
      </svg>
    </div>
    <p id="drawing-pad-status" aria-live="polite" className="drawing-pad-status">
      {down?"Pen down":"Pen up"} · {strokes.length} stroke(s){room?"":" · ink limit reached"}
    </p>
    <button type="button" disabled={disabled||!strokes.length} onClick={()=>{onChange(strokes.slice(0,-1));setDown(false);}}>Undo stroke</button>
    <button type="button" disabled={disabled||!strokes.length} onClick={()=>{onChange([]);setDown(false);}}>Clear drawing</button>
  </div>;
}

const downloadJson=(value,name)=>{
  const url=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:"application/json"}));
  const link=document.createElement("a");link.href=url;link.download=name;link.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
};
const descriptors=items=>items.map(item=>({...item,type:"public-key"}));
const defaultAuthenticate=options=>startAuthentication({optionsJSON:{
  challenge:options.challenge,rpId:options.rpId,timeout:300000,userVerification:"required",allowCredentials:descriptors(options.allowCredentials)}});

/**
 * Signing ceremony for one frozen edition: review intent and consent, choose a
 * mark and display preference, confirm with a passkey where required, then
 * download a receipt or withdraw. Props: tenantId, editionId, editionKind
 * (adopted|final|consultation-source), api, authenticate (test seam).
 */
export function SignaturePanel({tenantId,editionId,editionKind="final",api=defaultApi,authenticate=defaultAuthenticate}){
  const base="/api/workspaces/"+tenantId+"/editions/"+editionId;
  const kinds=EDITION_SIGNATURE_KINDS[editionKind]??["support"];
  const [kind,setKind]=useState(kinds[0]);
  const [intent,setIntent]=useState(null);
  const [markType,setMarkType]=useState("typed");
  const [typed,setTyped]=useState("");
  const [font,setFont]=useState(SIGNATURE_FONTS[0].id);
  const [strokes,setStrokes]=useState([]);
  const [visibility,setVisibility]=useState("private");
  const [publicName,setPublicName]=useState("");
  const [consent,setConsent]=useState(false);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  const [notice,setNotice]=useState("");
  const [mine,setMine]=useState([]);
  const [revision,setRevision]=useState(0);
  useEffect(()=>{
    let live=true;
    api(base+"/signatures/mine").then(result=>{if(live)setMine(result.items);}).catch(()=>{if(live)setMine([]);});
    return ()=>{live=false;};
  },[base,revision]);
  const active=mine.filter(item=>item.action==="sign"&&item.active);
  const reset=()=>{setIntent(null);setConsent(false);setStrokes([]);};
  async function run(work,done){
    if(busy)return;
    setBusy(true);setError("");setNotice("");
    try{await work();if(done)setNotice(done);}
    catch(reason){setError(message(reason));}
    finally{setBusy(false);}
  }
  const mark=()=>markType==="none"?{type:"none"}:markType==="typed"?{type:"typed",text:typed,fontId:font}:{type:"drawn",strokes};
  const ready=consent&&!busy&&(markType==="none"||(markType==="typed"?typed.trim().length>0:strokes.length>0))&&
    (visibility==="private"||publicName.trim().length>0);
  async function submit(){
    await run(async()=>{
      let passkey;
      if(intent.passkey&&(intent.passkey.required||kind!=="support")){
        try{passkey=await authenticate(intent.passkey);}
        catch{if(intent.passkey.required)throw Object.assign(Error("passkey"),{code:"PASSKEY_REQUIRED"});}
      }
      const result=await api(base+"/signatures",{method:"POST",body:{
        intentId:intent.intentId,signingDigest:intent.signingDigest,consent:true,mark:mark(),
        display:visibility==="public"?{visibility,name:publicName}:{visibility},...(passkey?{passkey}:{})}});
      setNotice("Signature recorded. Record digest "+result.recordDigest+". It will appear in the next manifest freeze.");
      reset();setRevision(r=>r+1);
    });
  }
  if(!tenantId||!editionId)return null;
  return <section className="signature-panel" aria-label="Sign this edition">
    <p className="eyebrow">FROZEN EDITION · SIGNATURES</p>
    {!!error&&<p role="alert">{error}</p>}
    {!!notice&&<p role="status">{notice}</p>}
    {!intent&&<div>
      <label>Signature type <select value={kind} onChange={e=>setKind(e.target.value)} disabled={busy}>
        {kinds.map(k=><option key={k} value={k}>{KIND_LABEL[k]}</option>)}</select></label>
      <button disabled={busy} onClick={()=>run(async()=>{setIntent(await api(base+"/intents",{method:"POST",body:{kind}}));
        setMarkType(kind==="support"?"none":"typed");})}>Review and sign</button>
    </div>}
    {intent&&<form onSubmit={e=>{e.preventDefault();if(ready)submit();}}>
      <h3>{KIND_LABEL[intent.intent.kind]}</h3>
      <p>Edition digest <code>{intent.intent.editionDigest}</code>{intent.intent.artifactDigest&&<> · rendered artifact SHA-256 <code>{intent.intent.artifactDigest}</code></>}</p>
      {intent.intent.capacity&&<p>Signing as: <strong>{intent.intent.capacity}</strong></p>}
      <blockquote>{intent.intent.consentText}</blockquote>
      <p className="signature-version">Consent wording {intent.intent.consentVersion}; request expires {new Date(intent.intent.expiresAt).toLocaleTimeString()}.</p>
      <fieldset><legend>Visual mark</legend>
        <label><input type="radio" name="mark" checked={markType==="typed"} onChange={()=>setMarkType("typed")}/>Type my name</label>
        <label><input type="radio" name="mark" checked={markType==="drawn"} onChange={()=>setMarkType("drawn")}/>Draw</label>
        {intent.intent.kind==="support"&&<label><input type="radio" name="mark" checked={markType==="none"} onChange={()=>setMarkType("none")}/>No mark</label>}
        {markType==="typed"&&<div>
          <label>Typed name <input value={typed} maxLength={120} onChange={e=>setTyped(e.target.value)}/></label>
          <label>Style <select value={font} onChange={e=>setFont(e.target.value)}>
            {SIGNATURE_FONTS.map(f=><option key={f.id} value={f.id}>{f.family} ({f.license})</option>)}</select></label>
          {typed&&<p aria-hidden="true" style={{fontFamily:`"${SIGNATURE_FONTS.find(f=>f.id===font).family}",cursive`,fontSize:28}}>{typed}</p>}
        </div>}
        {markType==="drawn"&&<DrawingPad strokes={strokes} onChange={setStrokes} disabled={busy}/>}
        <p className="signature-note">{MARK_NOTE}</p>
      </fieldset>
      <fieldset><legend>Who can see my name and mark</legend>
        <label><input type="radio" name="display" checked={visibility==="private"} onChange={()=>setVisibility("private")}/>Private: only me and workspace managers; the public sees a digest</label>
        <label><input type="radio" name="display" checked={visibility==="public"} onChange={()=>setVisibility("public")}/>Public: list my name and mark in the signer directory</label>
        {visibility==="public"&&<label>Public name <input value={publicName} maxLength={120} onChange={e=>setPublicName(e.target.value)}/></label>}
      </fieldset>
      <label><input type="checkbox" checked={consent} onChange={e=>setConsent(e.target.checked)}/>I have read the statement above and consent to sign this exact edition.</label>
      {intent.passkey?.required&&<p>You will confirm with your passkey; it is bound to this exact signing request.</p>}
      <button type="submit" disabled={!ready}>{intent.passkey?.required?"Confirm with passkey and sign":"Sign"}</button>
      <button type="button" disabled={busy} onClick={()=>run(async()=>{
        await api(base+"/intents/"+intent.intentId+"/decline",{method:"POST",body:{}});reset();},"Declined. Nothing was signed.")}>Decline</button>
    </form>}
    {active.length>0&&<div className="signature-mine"><h4>Your active signatures</h4><ul>{active.map(item=><li key={item.id}>
      {KIND_LABEL[item.kind]} · <code>{item.recordDigest.slice(0,16)}…</code>
      <button disabled={busy} onClick={()=>run(async()=>downloadJson(await api(base+"/signatures/"+item.id+"/receipt"),"signature-receipt-"+item.id+".json"),
        "Receipt downloaded. Verify it offline with scripts/verify-signature-receipt.mjs.")}>Download receipt</button>
      <button disabled={busy} onClick={()=>run(async()=>{await api(base+"/signatures/"+item.id+"/withdraw",{method:"POST",body:{}});setRevision(r=>r+1);},
        "Withdrawn. The original signature and the withdrawal both remain in the history.")}>Withdraw</button>
    </li>)}</ul></div>}
  </section>;
}
