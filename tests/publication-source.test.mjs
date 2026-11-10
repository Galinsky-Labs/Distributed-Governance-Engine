import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyPublicationSource} from '../scripts/verify-publication-source.mjs';
const repository = 'example/quill', sha = 'a'.repeat(40);
const run = overrides => ({head_sha: sha, head_branch: 'main', event: 'push',
  path: '.github/workflows/verify.yml', repository: {full_name: repository},
  status: 'completed', conclusion: 'success', ...overrides});
const options = runs => ({repository, sha, token: 'unit-test-only', attempts: 1,
  request: async () => Response.json({total_count: runs.length, workflow_runs: runs})});
test('publication requires successful verification of the exact main push', async () => {
  assert.deepEqual(await verifyPublicationSource(options([run()])), {verified: true, sha});
  for (const change of [
    {head_sha: 'b'.repeat(40)}, {head_branch: 'another-branch'}, {event: 'pull_request'},
    {path: '.github/workflows/another.yml'}, {repository: {full_name: 'attacker/quill'}},
    {status: 'in_progress', conclusion: null}, {status: 'completed', conclusion: 'skipped'},
    {status: 'completed', conclusion: 'cancelled'}, {status: 'completed', conclusion: 'failure'},
  ]) await assert.rejects(verifyPublicationSource(options([run(change)])));
  await assert.rejects(verifyPublicationSource(options([])));
  await assert.rejects(verifyPublicationSource(options([run(), run({conclusion: 'failure'})])));
});
test('publication waits for an actual completion; missing/truncated/failed API evidence is denied', async () => {
  let calls = 0, waits = 0;
  const config = {...options([]), attempts: 2, wait: async () => {waits++;}, request: async () => {
    calls++; return Response.json({total_count: 1, workflow_runs: [run(calls === 1 ? {status: 'queued', conclusion: null} : {})]});
  }};
  assert.equal((await verifyPublicationSource(config)).verified, true);
  assert.equal(calls, 2); assert.equal(waits, 1);
  for (const response of [Response.json({}, {status: 403}), Response.json({total_count: 2, workflow_runs: [run()]})])
    await assert.rejects(verifyPublicationSource({...options([]), request: async () => response}));
});
