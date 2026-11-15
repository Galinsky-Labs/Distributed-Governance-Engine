import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateDecision} from '../src/governance.mjs';
import {resolveTie,deadlineInstant,castBeforeDeadline,evaluateOpenPublicSupport,validateSupportFloor,modeTransition} from '../src/policy-lifecycle.mjs';
import {input,policy,ballot} from './fixtures.mjs';

// Boundary table: strict majority (gt) vs at-least (gte) supermajority, with abstentions.
const rows=[
 // yes,no,abstain, approval, expected approvalMet
 [2,2,0,{basis:'decisive',comparison:'gt',numerator:'1',denominator:'2'},false], // exact half fails strict majority
 [2,2,0,{basis:'decisive',comparison:'gte',numerator:'1',denominator:'2'},true],  // exact half meets at-least half
 [2,1,0,{basis:'decisive',comparison:'gte',numerator:'2',denominator:'3'},true],  // exactly two-thirds
 [2,1,0,{basis:'decisive',comparison:'gt',numerator:'2',denominator:'3'},false],
 [3,1,0,{basis:'decisive',comparison:'gt',numerator:'2',denominator:'3'},true],
 [2,1,1,{basis:'participating',comparison:'gte',numerator:'2',denominator:'3'},false], // abstention counts against
 [2,1,1,{basis:'decisive',comparison:'gte',numerator:'2',denominator:'3'},true],       // abstention ignored
];
const names=['alice','bob','chris','dana','erin'];
for(const [yes,no,abstain,approval,expected] of rows){
 test(`approval boundary ${yes}/${no}/${abstain} ${approval.basis} ${approval.comparison} ${approval.numerator}/${approval.denominator}`,()=>{
  const choices=[...Array(yes).fill('yes'),...Array(no).fill('no'),...Array(abstain).fill('abstain')];
  const members=names.map(principalId=>({principalId,weight:'1'}));
  const x=input({policy:{...policy,approval},electorate:{id:'electorate-1',kind:'frozen',members}});
  const p=x.policy,e=x.electorate;
  const r=evaluateDecision({...x,ballots:choices.map((c,i)=>ballot(names[i],c,{policy:p,electorate:e}))});
  assert.equal(r.approvalMet,expected);
 });
}

test('empty electorates are rejected rather than evaluated',()=>{
 assert.throws(()=>evaluateDecision(input({electorate:{id:'electorate-1',kind:'frozen',members:[]}})),/Invalid electorate/);
});

test('tie rules: status quo by default, casting vote only when recorded',()=>{
 assert.deepEqual(resolveTie({yes:'3',no:'2'}),{tie:false,outcome:'yes',rule:'fails'});
 assert.equal(resolveTie({yes:'0',no:'0'}).tie,false);
 assert.equal(resolveTie({yes:'2',no:'2'}).outcome,'no');
 assert.equal(resolveTie({yes:'2',no:'2',rule:'casting-vote'}).reason,'casting-vote-missing');
 assert.equal(resolveTie({yes:'2',no:'2',rule:'casting-vote',castingVote:{principalId:'chair',choice:'yes'}}).outcome,'yes');
 assert.throws(()=>resolveTie({yes:'2',no:'2',rule:'lot'}),/Invalid tie rule/);
 assert.throws(()=>resolveTie({yes:'2',no:'2',rule:'casting-vote',castingVote:{principalId:'chair',choice:'abstain'}}),/yes or no/);
});

test('timezone cutoffs resolve exactly, including DST gaps and overlaps',()=>{
 assert.equal(deadlineInstant({date:'2026-01-15',time:'17:00',timeZone:'America/New_York'}),Date.UTC(2026,0,15,22,0));
 assert.equal(deadlineInstant({date:'2026-07-15',time:'17:00',timeZone:'America/New_York'}),Date.UTC(2026,6,15,21,0));
 assert.equal(deadlineInstant({date:'2026-07-15',time:'17:00',timeZone:'UTC'}),Date.UTC(2026,6,15,17,0));
 assert.equal(deadlineInstant({date:'2026-07-15',time:'09:00',timeZone:'Asia/Kolkata'}),Date.UTC(2026,6,15,3,30));
 assert.equal(deadlineInstant({date:'2026-12-31',time:'23:59',timeZone:'Pacific/Kiritimati'}),Date.UTC(2026,11,31,9,59));
 assert.throws(()=>deadlineInstant({date:'2026-03-08',time:'02:30',timeZone:'America/New_York'}),/does not exist/);
 assert.throws(()=>deadlineInstant({date:'2026-11-01',time:'01:30',timeZone:'America/New_York'}),/ambiguous/);
 assert.throws(()=>deadlineInstant({date:'2026-02-30',time:'10:00',timeZone:'UTC'}),/calendar/);
 assert.throws(()=>deadlineInstant({date:'2026-02-01',time:'10:00',timeZone:'Mars/Olympus'}),/Unknown time zone/);
 const cutoff=deadlineInstant({date:'2026-01-15',time:'17:00',timeZone:'Europe/London'});
 assert.equal(castBeforeDeadline(cutoff-1,cutoff),true);
 assert.equal(castBeforeDeadline(cutoff,cutoff),false);
});

const floor={minimumParticipants:'3',supportNumerator:'1',supportDenominator:'2',publishedAt:100,maxPerVerifiedPerson:1};
const resp=(n,choice,at=150)=>({personKey:'person-key-'+String(n).padStart(8,'0'),choice,at});
test('open-public support floors are advisory, published in advance and one response per person',()=>{
 assert.equal(evaluateOpenPublicSupport({floor,opensAt:100,now:200,responses:[resp(1,'support'),resp(2,'support')]}).status,'insufficient-participation');
 const met=evaluateOpenPublicSupport({floor,opensAt:100,now:200,responses:[resp(1,'support'),resp(2,'oppose'),resp(3,'neutral'),resp(4,'support')]});
 assert.equal(met.status,'support-floor-met');assert.equal(met.canAdopt,false);assert.equal(met.advisory,true);
 assert.equal(evaluateOpenPublicSupport({floor,opensAt:100,now:200,responses:[resp(1,'support'),resp(2,'oppose'),resp(3,'oppose')]}).status,'support-floor-not-met');
 assert.throws(()=>evaluateOpenPublicSupport({floor:{...floor,publishedAt:101},opensAt:100,now:200,responses:[]}),/published before/);
 assert.throws(()=>evaluateOpenPublicSupport({floor,opensAt:100,now:200,responses:[resp(1,'support'),resp(1,'oppose')]}),/Duplicate/);
 assert.throws(()=>evaluateOpenPublicSupport({floor,opensAt:100,now:200,responses:[resp(1,'support',99)]}),/outside/);
 assert.throws(()=>validateSupportFloor({...floor,maxPerVerifiedPerson:2}),/one response/);
 assert.throws(()=>validateSupportFloor({...floor,supportNumerator:'3',supportDenominator:'2'}),/exceed/);
});

test('every document-mode mutation path is enumerated',()=>{
 const table=[
  ['collaboration','public-input','owner',false,true,null],
  ['collaboration','public-input','admin',false,true,null],
  ['collaboration','public-input','owner',true,false,'VOTE_IN_PROGRESS'],
  ['collaboration','public-input','participant',false,false,'FORBIDDEN'],
  ['public-input','collaboration','owner',false,false,'SOURCE_FROZEN'],
  ['public-input','public-input','owner',false,false,'MODE_UNCHANGED'],
  ['collaboration','collaboration','owner',false,false,'MODE_UNCHANGED'],
 ];
 for(const [from,to,role,activeVote,allowed,code] of table) assert.deepEqual(modeTransition({from,to,role,activeVote}),{allowed,code});
 assert.throws(()=>modeTransition({from:'consultation',to:'public-input',role:'owner',activeVote:false}),/Invalid document mode/);
});
