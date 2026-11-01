import test from "node:test";
import assert from "node:assert/strict";
import { createLocalWorkingCopy, importLocalWorkingCopy } from "../web/local-drafts.mjs";

test("CivicQuill and CharterQuill local public draft roundtrip", () => {
  for (const product of ["civic", "charter"]) {
    const doc = createLocalWorkingCopy(product, "A New Draft");
    assert.equal(doc.metadata.title, "A New Draft");
    assert.deepEqual(importLocalWorkingCopy(JSON.stringify(doc), product), doc);
    assert.throws(() => importLocalWorkingCopy(JSON.stringify(doc), product === "civic" ? "charter" : "civic"));
  }
});
test("local import rejects private or finalized documents and corrupt input", () => {
  const doc = createLocalWorkingCopy("civic", "A Draft");
  for (const edit of [
    {tenantId:"other-tenant"},
    {lifecycle:"adopted"},
    {mode:"public-input"},
    {id:"another-document"},
  ]) assert.throws(() => importLocalWorkingCopy(JSON.stringify({...doc,...edit}), "civic"));
  assert.throws(() => importLocalWorkingCopy("{broken", "civic"));
  assert.throws(() => importLocalWorkingCopy("x".repeat(3000001), "civic"));
  assert.throws(() => createLocalWorkingCopy("civic", " "));
});
