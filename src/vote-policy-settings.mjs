import {invariant,integer} from './integrity-values.mjs';
const fields=(value,allowed,required=[])=>{
 invariant(value&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value)),'Use a plain vote-policy object.');
 invariant(Object.getOwnPropertySymbols(value).length===0,'Unknown vote-policy field.');
 for(const key of Object.getOwnPropertyNames(value)){const descriptor=Object.getOwnPropertyDescriptor(value,key);invariant(allowed.includes(key)&&descriptor.enumerable&&Object.hasOwn(descriptor,'value'),'Unknown or unsafe vote-policy field.');}
 for(const key of required)invariant(Object.hasOwn(value,key),'Complete every required vote-policy field.');
};
const positive=(value,limit)=>{const number=integer(value,{positive:true});invariant(number<=BigInt(limit),'Vote-policy number exceeds its supported limit.');return value;};
export const DEFAULT_VOTE_SETTINGS=Object.freeze({
 minYes:'1',minimumDeliberationHours:0,
 quorum:Object.freeze({kind:'fraction-count',numerator:'1',denominator:'2'}),
 approval:Object.freeze({basis:'decisive',comparison:'gt',numerator:'1',denominator:'2'}),
});
/** Public account-based voting only: no caller weighting, mode or early-close override. */
export function normalizeVotePolicySettings(value=DEFAULT_VOTE_SETTINGS){
 fields(value,['minYes','minimumDeliberationHours','quorum','approval']);
 const minYes=positive(Object.hasOwn(value,'minYes')?value.minYes:'1',100000),minimumDeliberationHours=Object.hasOwn(value,'minimumDeliberationHours')?value.minimumDeliberationHours:0;
 invariant(Number.isSafeInteger(minimumDeliberationHours)&&!Object.is(minimumDeliberationHours,-0)&&minimumDeliberationHours>=0&&minimumDeliberationHours<=720,'Minimum deliberation must be 0 to 720 whole hours.');
 const q=Object.hasOwn(value,'quorum')?value.quorum:DEFAULT_VOTE_SETTINGS.quorum;fields(q,['kind','minimum','numerator','denominator'],['kind']);let quorum;
 if(q.kind==='count'){fields(q,['kind','minimum'],['kind','minimum']);quorum={kind:'count',minimum:positive(q.minimum,100000)};}
 else {invariant(q.kind==='fraction-count','Choose an account-count quorum.');fields(q,['kind','numerator','denominator'],['kind','numerator','denominator']);positive(q.numerator,1000000);positive(q.denominator,1000000);invariant(BigInt(q.numerator)<=BigInt(q.denominator),'Quorum fraction cannot exceed one.');quorum={kind:q.kind,numerator:q.numerator,denominator:q.denominator};}
 const a=Object.hasOwn(value,'approval')?value.approval:DEFAULT_VOTE_SETTINGS.approval;fields(a,['basis','comparison','numerator','denominator'],['basis','comparison','numerator','denominator']);
 invariant(['decisive','participating','eligible'].includes(a.basis),'Choose yes/no, participating or eligible approval units.');invariant(['gt','gte'].includes(a.comparison),'Choose strict or at-least approval.');positive(a.numerator,1000000);positive(a.denominator,1000000);
 invariant(BigInt(a.numerator)<=BigInt(a.denominator)&&!(a.comparison==='gt'&&a.numerator===a.denominator),'Approval threshold must be attainable.');
 return Object.freeze({minYes,minimumDeliberationHours,quorum:Object.freeze(quorum),approval:Object.freeze({basis:a.basis,comparison:a.comparison,numerator:a.numerator,denominator:a.denominator})});
}
export function describeVotePolicy(policy){
 const q=policy.quorum,a=policy.approval;
 const quorum=q.kind==='fraction-count'&&q.numerator==='1'&&q.denominator==='2'?'At least half of the frozen electorate':q.kind==='count'?'At least '+q.minimum+' frozen eligible member accounts':q.kind==='weight'?'At least '+q.minimum+' frozen voting units':'At least '+q.numerator+'/'+q.denominator+' of frozen '+(q.kind==='fraction-weight'?'voting units':'eligible member accounts');
 const denominator=a.basis==='decisive'?'yes/no votes':a.basis==='participating'?'all participating votes, including abstentions':'all frozen eligible votes';
 const approval=a.basis==='decisive'&&a.comparison==='gt'&&a.numerator==='1'&&a.denominator==='2'?'Strict majority of yes/no votes':(a.comparison==='gt'?'More than ':'At least ')+a.numerator+'/'+a.denominator+' of '+denominator;
 return {quorum,approval,minYes:Number(policy.minYes),minimumDeliberationHours:policy.minimumDeliberationHours??0};
}
