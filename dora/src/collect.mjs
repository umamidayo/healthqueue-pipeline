// Builds a normalized dataset (dataset.mjs) from GitHub for one repository.
//
// Data sources, chosen so that the pipeline itself produces every event and
// nothing needs to be logged by hand (docs/adr/0009-dora-measurement.md):
//   production deploys  GitHub Deployments written by Argo CD Notifications
//                       (fallback: commits to deploy/overlays/production/release.json)
//   source revision     release.json at the deployed commit
//   changes             compare API between consecutive source revisions
//   staging deploys     commits to deploy/overlays/staging/release.json
//                       (each carries a "Source-Revision:" trailer)
//   incidents           issues labelled "incident" (optional "Deployment: <id|sha>" line)
//   pipeline runs       Actions workflow runs
//   review latency      pull requests + their first review
import { SCHEMA_VERSION, clampWindowDays } from './dataset.mjs';
import { RequestBudgetExceeded } from './github.mjs';
import { DAY_MS } from './stats.mjs';

const RELEASE_PATH = (env) => `deploy/overlays/${env}/release.json`;
const REWORK_RE = /^(revert\b|hotfix\b|fix\(hotfix\))|\bhotfix:/i;

export const isBot = (user) => Boolean(user) && (user.type === 'Bot' || /\[bot\]$/.test(user.login ?? ''));

export async function collect({ client, repo, days = 90, now = new Date(), workflowFile = 'ci.yml', maxPullRequests = 300 }) {
  days = clampWindowDays(days);
  const [owner, name] = repo.split('/');
  if (!owner || !name) throw new Error('--repo must be owner/name');
  const base = `/repos/${owner}/${name}`;
  const end = new Date(now);
  const start = new Date(end.getTime() - days * DAY_MS);
  const notes = [];
  const inWindow = (t) => new Date(t) >= start && new Date(t) <= end;

  const releaseCache = new Map();
  async function sourceRevisionAt(env, ref) {
    const key = `${env}@${ref}`;
    if (!releaseCache.has(key)) {
      const { data } = await client.request(`${base}/contents/${RELEASE_PATH(env)}?ref=${ref}`);
      let rev = null;
      if (data?.content) {
        try {
          rev = JSON.parse(Buffer.from(data.content, 'base64').toString('utf8')).sourceRevision ?? null;
        } catch {
          rev = null;
        }
      }
      releaseCache.set(key, rev);
    }
    return releaseCache.get(key);
  }

  // --- production deployments ---------------------------------------------
  // Collect one deployment older than the window as the lead-time baseline.
  const prod = [];
  let baseline = null;
  for await (const d of client.paginate(`${base}/deployments?environment=production&per_page=100`)) {
    const { data: statuses } = await client.request(`${base}/deployments/${d.id}/statuses?per_page=100`);
    const success = (statuses ?? []).filter((s) => s.state === 'success').at(-1); // oldest success
    const failure = (statuses ?? []).find((s) => s.state === 'failure' || s.state === 'error');
    const status = success ? 'success' : failure ? 'failure' : null;
    if (!status) continue; // still pending / queued
    const deployedAt = (success ?? failure).created_at;
    const entry = { id: String(d.id), environment: 'production', deployedAt, status, ref: d.sha };
    if (new Date(deployedAt) < start) {
      if (status === 'success') {
        baseline = entry;
        break;
      }
      continue;
    }
    prod.push(entry);
  }

  if (prod.length === 0) {
    notes.push('No GitHub Deployments found for "production"; fell back to commits that changed the production release.json (deploy time = merge time).');
    const since = new Date(start.getTime() - 30 * DAY_MS).toISOString();
    for await (const c of client.paginate(`${base}/commits?path=${RELEASE_PATH('production')}&since=${since}&per_page=100`)) {
      const entry = { id: c.sha, environment: 'production', deployedAt: c.commit.committer.date, status: 'success', ref: c.sha };
      if (inWindow(entry.deployedAt)) prod.push(entry);
      else if (!baseline) baseline = entry;
    }
  }

  // Dedupe re-notifications of the same Git revision (Argo CD sends one per
  // revision, but a manual re-sync can create a second record).
  const seenRefs = new Set();
  const prodSorted = prod
    .sort((a, b) => new Date(a.deployedAt) - new Date(b.deployedAt))
    .filter((d) => {
      const k = `${d.ref}:${d.status}`;
      if (seenRefs.has(k)) return false;
      seenRefs.add(k);
      return true;
    });

  for (const d of [baseline, ...prodSorted].filter(Boolean)) {
    d.sourceRevision = (await sourceRevisionAt('production', d.ref)) ?? d.ref;
  }
  if (!baseline) notes.push('No production deployment older than the window was found; the first deployment in the window has no lead-time baseline.');

  // --- changes per deployment ---------------------------------------------
  let prev = baseline;
  for (const d of prodSorted) {
    d.changes = [];
    d.rework = false;
    if (d.status === 'success' && prev && prev.sourceRevision !== d.sourceRevision) {
      const { data } = await client.request(`${base}/compare/${prev.sourceRevision}...${d.sourceRevision}`);
      for (const c of data?.commits ?? []) {
        const bot = isBot(c.author) || isBot(c.committer) || /\[skip ci\]/.test(c.commit.message);
        d.changes.push({ sha: c.sha, authoredAt: c.commit.author.date, bot });
        if (!bot && REWORK_RE.test(c.commit.message)) d.rework = true;
      }
      if ((data?.total_commits ?? 0) > (data?.commits?.length ?? 0)) {
        notes.push(`Deployment ${d.id}: compare API truncated at ${data.commits.length} of ${data.total_commits} commits.`);
      }
    }
    if (d.status === 'success') prev = d;
  }

  // --- staging deployments (cheap: one call per 100 promotions) -----------
  const staging = [];
  for await (const c of client.paginate(`${base}/commits?path=${RELEASE_PATH('staging')}&since=${start.toISOString()}&per_page=100`)) {
    const m = /^Source-Revision:\s*([0-9a-f]{40})\s*$/m.exec(c.commit.message);
    if (m) {
      staging.push({ id: c.sha, environment: 'staging', deployedAt: c.commit.committer.date, status: 'success', sourceRevision: m[1], rework: false, changes: [] });
    }
  }

  // --- incidents ------------------------------------------------------------
  const incidents = [];
  for await (const i of client.paginate(`${base}/issues?labels=incident&state=all&since=${start.toISOString()}&per_page=100`)) {
    if (i.pull_request || !inWindow(i.created_at)) continue;
    const ref = /^Deployment:\s*(\S+)/im.exec(i.body ?? '')?.[1] ?? null;
    const match = ref && prodSorted.find((d) => d.id === ref || d.ref.startsWith(ref) || d.sourceRevision?.startsWith(ref));
    incidents.push({
      id: `#${i.number}`,
      openedAt: i.created_at,
      resolvedAt: i.closed_at,
      severity: (i.labels ?? []).map((l) => l.name).find((n) => /^sev\d$/.test(n)) ?? null,
      deploymentId: match ? match.id : null,
    });
  }

  // --- pipeline runs ----------------------------------------------------------
  const pipelineRuns = [];
  const runsPath = `${base}/actions/runs?created=>=${start.toISOString().slice(0, 10)}&per_page=100&exclude_pull_requests=true`;
  for await (const r of client.paginate(runsPath, { pick: (d) => d.workflow_runs, maxPages: 25 })) {
    if (r.status !== 'completed') continue;
    pipelineRuns.push({
      id: r.id,
      workflow: r.path?.endsWith(`/${workflowFile}`) ? 'ci' : r.name,
      event: r.event,
      startedAt: r.run_started_at ?? r.created_at,
      completedAt: r.updated_at,
      conclusion: r.conclusion,
      attempt: r.run_attempt ?? 1,
      sourceRevision: r.event === 'push' ? r.head_sha : null,
    });
  }

  // --- pull requests + first review --------------------------------------------
  const pullRequests = [];
  outer: for await (const p of client.paginate(`${base}/pulls?state=closed&sort=updated&direction=desc&per_page=100`, { maxPages: 10 })) {
    if (new Date(p.updated_at) < start) break outer;
    if (!p.merged_at || !inWindow(p.merged_at)) continue;
    if (pullRequests.length >= maxPullRequests) {
      notes.push(`Review latency sampled from the ${maxPullRequests} most recently updated merged PRs.`);
      break;
    }
    const { data: reviews } = await client.request(`${base}/pulls/${p.number}/reviews?per_page=100`);
    const first = (reviews ?? [])
      .filter((r) => r.user?.login !== p.user?.login && r.submitted_at)
      .map((r) => r.submitted_at)
      .sort()[0];
    pullRequests.push({ number: p.number, createdAt: p.created_at, firstReviewAt: first ?? null, mergedAt: p.merged_at, bot: isBot(p.user) });
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    repo,
    source: 'github',
    generatedAt: end.toISOString(),
    window: { start: start.toISOString(), end: end.toISOString(), days },
    deployments: [
      ...prodSorted.map(({ ref, ...d }) => d),
      ...staging,
    ],
    incidents,
    pipelineRuns,
    pullRequests,
    notes: [...new Set(notes)],
  };
}

export async function collectSafely(opts) {
  try {
    return await collect(opts);
  } catch (err) {
    if (err instanceof RequestBudgetExceeded) {
      throw new Error(`${err.message}. Raise --max-requests or shorten --days; partial data is not reported to avoid misleading metrics.`);
    }
    throw err;
  }
}
