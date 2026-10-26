// Exposes the staging/production release records as GitHub Actions step
// outputs for the promote workflow.
import { appendFileSync, readFileSync } from 'node:fs';

const read = (env) => JSON.parse(readFileSync(`deploy/overlays/${env}/release.json`, 'utf8'));
const staging = read('staging');
const production = read('production');

if (!staging.sourceRevision) {
  console.error('staging has never been promoted; merge a change to main first');
  process.exit(1);
}

const outputs = {
  ref: `${staging.image}@${staging.digest}`,
  source: staging.sourceRevision,
  current: production.sourceRevision ?? '',
  same: String(staging.digest === production.digest),
};
console.log(outputs);
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(outputs).map(([k, v]) => `${k}=${v}\n`).join(''));
}
