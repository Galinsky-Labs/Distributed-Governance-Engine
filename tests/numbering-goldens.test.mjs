// DCE-006 golden labels: alphabetic rollover (z → aa → zz → aaa), Roman limits,
// every federal and corporate level, and explicit failure past a profile.
import test from "node:test";
import assert from "node:assert/strict";
import {legalLabel,FEDERAL_HIERARCHY,NUMBERING_PROFILES} from "../src/numbering.mjs";

test("alphabetic levels roll over like spreadsheet columns",()=>{
  const table=[[1,"(a)"],[26,"(z)"],[27,"(aa)"],[28,"(ab)"],[52,"(az)"],[53,"(ba)"],[702,"(zz)"],[703,"(aaa)"]];
  for(const [n,label] of table)assert.equal(legalLabel(n,1),label,String(n));
  assert.equal(legalLabel(27,3),"(AA)");
});

test("Roman levels are exact to 3999 and refuse larger numbers instead of inventing notation",()=>{
  const table=[[1,"(i)"],[4,"(iv)"],[9,"(ix)"],[14,"(xiv)"],[40,"(xl)"],[90,"(xc)"],[400,"(cd)"],[1994,"(mcmxciv)"],[3999,"(mmmcmxcix)"]];
  for(const [n,label] of table){assert.equal(legalLabel(n,4),label);assert.equal(legalLabel(n,5),label.toUpperCase());}
  assert.throws(()=>legalLabel(4000,4),/3999/);
});

test("federal default follows section, (a), (1), (A), (i), (I); corporate is explicit; depth past a profile fails",()=>{
  assert.deepEqual(FEDERAL_HIERARCHY.map((_,d)=>legalLabel(2,d)),["SEC. 2.","(b)","(2)","(B)","(ii)","(II)"]);
  assert.deepEqual(NUMBERING_PROFILES["corporate-v1"].map((_,d)=>legalLabel(3,d,NUMBERING_PROFILES["corporate-v1"])),["(III)","(C)","(3)","(c)","(iii)","(III)"]);
  assert.throws(()=>legalLabel(1,6),/Invalid legal numbering level/);
  for(const bad of [0,-1,1.5,1000001])assert.throws(()=>legalLabel(bad,0),/Invalid legal numbering index/);
  assert.equal(legalLabel(1000000,2),"(1000000)");
});
