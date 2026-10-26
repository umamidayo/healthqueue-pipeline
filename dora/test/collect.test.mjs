import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { collect } from '../src/collect.mjs';
import { createGitHubClient } from '../src/github.mjs';

const SRC_OLD = '1'.repeat(40);
const SRC_NEW = '2'.repeat(40);
const release = (sourceRevision) => ({ content: Buffer.from(JSON.stringify({ sourceRevision })).toString('base64') });

/** Minimal fake of the GitHub REST endpoints the collector touches. */
function fakeGitHub(routes) {
  const calls = [];
  const fetchImpl = async (url) => {
    const u = new URL(url);
    const key = `${u.pathname}${u.search}`;
    calls.push(key);
    const match = Object.entries(routes).find(([pattern]) => key.startsWith(pattern));
    const body = match ? match[1] : undefined;
    const status = body === undefined ? 404 : 200;
    return new Response(status === 200 ? JSON.stringify(body) : 'not found', { status, headers: { 'content-type': 'application/json' } });
  };
  return { fetchImpl, calls };
}

const base = '/repos/o/r';
const routes = {
  [`${base}/deployments?environment=production`]: [
    { id: 2, sha: 'gitops-new' },
    { id: 1, sha: 'gitops-old' },
  ],
  [`${base}/deployments/2/statuses`]: [
    { state: 'inactive', created_at: '2026-10-20T12:00:00Z' },
    { state: 'success', created_at: '2026-10-10T12:00:00Z' },
  ],
  [`${base}/deployments/1/statuses`]: [{ state: 'success', created_at: '2026-09-01T12:00:00Z' }],
  [`${base}/contents/deploy/overlays/production/release.json?ref=gitops-new`]: release(SRC_NEW),
  [`${base}/contents/deploy/overlays/production/release.json?ref=gitops-old`]: release(SRC_OLD),
  [`${base}/compare/${SRC_OLD}...${SRC_NEW}`]: {
    total_commits: 3,
    commits: [
      { sha: 'h1', author: { login: 'dev', type: 'User' }, committer: { login: 'web-flow', type: 'User' }, commit: { message: 'feat: x', author: { date: '2026-10-09T12:00:00Z' } } },
      { sha: 'h2', author: { login: 'dev', type: 'User' }, committer: { login: 'dev', type: 'User' }, commit: { message: 'hotfix: y', author: { date: '2026-10-10T06:00:00Z' } } },
      { sha: 'b1', author: { login: 'healthqueue-bot[bot]', type: 'Bot' }, committer: null, commit: { message: 'chore(deploy): promote [skip ci]', author: { date: '2026-10-10T07:00:00Z' } } },
    ],
  },
  [`${base}/commits?path=deploy/overlays/staging/release.json`]: [
    { sha: 's1', commit: { message: `chore(deploy): promote 222222222222 to staging [skip ci]\n\nSource-Revision: ${SRC_NEW}`, committer: { date: '2026-10-09T13:00:00Z' } } },
  ],
  [`${base}/issues?labels=incident`]: [
    { number: 9, created_at: '2026-10-10T15:00:00Z', closed_at: '2026-10-10T16:00:00Z', body: 'Deployment: 2\nSymptoms...', labels: [{ name: 'sev2' }] },
    { number: 10, pull_request: {}, created_at: '2026-10-10T15:00:00Z' },
  ],
  [`${base}/actions/runs`]: {
    workflow_runs: [
      { id: 1, path: '.github/workflows/ci.yml', name: 'CI', event: 'push', status: 'completed', conclusion: 'success', run_attempt: 2, run_started_at: '2026-10-09T12:30:00Z', updated_at: '2026-10-09T12:45:00Z', head_sha: SRC_NEW },
      { id: 2, path: '.github/workflows/ci.yml', name: 'CI', event: 'push', status: 'in_progress' },
    ],
  },
  [`${base}/pulls?state=closed`]: [
    { number: 5, user: { login: 'dev', type: 'User' }, created_at: '2026-10-08T10:00:00Z', updated_at: '2026-10-09T12:00:00Z', merged_at: '2026-10-09T12:00:00Z' },
    { number: 4, user: { login: 'dev', type: 'User' }, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z', merged_at: '2026-01-02T00:00:00Z' },
  ],
  [`${base}/pulls/5/reviews`]: [
    { user: { login: 'dev' }, submitted_at: '2026-10-08T10:30:00Z' },
    { user: { login: 'reviewer' }, submitted_at: '2026-10-08T14:00:00Z' },
  ],
};

describe('collect (GitHub)', () => {
  it('normalizes GitHub Deployments (opt-in), changes, incidents, runs and reviews', async () => {
    const { fetchImpl } = fakeGitHub(routes);
    const client = createGitHubClient({ fetchImpl });
    const ds = await collect({ client, repo: 'o/r', days: 30, now: new Date('2026-10-25T00:00:00Z'), deploymentSource: 'deployments' });

    const prod = ds.deployments.filter((d) => d.environment === 'production');
    assert.equal(prod.length, 1, 'baseline deployment outside the window is not reported');
    assert.equal(prod[0].deployedAt, '2026-10-10T12:00:00Z', 'uses the success status, not the later inactive one');
    assert.equal(prod[0].sourceRevision, SRC_NEW);
    assert.equal(prod[0].rework, true);
    assert.deepEqual(prod[0].changes.map((c) => [c.sha, c.bot]), [['h1', false], ['h2', false], ['b1', true]]);

    const staging = ds.deployments.filter((d) => d.environment === 'staging');
    assert.deepEqual(staging.map((d) => d.sourceRevision), [SRC_NEW]);

    assert.deepEqual(ds.incidents, [{ id: '#9', openedAt: '2026-10-10T15:00:00Z', resolvedAt: '2026-10-10T16:00:00Z', severity: 'sev2', deploymentId: '2' }]);
    assert.equal(ds.pipelineRuns.length, 1);
    assert.equal(ds.pipelineRuns[0].workflow, 'ci');
    assert.equal(ds.pipelineRuns[0].attempt, 2);
    assert.deepEqual(ds.pullRequests, [{ number: 5, createdAt: '2026-10-08T10:00:00Z', firstReviewAt: '2026-10-08T14:00:00Z', mergedAt: '2026-10-09T12:00:00Z', bot: false }]);
  });

  it('uses promotion commits by default, reading the Source-Revision trailer', async () => {
    const { fetchImpl, calls } = fakeGitHub({
      // GitHub Deployments exist (created by the promote job's environment) but
      // must be ignored in the default mode: they point at the pre-promotion commit.
      [`${base}/deployments?environment=production`]: [{ id: 99, sha: 'wrong' }],
      [`${base}/commits?path=deploy/overlays/production/release.json`]: [
        // In-window commit that only created/edited the placeholder file.
        { sha: 'm4', commit: { message: 'initial commit', committer: { date: '2026-10-20T00:00:00Z' } } },
        { sha: 'm3', commit: { message: `chore(deploy): promote 2222 to production [skip ci]

Source-Revision: ${SRC_NEW}`, committer: { date: '2026-10-12T00:00:00Z' } } },
        { sha: 'm2', commit: { message: 'older promotion without trailer', committer: { date: '2026-09-01T00:00:00Z' } } },
        { sha: 'm1', commit: { message: 'even older', committer: { date: '2026-08-01T00:00:00Z' } } },
      ],
      [`${base}/contents/deploy/overlays/production/release.json?ref=m2`]: release(SRC_OLD),
      [`${base}/contents/deploy/overlays/production/release.json?ref=m4`]: release(null),
      [`${base}/compare/${SRC_OLD}...${SRC_NEW}`]: { total_commits: 0, commits: [] },
      [`${base}/commits?path=deploy/overlays/staging`]: [],
      [`${base}/issues`]: [],
      [`${base}/actions/runs`]: { workflow_runs: [] },
      [`${base}/pulls?`]: [],
    });
    const ds = await collect({ client: createGitHubClient({ fetchImpl }), repo: 'o/r', days: 30, now: new Date('2026-10-25T00:00:00Z') });
    assert.deepEqual(ds.deployments.map((d) => [d.id, d.sourceRevision]), [['m3', SRC_NEW]], 'placeholder m4 is not a deployment');
    assert.match(ds.notes.join(' '), /1 change\(s\) .* not counted/);
    assert.ok(!calls.some((c) => c.includes('/deployments')), 'GitHub Deployments are not read in commits mode');
    assert.ok(!calls.some((c) => c.includes('ref=m3')), 'trailer avoids a contents API call');
    assert.ok(calls.some((c) => c.includes(`/compare/${SRC_OLD}...${SRC_NEW}`)), 'baseline from the newest pre-window promotion');
    assert.ok(!calls.some((c) => c.includes('ref=m1')), 'stops at the first pre-window promotion');
  });

  it('rejects unknown deployment sources', async () => {
    const { fetchImpl } = fakeGitHub(routes);
    await assert.rejects(collect({ client: createGitHubClient({ fetchImpl }), repo: 'o/r', days: 30, deploymentSource: 'argo' }), /deployment-source/);
  });

  it('enforces the request budget', async () => {
    const { fetchImpl } = fakeGitHub(routes);
    const client = createGitHubClient({ fetchImpl, maxRequests: 3 });
    await assert.rejects(collect({ client, repo: 'o/r', days: 30, now: new Date('2026-10-25T00:00:00Z') }), /budget/);
  });

  it('refuses windows over 90 days before making any request', async () => {
    const { fetchImpl, calls } = fakeGitHub(routes);
    await assert.rejects(collect({ client: createGitHubClient({ fetchImpl }), repo: 'o/r', days: 91 }), /capped at 90/);
    assert.equal(calls.length, 0);
  });
});
