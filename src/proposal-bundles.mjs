import {invariant} from "./integrity.mjs";
import {validateLegalDocument,legalDocumentDigest} from "./legal-schema.mjs";
import {selectionContext,replaceSelectedText} from "./text-selections.mjs";
import {textProposalDigest} from "./legal-proposals.mjs";

/**
 * Apply an ordered bundle of text proposals that all target the same exact
 * base edition, producing exactly one next revision. Every proposal is
 * checked against the untouched base; overlapping or touching selections in
 * one block are rejected so no proposal can silently change another's
 * voted meaning. Either every proposal applies or the call throws.
 */
export function applyProposalBundle(document,proposals){
  const doc=validateLegalDocument(document);
  invariant(Array.isArray(proposals)&&proposals.length>=1&&proposals.length<=20,"Invalid proposal bundle");
  const baseDigest=legalDocumentDigest(doc);
  for(const proposal of proposals){
    textProposalDigest(proposal);
    invariant(proposal.documentId===doc.id&&proposal.tenantId===doc.tenantId,"Proposal context mismatch");
    invariant(proposal.baseDigest===baseDigest&&proposal.baseRevision===doc.revision,"Stale proposal requires reconfirmation and a new vote");
    const context=selectionContext(doc,proposal.selection);
    invariant(context.prefix===proposal.context.prefix&&context.suffix===proposal.context.suffix,"Proposal context changed");
  }
  for(let i=0;i<proposals.length;i++)for(let j=i+1;j<proposals.length;j++){
    const a=proposals[i].selection,b=proposals[j].selection;
    invariant(a.blockId!==b.blockId||(a.end<b.start||b.end<a.start),"Bundle proposals overlap");
  }
  // Within a block, apply from the end so earlier offsets stay valid.
  const ordered=[...proposals].sort((x,y)=>x.selection.blockId===y.selection.blockId?
    y.selection.start-x.selection.start:x.selection.blockId<y.selection.blockId?-1:1);
  let next=doc;
  for(const proposal of ordered)next=replaceSelectedText(next,proposal.selection,proposal.replacement);
  return validateLegalDocument({...structuredClone(next),revision:doc.revision+1});
}
