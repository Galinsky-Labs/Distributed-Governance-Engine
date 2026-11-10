import {digest,identifier,integer,invariant,validDigest} from './integrity.mjs';

function timestamp(t) { invariant(Number.isSafeInteger(t)&&t>=0,'Invalid timestamp'); return t; }
export function validatePolicy(p) {
  invariant(p && typeof p==='object','Missing policy'); identifier(p.id);
  invariant(['equal','shares'].includes(p.weighting),'Invalid weighting');
  invariant(typeof p.allowEarlyClose==='boolean','Early closure must be explicit');
  timestamp(p.opensAt); timestamp(p.closesAt);
  invariant(p.closesAt>p.opensAt,'Invalid voting window');
  if(Object.hasOwn(p,'minimumDeliberationHours')||Object.hasOwn(p,'proposalPublishedAt')){
    invariant(Number.isSafeInteger(p.minimumDeliberationHours)&&p.minimumDeliberationHours>=0&&p.minimumDeliberationHours<=720,'Invalid minimum deliberation');
    timestamp(p.proposalPublishedAt);const floor=p.proposalPublishedAt+p.minimumDeliberationHours*3600000;
    invariant(Number.isSafeInteger(floor)&&p.opensAt>=floor,'Vote opens before minimum deliberation');
  }
  integer(p.minYes,{positive:true});
  invariant(p.quorum && ['count','weight','fraction-count','fraction-weight'].includes(p.quorum.kind),'Invalid quorum');
  if(p.quorum.kind.startsWith('fraction-')) {
    const n=integer(p.quorum.numerator,{positive:true}),d=integer(p.quorum.denominator,{positive:true});
    invariant(n<=d,'Invalid quorum fraction');
  } else integer(p.quorum.minimum,{positive:true});
  invariant(p.approval && ['decisive','participating','eligible'].includes(p.approval.basis),'Invalid approval denominator');
  invariant(['gt','gte'].includes(p.approval.comparison),'Invalid approval comparison');
  const n=integer(p.approval.numerator,{positive:true}),d=integer(p.approval.denominator,{positive:true});
  invariant(n<=d,'Invalid approval fraction');
  return p;
}

/** Pure reference evaluator. Caller must authenticate, persist, serialize and verify snapshots. */
export function evaluateDecision({mode,policy,electorate,ballots,proposalDigest,now}) {
  invariant(['collaboration','public-input'].includes(mode),'Invalid document mode');
  validatePolicy(policy); timestamp(now); validDigest(proposalDigest);
  identifier(electorate.id);
  invariant(electorate.kind==='frozen','Foundation supports frozen electorates only');
  invariant(Array.isArray(electorate.members)&&electorate.members.length>0&&electorate.members.length<=100000,'Invalid electorate');
  const members=new Map(); let eligibleWeight=0n;
  for(const m of electorate.members) {
    identifier(m.principalId); invariant(!members.has(m.principalId),'Duplicate electorate principal');
    const weight=integer(m.weight,{positive:true});
    invariant(policy.weighting!=='equal' || weight===1n,'Equal policy requires one vote per eligible person');
    members.set(m.principalId,weight); eligibleWeight+=weight;
  }
  invariant(Array.isArray(ballots)&&ballots.length<=members.size,'Invalid ballot collection');
  const policyHash=digest('policy',policy),electorateHash=digest('electorate',electorate);
  const totals={yes:0n,no:0n,abstain:0n}; const seen=new Set();
  for(const b of ballots) {
    identifier(b.principalId);
    invariant(members.has(b.principalId),'Ineligible principal');
    invariant(!seen.has(b.principalId),'Duplicate active ballot'); seen.add(b.principalId);
    invariant(b.proposalDigest===proposalDigest && b.electorateId===electorate.id && b.policyId===policy.id && b.policyDigest===policyHash && b.electorateDigest===electorateHash,'Ballot snapshot binding mismatch');
    timestamp(b.castAt);
    invariant(b.castAt>=policy.opensAt && b.castAt<policy.closesAt && b.castAt<=now,'Ballot outside voting window');
    invariant(['yes','no','abstain'].includes(b.choice),'Invalid choice');
    invariant(!Object.hasOwn(b,'weight'),'Ballot cannot supply its own weight');
    totals[b.choice]+=members.get(b.principalId);
  }
  const participatingWeight=totals.yes+totals.no+totals.abstain;
  const counts={eligible:members.size,participating:seen.size};
  const weights={eligible:eligibleWeight.toString(),participating:participatingWeight.toString(),yes:totals.yes.toString(),no:totals.no.toString(),abstain:totals.abstain.toString()};
  const binding={mode,policyDigest:policyHash,electorateDigest:electorateHash,proposalDigest};
  if(mode==='public-input') return {...binding,status:'advisory',canAdopt:false,quorumMet:null,approvalMet:null,counts,weights};
  const q=policy.quorum;
  const quorumMet=q.kind==='count'? BigInt(counts.participating)>=integer(q.minimum):
    q.kind==='weight'?participatingWeight>=integer(q.minimum):
    q.kind==='fraction-count'?BigInt(counts.participating)*integer(q.denominator)>=BigInt(counts.eligible)*integer(q.numerator):
    participatingWeight*integer(q.denominator)>=eligibleWeight*integer(q.numerator);
  const denominator=policy.approval.basis==='eligible'?eligibleWeight:policy.approval.basis==='participating'?participatingWeight:totals.yes+totals.no;
  const left=totals.yes*integer(policy.approval.denominator), right=denominator*integer(policy.approval.numerator);
  const approvalMet=denominator>0n && totals.yes>=integer(policy.minYes) && (policy.approval.comparison==='gt'?left>right:left>=right);
  const passed=quorumMet&&approvalMet;
  const status=now<policy.opensAt?'not-open':now<policy.closesAt&&!(policy.allowEarlyClose&&passed)?'open':passed?'passed':'failed';
  return {...binding,status,canAdopt:status==='passed',quorumMet,approvalMet,counts,weights};
}
