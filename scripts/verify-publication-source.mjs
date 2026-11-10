import {pathToFileURL} from 'node:url';

// Publication happens only after the existing verification workflow has passed
// on this exact main-branch push. Missing/running/failed evidence cannot publish.
export async function verifyPublicationSource({repository, sha, token, request = fetch,
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)), attempts = 240}) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? '') ||
      !/^[a-f0-9]{40}$/.test(sha ?? '') || !token || !Number.isInteger(attempts) || attempts < 1 || attempts > 240)
    throw Error('Valid repository, exact source SHA and scoped token required');
  const url = `https://api.github.com/repos/${repository}/actions/workflows/verify.yml/runs?event=push&head_sha=${sha}&per_page=100`;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const response = await request(url, {redirect: 'error', headers: {
      authorization: 'Bearer ' + token, accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
    }});
    if (!response.ok) throw Error('Could not verify source workflow');
    const data = await response.json();
    if (!Array.isArray(data.workflow_runs) || !Number.isSafeInteger(data.total_count) ||
        data.total_count !== data.workflow_runs.length || data.total_count > 100)
      throw Error('Incomplete source workflow evidence');
    const runs = data.workflow_runs.filter(run => run.head_sha === sha && run.head_branch === 'main' &&
      run.event === 'push' && run.path === '.github/workflows/verify.yml' && run.repository?.full_name === repository);
    if (runs.some(run => run.status === 'completed' && run.conclusion !== 'success'))
      throw Error('Source verification did not pass');
    if (runs.length && runs.every(run => run.status === 'completed' && run.conclusion === 'success'))
      return {verified: true, sha};
    if (attempt + 1 < attempts) await wait(4000);
  }
  throw Error('No completed successful exact-source verification');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await verifyPublicationSource({repository: process.env.GITHUB_REPOSITORY,
      sha: process.env.GITHUB_SHA, token: process.env.GITHUB_TOKEN});
    console.log('Verified main-branch source: ' + result.sha);
  } catch (error) {console.error(error.message); process.exitCode = 1;}
}
