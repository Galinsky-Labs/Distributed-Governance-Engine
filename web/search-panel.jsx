import React, {useId, useRef, useState} from "react";
import {createAccountAPI} from "./account-api.mjs";
import {useT} from "./i18n-react.mjs";

const defaultAPI=createAccountAPI();
const MAX_CHARS=200, MAX_TERMS=16;
const errorKey=(error)=>error?.code==="INVALID_QUERY"?"search.invalid":
  error?.code==="AUTHENTICATION_REQUIRED"?"common.signInToContinue":
  error?.code==="RATE_LIMITED"?"common.rateLimited":
  error?.code==="ACCESS_DENIED"?"common.accessDenied":"search.failed";
const defaultLink=(item)=>"/?document="+encodeURIComponent(item.documentId)+(item.proposalId?"&proposal="+encodeURIComponent(item.proposalId):"");

/** Server snippet segments rendered as text; matches use <mark>, never injected HTML. */
function Snippet({snippet}) {
  if(!snippet?.segments?.length)return null;
  return <p className="search-snippet">
    {snippet.truncatedStart?"… ":""}
    {snippet.segments.map((segment,index)=>segment.match?<mark key={index}>{segment.text}</mark>:<React.Fragment key={index}>{segment.text}</React.Fragment>)}
    {snippet.truncatedEnd?" …":""}
  </p>;
}

/**
 * Full-text search over published content. scope="public" uses
 * /api/public/search; scope="member" uses /api/search and offers the
 * caller's workspaces (`workspaces`: [{tenantId}]) as a filter.
 */
export function SearchPanel({api=defaultAPI,scope="public",workspaces=[],pageSize=20,linkFor=defaultLink}) {
  const t=useT();
  const id=useId();
  const [query,setQuery]=useState("");
  const [mode,setMode]=useState("");
  const [kind,setKind]=useState("all");
  const [workspace,setWorkspace]=useState("");
  const [items,setItems]=useState([]);
  const [cursor,setCursor]=useState(null);
  const [status,setStatus]=useState("");
  const [busy,setBusy]=useState(false);
  const request=useRef(null);

  async function run(after) {
    const text=query.trim();
    if(!text||text.length>MAX_CHARS||text.split(/\s+/).length>MAX_TERMS){setStatus(t("search.invalid"));return;}
    request.current?.abort();
    const abort=new AbortController();request.current=abort;
    const parameters=new URLSearchParams({q:text,kind,limit:String(pageSize)});
    if(mode)parameters.set("mode",mode);
    if(scope==="member"&&workspace)parameters.set("workspace",workspace);
    if(after)parameters.set("cursor",after);
    setBusy(true);setStatus(t("search.searching"));
    try{
      const result=await api((scope==="member"?"/api/search?":"/api/public/search?")+parameters,{signal:abort.signal});
      const next=after?[...items,...result.items]:result.items;
      setItems(next);setCursor(result.nextCursor);
      setStatus(next.length?t("search.resultCount",{count:next.length}):t("search.noResults"));
    }catch(error){
      if(error?.name!=="AbortError")setStatus(t(errorKey(error)));
    }finally{
      if(request.current===abort)setBusy(false);
    }
  }

  const headingId=id+"-heading", hintId=id+"-hint";
  return <section className="search-panel" aria-labelledby={headingId}>
    <h2 id={headingId}>{t(scope==="member"?"search.memberTitle":"search.title")}</h2>
    <form role="search" onSubmit={event=>{event.preventDefault();run(null);}}>
      <label htmlFor={id+"-q"}>{t("search.label")}</label>
      <input id={id+"-q"} type="search" value={query} maxLength={MAX_CHARS} aria-describedby={hintId}
        onChange={event=>setQuery(event.target.value)}/>
      <p id={hintId} className="small">{t("search.hint")}</p>
      <fieldset>
        <legend>{t("search.filters")}</legend>
        <label htmlFor={id+"-mode"}>{t("search.mode")}</label>
        <select id={id+"-mode"} value={mode} onChange={event=>setMode(event.target.value)}>
          <option value="">{t("search.mode.any")}</option>
          <option value="collaboration">{t("mode.collaboration")}</option>
          <option value="public-input">{t("mode.publicInput")}</option>
        </select>
        <label htmlFor={id+"-kind"}>{t("search.kind")}</label>
        <select id={id+"-kind"} value={kind} onChange={event=>setKind(event.target.value)}>
          {["all","document","proposal"].map(value=><option key={value} value={value}>{t("search.kind."+value)}</option>)}
        </select>
        {scope==="member"&&<>
          <label htmlFor={id+"-workspace"}>{t("search.workspace")}</label>
          <select id={id+"-workspace"} value={workspace} onChange={event=>setWorkspace(event.target.value)}>
            <option value="">{t("search.workspace.any")}</option>
            {workspaces.map(w=><option key={w.tenantId} value={w.tenantId}>{t("search.workspaceOption",{id:w.tenantId.slice(0,8)})}</option>)}
          </select>
        </>}
      </fieldset>
      <button type="submit" disabled={busy}>{t("search.submit")}</button>
    </form>
    <p className="status" role="status" aria-live="polite">{status}</p>
    {items.length>0&&<ol className="search-results" aria-label={t("search.results")}>
      {items.map(item=><li key={item.kind+item.proposalId+item.documentId}>
        <article>
          <h3><a href={linkFor(item)}>{item.title}</a></h3>
          <p className="small">
            {t(item.kind==="proposal"?"search.result.proposal":"search.result.document")}
            {" · "}{t(item.mode==="public-input"?"mode.publicInput":"mode.collaboration")}
            {" · "}{t("search.result.edition",{version:item.version})}
          </p>
          <Snippet snippet={item.snippet}/>
        </article>
      </li>)}
    </ol>}
    {cursor&&<button type="button" disabled={busy} onClick={()=>run(cursor)}>{t("common.loadMore")}</button>}
    <p className="small">{t("search.privateNote")}</p>
  </section>;
}
