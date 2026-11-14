import React, {useEffect, useId, useState} from "react";
import {createAccountAPI} from "./account-api.mjs";
import {useT} from "./i18n-react.mjs";
import {LanguagePicker} from "./language-picker.jsx";

const defaultAPI=createAccountAPI();
const CADENCES=["immediate","daily","weekly","off"];
const errorKey=(error)=>({
  AUTHENTICATION_REQUIRED:"common.signInToContinue",SIGN_IN_AGAIN:"common.signInAgain",RATE_LIMITED:"common.rateLimited",
  ACCESS_DENIED:"common.accessDenied",EMAIL_UNAVAILABLE:"notifications.emailUnavailable",EMAIL_NOT_VERIFIED:"notifications.emailNeedsVerification",
  INVALID_TOKEN:"notifications.unsubscribe.invalid",INVALID_EMAIL_ADDRESS:"common.invalidRequest",VERIFICATION_RATE_LIMITED:"common.rateLimited",
})[error?.code]??"common.serviceUnavailable";
const defaultDocumentLink=(documentId)=>"/?document="+encodeURIComponent(documentId);

function Status({children}) {
  return <p className="status" role="status" aria-live="polite">{children}</p>;
}

/** Notice text from an event kind and a public title only. */
function useDescribe() {
  const t=useT();
  return (item)=>t(t.has("notifications.kind."+item.eventKind)?"notifications.kind."+item.eventKind:"notifications.kind.other",{title:item.title});
}

function InboxEntry({entry,onToggle,busy,documentLink}) {
  const t=useT(),describe=useDescribe(),headingId=useId();
  const heading=entry.kind==="digest"
    ?t(entry.cadence==="weekly"?"notifications.digest.weekly":"notifications.digest.daily")+" · "+t("notifications.digestItems",{count:entry.items.length})
    :describe(entry.items[0]);
  return <li className={entry.read?"notification":"notification notification-unread"}>
    <article aria-labelledby={headingId}>
      <h3 id={headingId}>{!entry.read&&<span className="small">{t("notifications.unread")}: </span>}{heading}</h3>
      <p className="small"><time dateTime={entry.createdAt}>{t.date(entry.createdAt)}</time></p>
      <ul>
        {entry.items.map(item=><li key={item.seq}>
          {entry.kind==="digest"&&<>{describe(item)} · </>}
          <a href={documentLink(item.documentId)}>{t("notifications.open")}<span className="small"> — {item.title}</span></a>
        </li>)}
      </ul>
      <button type="button" disabled={busy} aria-describedby={headingId} onClick={()=>onToggle(entry,!entry.read)}>
        {t(entry.read?"notifications.markUnread":"notifications.markRead")}
      </button>
    </article>
  </li>;
}

export function NotificationInbox({api=defaultAPI,documentLink=defaultDocumentLink,pageSize=30}) {
  const t=useT(),headingId=useId();
  const [items,setItems]=useState([]),[cursor,setCursor]=useState(null),[unread,setUnread]=useState(0);
  const [status,setStatus]=useState(""),[busy,setBusy]=useState(false),[revision,setRevision]=useState(0);
  async function load(before,signal) {
    setBusy(true);setStatus(t("notifications.loading"));
    try{
      const result=await api("/api/notifications/inbox?limit="+pageSize+(before?"&before="+encodeURIComponent(before):""),{signal});
      setItems(previous=>before?[...previous,...result.items]:result.items);
      setCursor(result.nextCursor);setUnread(result.unreadCount);
      setStatus(result.items.length||before?t("notifications.unreadCount",{count:result.unreadCount}):t("notifications.empty"));
    }catch(error){if(error?.name!=="AbortError")setStatus(t(errorKey(error)));}
    finally{if(!signal?.aborted)setBusy(false);}
  }
  useEffect(()=>{const abort=new AbortController();load(null,abort.signal);return()=>abort.abort();},[revision]);
  async function toggle(entry,read) {
    setBusy(true);
    try{
      await api("/api/notifications/inbox/read",{method:"POST",body:{ids:[entry.id],read}});
      setItems(list=>list.map(item=>item.id===entry.id?{...item,read}:item));
      const count=unread+(read?-1:1);setUnread(count);setStatus(t("notifications.unreadCount",{count}));
    }catch(error){setStatus(t(errorKey(error)));}
    finally{setBusy(false);}
  }
  async function markAll() {
    setBusy(true);
    try{await api("/api/notifications/inbox/read-all",{method:"POST",body:{}});setRevision(n=>n+1);}
    catch(error){setStatus(t(errorKey(error)));setBusy(false);}
  }
  return <section className="notification-inbox" aria-labelledby={headingId}>
    <h2 id={headingId}>{t("notifications.inbox")}</h2>
    <Status>{status}</Status>
    <button type="button" disabled={busy||unread===0} onClick={markAll}>{t("notifications.markAllRead")}</button>
    {items.length>0&&<ol className="notification-list">
      {items.map(entry=><InboxEntry key={entry.id} entry={entry} busy={busy} onToggle={toggle} documentLink={documentLink}/>)}
    </ol>}
    {cursor&&<button type="button" disabled={busy} onClick={()=>load(cursor)}>{t("common.loadMore")}</button>}
  </section>;
}

export function NotificationPreferences({api=defaultAPI}) {
  const t=useT(),id=useId();
  const [preferences,setPreferences]=useState(null),[address,setAddress]=useState("");
  const [status,setStatus]=useState(""),[busy,setBusy]=useState(false);
  useEffect(()=>{
    const abort=new AbortController();
    api("/api/notifications/preferences",{signal:abort.signal})
      .then(result=>{setPreferences(result);setAddress(result.emailAddress?.address??"");})
      .catch(error=>{if(error?.name!=="AbortError")setStatus(t(errorKey(error)));});
    return()=>abort.abort();
  },[]);
  async function act(operation,doneKey) {
    setBusy(true);
    try{await operation();setStatus(t(doneKey));}
    catch(error){setStatus(t(errorKey(error)));}
    finally{setBusy(false);}
  }
  const save=(event)=>{event.preventDefault();act(async()=>setPreferences(await api("/api/notifications/preferences",{method:"PUT",
    body:{inApp:preferences.inApp,email:preferences.email,locale:preferences.locale}})),"notifications.preferencesSaved");};
  const verify=()=>act(async()=>{const result=await api("/api/notifications/email",{method:"PUT",body:{address}});
    setPreferences(p=>({...p,email:result.verified?p.email:"off",emailAddress:{address:result.address,verified:result.verified}}));},"notifications.emailVerificationSent");
  const remove=()=>act(async()=>{await api("/api/notifications/email",{method:"DELETE",body:{}});
    setAddress("");setPreferences(p=>({...p,email:"off",emailAddress:null}));},"notifications.emailRemoved");
  const headingId=id+"-heading";
  if(!preferences)return <section aria-labelledby={headingId}><h2 id={headingId}>{t("notifications.preferences")}</h2><Status>{status||t("common.loading")}</Status></section>;
  const emailReady=preferences.emailAvailable&&preferences.emailAddress?.verified;
  return <section className="notification-preferences" aria-labelledby={headingId}>
    <h2 id={headingId}>{t("notifications.preferences")}</h2>
    <form onSubmit={save} aria-labelledby={headingId}>
      <label htmlFor={id+"-in-app"}>{t("notifications.channel.inApp")}</label>
      <select id={id+"-in-app"} value={preferences.inApp} onChange={event=>setPreferences({...preferences,inApp:event.target.value})}>
        {CADENCES.map(cadence=><option key={cadence} value={cadence}>{t("notifications.cadence."+cadence)}</option>)}
      </select>
      <label htmlFor={id+"-email"}>{t("notifications.channel.email")}</label>
      <select id={id+"-email"} value={preferences.email} aria-describedby={emailReady?undefined:id+"-email-note"}
        onChange={event=>setPreferences({...preferences,email:event.target.value})}>
        {CADENCES.map(cadence=><option key={cadence} value={cadence} disabled={cadence!=="off"&&!emailReady}>{t("notifications.cadence."+cadence)}</option>)}
      </select>
      {!emailReady&&<p id={id+"-email-note"} className="small">{t(preferences.emailAvailable?"notifications.emailNeedsVerification":"notifications.emailUnavailable")}</p>}
      <LanguagePicker id={id+"-locale"} value={preferences.locale} onChange={locale=>setPreferences({...preferences,locale})}/>
      <button type="submit" disabled={busy}>{t("common.save")}</button>
    </form>
    {preferences.emailAvailable&&<div className="notification-email">
      <label htmlFor={id+"-address"}>{t("notifications.emailAddress")}</label>
      <input id={id+"-address"} type="email" autoComplete="email" maxLength={254} value={address}
        aria-describedby={id+"-address-state"} onChange={event=>setAddress(event.target.value)}/>
      <p id={id+"-address-state"} className="small">{preferences.emailAddress?t(preferences.emailAddress.verified?"notifications.emailVerified":"notifications.emailUnverified"):""}</p>
      <button type="button" disabled={busy||!address} onClick={verify}>{t("notifications.emailVerify")}</button>
      {preferences.emailAddress&&<button type="button" disabled={busy} onClick={remove}>{t("notifications.emailRemove")}</button>}
    </div>}
    <Status>{status}</Status>
  </section>;
}

export function SubscriptionList({api=defaultAPI}) {
  const t=useT(),headingId=useId();
  const [items,setItems]=useState(null),[status,setStatus]=useState(""),[busy,setBusy]=useState(false);
  useEffect(()=>{
    const abort=new AbortController();
    api("/api/notifications/subscriptions?limit=100",{signal:abort.signal})
      .then(result=>{setItems(result.items);if(!result.items.length)setStatus(t("notifications.noSubscriptions"));})
      .catch(error=>{if(error?.name!=="AbortError")setStatus(t(errorKey(error)));});
    return()=>abort.abort();
  },[]);
  async function remove(subscription) {
    setBusy(true);
    try{
      await api("/api/notifications/subscriptions/"+subscription.id,{method:"DELETE",body:{}});
      setItems(list=>list.filter(item=>item.id!==subscription.id));setStatus(t("notifications.unfollowed"));
    }catch(error){setStatus(t(errorKey(error)));}
    finally{setBusy(false);}
  }
  return <section className="notification-subscriptions" aria-labelledby={headingId}>
    <h2 id={headingId}>{t("notifications.subscriptions")}</h2>
    {items?.length>0&&<ul>
      {items.map(item=>{
        const label=t("notifications.target."+item.targetKind,{id:item.targetId.slice(0,8)});
        return <li key={item.id}>{label}{" "}
          <button type="button" disabled={busy} aria-label={t("notifications.unfollow")+": "+label} onClick={()=>remove(item)}>{t("notifications.unfollow")}</button>
        </li>;
      })}
    </ul>}
    <Status>{status}</Status>
  </section>;
}

/** Inbox, delivery preferences and followed items for the signed-in account. */
export function NotificationCenter({api=defaultAPI,documentLink=defaultDocumentLink}) {
  const t=useT();
  return <main className="notification-center" aria-label={t("notifications.title")}>
    <h1>{t("notifications.title")}</h1>
    <NotificationInbox api={api} documentLink={documentLink}/>
    <NotificationPreferences api={api}/>
    <SubscriptionList api={api}/>
  </main>;
}

/** Toggle for following a document, proposal or workspace. */
export function FollowButton({api=defaultAPI,targetKind,targetId,subscriptionId=null,onChange=()=>{}}) {
  const t=useT();
  const [current,setCurrent]=useState(subscriptionId),[status,setStatus]=useState(""),[busy,setBusy]=useState(false);
  async function toggle() {
    setBusy(true);
    try{
      if(current){
        await api("/api/notifications/subscriptions/"+current,{method:"DELETE",body:{}});
        setCurrent(null);onChange(null);setStatus(t("notifications.unfollowed"));
      }else{
        const created=await api("/api/notifications/subscriptions",{method:"POST",body:{targetKind,targetId}});
        setCurrent(created.id);onChange(created);setStatus(t("notifications.followed"));
      }
    }catch(error){setStatus(t(errorKey(error)));}
    finally{setBusy(false);}
  }
  return <span className="follow-control">
    <button type="button" aria-pressed={current!==null} disabled={busy} onClick={toggle}>{t(current?"notifications.following":"notifications.follow")}</button>
    <span className="status" role="status" aria-live="polite">{status}</span>
  </span>;
}

const publicPost=(fetcher,path,body)=>fetcher(path,{method:"POST",credentials:"same-origin",cache:"no-store",
  headers:{accept:"application/json","content-type":"application/json"},body:JSON.stringify(body)})
  .then(async response=>{const result=await response.json().catch(()=>({}));if(!response.ok)throw Object.assign(Error(result.error??"SERVICE_UNAVAILABLE"),{code:result.error});return result;});

/**
 * Landing page for an emailed unsubscribe link. The token arrives in the URL
 * fragment (never sent to servers by the browser); nothing changes until the
 * reader confirms, so link scanners cannot unsubscribe anyone.
 */
export function UnsubscribeConfirmation({token,fetcher=(...args)=>fetch(...args)}) {
  const t=useT(),headingId=useId();
  const [scope,setScope]=useState(null),[status,setStatus]=useState(""),[done,setDone]=useState(false),[busy,setBusy]=useState(false);
  useEffect(()=>{
    publicPost(fetcher,"/api/public/notifications/unsubscribe",{token,preview:true})
      .then(result=>setScope(result.scope)).catch(error=>setStatus(t(errorKey(error))));
  },[token]);
  async function confirm() {
    setBusy(true);
    try{await publicPost(fetcher,"/api/public/notifications/unsubscribe",{token});setDone(true);setStatus(t("notifications.unsubscribe.done"));}
    catch(error){setStatus(t(errorKey(error)));}
    finally{setBusy(false);}
  }
  return <main className="notification-token-page" aria-labelledby={headingId}>
    <h1 id={headingId}>{t("notifications.unsubscribe.title")}</h1>
    {scope&&!done&&<>
      <p>{t(scope==="email"?"notifications.unsubscribe.email":"notifications.unsubscribe.subscription")}</p>
      <button type="button" disabled={busy} onClick={confirm}>{t("notifications.unsubscribe.confirm")}</button>
    </>}
    <Status>{status}</Status>
  </main>;
}

/** Landing page for an emailed verification link; verifies only on an explicit action. */
export function EmailVerification({token,fetcher=(...args)=>fetch(...args)}) {
  const t=useT(),headingId=useId();
  const [status,setStatus]=useState(""),[done,setDone]=useState(false),[busy,setBusy]=useState(false);
  async function confirm() {
    setBusy(true);
    try{await publicPost(fetcher,"/api/public/notifications/email-verification",{token});setDone(true);setStatus(t("notifications.emailVerified"));}
    catch(error){setStatus(t(error?.code==="INVALID_TOKEN"?"notifications.emailVerificationInvalid":errorKey(error)));}
    finally{setBusy(false);}
  }
  return <main className="notification-token-page" aria-labelledby={headingId}>
    <h1 id={headingId}>{t("notifications.email.verifySubject")}</h1>
    {!done&&<button type="button" disabled={busy} onClick={confirm}>{t("notifications.emailConfirm")}</button>}
    <Status>{status}</Status>
  </main>;
}
