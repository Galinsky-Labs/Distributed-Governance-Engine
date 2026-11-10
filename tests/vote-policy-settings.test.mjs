import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeVotePolicySettings,DEFAULT_VOTE_SETTINGS,describeVotePolicy} from '../src/vote-policy-settings.mjs';
import {createGovernanceSnapshot,ballotForGovernanceSnapshot,evaluateGovernanceSnapshot} from '../src/governance-snapshots.mjs';
const snapshot=(basis,comparison,mode='collaboration')=>createGovernanceSnapshot({id:'decision',tenantId:'tenant',documentId:'document',mode,createdAt:100,proposalDigest:'a'.repeat(64),
 electorate:{id:'electorate',kind:'frozen',members:['alice','bob','carol'].map(principalId=>({principalId,weight:'1'}))},
 policy:{id:'policy',weighting:'equal',allowEarlyClose:false,opensAt:100,closesAt:200,minYes:'1',quorum:{kind:'count',minimum:'2'},approval:{basis,comparison,numerator:'1',denominator:'2'}}});
for(const [basis,comparison,choices,expected] of [
 ['decisive','gt',['yes','no'],'failed'],['decisive','gte',['yes','no'],'passed'],
 ['decisive','gt',['yes','abstain'],'passed'],['participating','gt',['yes','abstain'],'failed'],
 ['participating','gte',['yes','abstain'],'passed'],['eligible','gte',['yes','abstain'],'failed'],
 ['eligible','gte',['yes','yes'],'passed']
])test(`exact threshold ${basis} ${comparison} ${choices.join('/')} is ${expected}`,()=>{
 const s=snapshot(basis,comparison),ballots=choices.map((choice,i)=>ballotForGovernanceSnapshot(s,['alice','bob'][i],choice,150));
 assert.equal(evaluateGovernanceSnapshot(s,ballots,200).status,expected);
 const advisory=snapshot(basis,comparison,'public-input');
 const result=evaluateGovernanceSnapshot(advisory,choices.map((choice,i)=>ballotForGovernanceSnapshot(advisory,['alice','bob'][i],choice,150)),200);
 assert.equal(result.status,'advisory');assert.equal(result.canAdopt,false);
});
test('settings freeze independent copies and reject unsafe or ambiguous values without invoking accessors',()=>{
 assert.deepEqual(normalizeVotePolicySettings({}),DEFAULT_VOTE_SETTINGS);
 assert.equal(describeVotePolicy({...DEFAULT_VOTE_SETTINGS}).approval,'Strict majority of yes/no votes');
 let accessed=false;const getter={get minYes(){accessed=true;return '1';}};
 for(const invalid of [getter,{minYes:null},{quorum:null},{approval:null},{minimumDeliberationHours:null},{minimumDeliberationHours:-0},{minYes:'01'},{minYes:1},{minimumDeliberationHours:0.5},{minimumDeliberationHours:721},
  {quorum:{kind:'weight',minimum:'1'}},{approval:{basis:'eligible',comparison:'gt',numerator:'2',denominator:'2'}},
  Object.assign(Object.create({minYes:'2'}),{}),{[Symbol('hidden')]:true}])assert.throws(()=>normalizeVotePolicySettings(invalid));
 assert.equal(accessed,false);
 const input=structuredClone(DEFAULT_VOTE_SETTINGS),normalized=normalizeVotePolicySettings(input);input.quorum.numerator='2';
 assert.equal(normalized.quorum.numerator,'1');assert.ok(Object.isFrozen(normalized.quorum));
});
