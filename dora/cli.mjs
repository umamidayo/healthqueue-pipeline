#!/usr/bin/env node
// DORA metrics + toil analysis for this pipeline.
//
//   node dora/cli.mjs collect --repo owner/name [--days 90] [--out dora-out]
//   node dora/cli.mjs report  --input dora-out/dataset.json [--out dora-out]
//   node dora/cli.mjs sample  [--days 90] [--seed 42] [--end 2026-10-25] [--out dora-out]
//
// Common options:
//   --costs <file.json>   override the toil cost model (see src/toil.mjs)
//   --summary             also append the markdown to $GITHUB_STEP_SUMMARY
//
// Outputs: dataset.json (raw normalized events), metrics.json, report.md.
// `collect` reads GITHUB_TOKEN from the environment.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { collectSafely } from './src/collect.mjs';
import { validateDataset } from './src/dataset.mjs';
import { createGitHubClient } from './src/github.mjs';
import { computeMetrics } from './src/metrics.mjs';
import { renderMarkdown } from './src/report.mjs';
import { generateSample } from './src/sample.mjs';
import { DEFAULT_COSTS, analyzeToil } from './src/toil.mjs';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    repo: { type: 'string' },
    days: { type: 'string', default: '90' },
    out: { type: 'string', default: 'dora-out' },
    input: { type: 'string' },
    seed: { type: 'string', default: '42' },
    end: { type: 'string' },
    costs: { type: 'string' },
    'max-requests': { type: 'string', default: '800' },
    'attribution-hours': { type: 'string', default: '24' },
    summary: { type: 'boolean', default: false },
  },
});

function analyze(dataset) {
  validateDataset(dataset);
  const costs = values.costs ? { ...DEFAULT_COSTS, ...JSON.parse(readFileSync(values.costs, 'utf8')) } : DEFAULT_COSTS;
  const metrics = computeMetrics(dataset, { attributionHours: Number(values['attribution-hours']) });
  const toil = analyzeToil(dataset, metrics, { costs });
  const markdown = renderMarkdown({ dataset, metrics, toil });

  mkdirSync(values.out, { recursive: true });
  writeFileSync(join(values.out, 'dataset.json'), `${JSON.stringify(dataset, null, 2)}\n`);
  writeFileSync(join(values.out, 'metrics.json'), `${JSON.stringify({ metrics, toil }, null, 2)}\n`);
  writeFileSync(join(values.out, 'report.md'), markdown);
  if (values.summary && process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);

  const o = metrics.overall;
  console.log(
    [
      `window ${dataset.window.days}d | deploys ${o.deploymentFrequency.deployments} (${o.deploymentFrequency.perWeek.toFixed(1)}/wk)`,
      `lead p50 ${o.leadTime.p50Hours?.toFixed(1) ?? 'n/a'}h | CFR ${o.changeFailRate.rate === null ? 'n/a' : (o.changeFailRate.rate * 100).toFixed(1) + '%'}`,
      `recovery p50 ${o.recoveryTime.p50Hours?.toFixed(1) ?? 'n/a'}h | ${toil.recommendations.length} recommendations`,
      `wrote ${join(values.out, 'report.md')}`,
    ].join('\n'),
  );
}

async function main() {
  const command = positionals[0];
  if (command === 'collect') {
    const repo = values.repo ?? process.env.GITHUB_REPOSITORY;
    if (!repo) throw new Error('--repo owner/name is required (or set GITHUB_REPOSITORY)');
    const client = createGitHubClient({ token: process.env.GITHUB_TOKEN, maxRequests: Number(values['max-requests']) });
    const dataset = await collectSafely({ client, repo, days: values.days });
    console.log(`GitHub API requests used: ${client.used()}/${client.maxRequests}`);
    analyze(dataset);
  } else if (command === 'report') {
    if (!values.input) throw new Error('--input <dataset.json> is required');
    analyze(JSON.parse(readFileSync(values.input, 'utf8')));
  } else if (command === 'sample') {
    analyze(generateSample({ days: values.days, seed: Number(values.seed), end: values.end ? new Date(values.end) : new Date() }));
  } else {
    console.error('usage: cli.mjs <collect|report|sample> [options]  (see header of dora/cli.mjs)');
    process.exit(2);
  }
}

main().catch((err) => {
  console.error(`dora: ${err.message}`);
  process.exit(1);
});
