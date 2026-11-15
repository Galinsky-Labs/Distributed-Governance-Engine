// DCE-010: pure policy helpers that complement the frozen governance snapshot.
// Tie rules, wall-clock deadline resolution in a named time zone, published
// open-public support floors and the document-mode transition table. Callers
// still authenticate, persist and bind results to policy/electorate digests.
import {invariant,integer} from './integrity-values.mjs';

export const TIE_RULES=Object.freeze(['fails','casting-vote']);
export const DOCUMENT_MODES=Object.freeze(['collaboration','public-input']);

/**
 * A tie exists when yes and no carry equal weight and there is at least one
 * decisive unit. 'fails' preserves the status quo. 'casting-vote' requires a
 * recorded casting choice by the presiding principal; without one the
 * decision fails closed rather than inventing an outcome.
 */
export function resolveTie({yes,no,rule='fails',castingVote=null}){
  const y=integer(yes),n=integer(no);
  invariant(TIE_RULES.includes(rule),'Invalid tie rule');
  if(y!==n||y===0n) return {tie:false,outcome:y>n?'yes':y<n?'no':'none',rule};
  if(rule==='fails') return {tie:true,outcome:'no',rule,reason:'tie-fails'};
  if(castingVote===null) return {tie:true,outcome:'no',rule,reason:'casting-vote-missing'};
  invariant(castingVote&&typeof castingVote==='object','Invalid casting vote');
  invariant(['yes','no'].includes(castingVote.choice),'A casting vote must be yes or no');
  invariant(typeof castingVote.principalId==='string'&&castingVote.principalId.length>0,'A casting vote names its presiding principal');
  return {tie:true,outcome:castingVote.choice,rule,reason:'casting-vote',principalId:castingVote.principalId};
}

const DATE=/^([0-9]{4})-([0-9]{2})-([0-9]{2})$/,TIME=/^([01][0-9]|2[0-3]):([0-5][0-9])$/;
const partsIn=(instant,timeZone)=>{
  const f=new Intl.DateTimeFormat('en-US',{timeZone,hourCycle:'h23',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'});
  const o=Object.fromEntries(f.formatToParts(new Date(instant)).filter(p=>p.type!=='literal').map(p=>[p.type,Number(p.value)]));
  return Date.UTC(o.year,o.month-1,o.day,o.hour,o.minute,o.second);
};

/**
 * Converts a published local deadline ("2026-03-08 02:30 America/New_York")
 * to an exact UTC instant. Nonexistent (spring-forward) and ambiguous
 * (fall-back) local times are rejected so the published wording can never
 * mean two different cutoffs.
 */
export function deadlineInstant({date,time,timeZone}){
  const d=DATE.exec(date??''),t=TIME.exec(time??'');
  invariant(d&&t,'Use YYYY-MM-DD and HH:MM for a deadline');
  invariant(typeof timeZone==='string'&&timeZone.length<=64,'Invalid time zone');
  try{new Intl.DateTimeFormat('en-US',{timeZone});}catch{invariant(false,'Unknown time zone');}
  const local=Date.UTC(Number(d[1]),Number(d[2])-1,Number(d[3]),Number(t[1]),Number(t[2]));
  const check=new Date(local);
  invariant(check.getUTCFullYear()===Number(d[1])&&check.getUTCMonth()===Number(d[2])-1&&check.getUTCDate()===Number(d[3]),'Invalid calendar date');
  const candidates=new Set();
  // Offsets in use today lie within -14h..+14h; probe both sides of the guess.
  for(const probe of [local-14*3600000,local,local+14*3600000]){
    const offset=partsIn(probe,timeZone)-probe,instant=local-offset;
    if(partsIn(instant,timeZone)===local) candidates.add(instant);
  }
  invariant(candidates.size>0,'That local time does not exist in this time zone');
  invariant(candidates.size===1,'That local time is ambiguous in this time zone');
  return [...candidates][0];
}

/** A ballot is on time when cast strictly before the resolved cutoff. */
export const castBeforeDeadline=(castAt,deadline)=>{
  invariant(Number.isSafeInteger(castAt)&&Number.isSafeInteger(deadline),'Invalid instant');
  return castAt<deadline;
};

/**
 * Open-public electorates are advisory. A published support floor must be
 * fixed before the window opens; results report whether participation and
 * support reached it, and never permit adoption.
 */
export function validateSupportFloor(floor){
  invariant(floor&&typeof floor==='object','Missing support floor');
  integer(floor.minimumParticipants,{positive:true});
  const n=integer(floor.supportNumerator,{positive:true}),d=integer(floor.supportDenominator,{positive:true});
  invariant(n<=d,'Support fraction cannot exceed one');
  invariant(Number.isSafeInteger(floor.publishedAt)&&floor.publishedAt>=0,'A support floor needs its publication time');
  invariant(Number.isSafeInteger(floor.maxPerVerifiedPerson)&&floor.maxPerVerifiedPerson===1,'Open-public participation is one response per verified person');
  return floor;
}

export function evaluateOpenPublicSupport({floor,opensAt,responses,now}){
  validateSupportFloor(floor);
  invariant(Number.isSafeInteger(opensAt)&&Number.isSafeInteger(now),'Invalid instant');
  invariant(floor.publishedAt<=opensAt,'The support floor must be published before responses open');
  invariant(Array.isArray(responses)&&responses.length<=1000000,'Invalid responses');
  const people=new Set();let support=0n,oppose=0n,neutral=0n;
  for(const r of responses){
    invariant(typeof r.personKey==='string'&&r.personKey.length>=16,'Responses must carry a pseudonymous person key');
    invariant(!people.has(r.personKey),'Duplicate response for one verified person');people.add(r.personKey);
    invariant(Number.isSafeInteger(r.at)&&r.at>=opensAt&&r.at<=now,'Response outside the window');
    if(r.choice==='support')support++;else if(r.choice==='oppose')oppose++;else{invariant(r.choice==='neutral','Invalid response');neutral++;}
  }
  const participants=BigInt(people.size),participationMet=participants>=integer(floor.minimumParticipants);
  const supportMet=participants>0n&&support*integer(floor.supportDenominator)>=participants*integer(floor.supportNumerator);
  const status=!participationMet?'insufficient-participation':supportMet?'support-floor-met':'support-floor-not-met';
  return {status,canAdopt:false,advisory:true,participants:participants.toString(),
    support:support.toString(),oppose:oppose.toString(),neutral:neutral.toString()};
}

/**
 * The only permitted mode transition is a one-way freeze of a collaboration
 * draft into public input, by an owner/admin, with no vote open or awaiting
 * finality. Every other path is rejected with a stable code.
 */
export function modeTransition({from,to,role,activeVote}){
  invariant(DOCUMENT_MODES.includes(from)&&DOCUMENT_MODES.includes(to),'Invalid document mode');
  if(from===to) return {allowed:false,code:'MODE_UNCHANGED'};
  if(from==='public-input') return {allowed:false,code:'SOURCE_FROZEN'};
  if(!['owner','admin'].includes(role)) return {allowed:false,code:'FORBIDDEN'};
  if(activeVote) return {allowed:false,code:'VOTE_IN_PROGRESS'};
  return {allowed:true,code:null};
}
