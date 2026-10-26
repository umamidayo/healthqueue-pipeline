#!/usr/bin/env node
// Promotes an image digest into an environment overlay.
//
//   node scripts/promote.mjs --env staging --digest sha256:<64 hex> --source-revision <git sha>
//   node scripts/promote.mjs --env production --from staging
//
// Writes two files in deploy/overlays/<env>/:
//   kustomization.yaml  - the pinned image digest Argo CD deploys
//   release.json        - which source commit that digest was built from, read
//                         by the DORA collector to measure lead time exactly
//
// Kept dependency-free (string edits on a known structure rather than a YAML
// library) so it can run in CI without an install step. The edit is guarded:
// if the expected `images:` entry is not found, it fails instead of guessing.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENVIRONMENTS = ['staging', 'production'];
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const REVISION_RE = /^[0-9a-f]{40}$/;
const IMAGE_NAME = 'healthqueue-api';

export function setImageDigest(kustomization, { newName, digest }) {
  if (!DIGEST_RE.test(digest)) throw new Error(`invalid digest: ${digest}`);
  const block = new RegExp(
    `(\\n  - name: ${IMAGE_NAME}\\n    newName: )([^\\n]+)(\\n    digest: )(sha256:[0-9a-f]{64})`,
  );
  if (!block.test(kustomization)) {
    throw new Error(`could not find the ${IMAGE_NAME} images entry with a digest; refusing to edit`);
  }
  return kustomization.replace(block, (_m, a, name, b) => `${a}${newName ?? name}${b}${digest}`);
}

export function buildRelease({ environment, image, digest, sourceRevision, promotedAt, promotedFrom }) {
  if (!ENVIRONMENTS.includes(environment)) throw new Error(`unknown environment: ${environment}`);
  if (!DIGEST_RE.test(digest)) throw new Error(`invalid digest: ${digest}`);
  if (!REVISION_RE.test(sourceRevision ?? '')) throw new Error(`invalid source revision: ${sourceRevision}`);
  return {
    $comment:
      'Written by scripts/promote.mjs. Not a Kubernetes resource: records which source commit the pinned digest was built from, so DORA lead time can be measured exactly (docs/dora.md).',
    environment,
    image,
    digest,
    sourceRevision,
    promotedAt,
    ...(promotedFrom ? { promotedFrom } : {}),
  };
}

const overlayPath = (env, file) => join(ROOT, 'deploy', 'overlays', env, file);
const readRelease = (env) => JSON.parse(readFileSync(overlayPath(env, 'release.json'), 'utf8'));

export function promote({ env, digest, sourceRevision, from, image, now = new Date() }) {
  let release;
  if (from) {
    if (from === env) throw new Error('--from must differ from --env');
    const source = readRelease(from);
    release = buildRelease({
      environment: env,
      image: source.image,
      digest: source.digest,
      sourceRevision: source.sourceRevision,
      promotedAt: now.toISOString(),
      promotedFrom: from,
    });
  } else {
    const current = readRelease(env);
    release = buildRelease({
      environment: env,
      image: image ?? current.image,
      digest,
      sourceRevision,
      promotedAt: now.toISOString(),
    });
  }

  const kPath = overlayPath(env, 'kustomization.yaml');
  const before = readFileSync(kPath, 'utf8');
  const after = setImageDigest(before, { newName: release.image, digest: release.digest });
  writeFileSync(kPath, after);
  writeFileSync(overlayPath(env, 'release.json'), `${JSON.stringify(release, null, 2)}\n`);
  return { release, changed: before !== after };
}

function main() {
  const { values } = parseArgs({
    options: {
      env: { type: 'string' },
      digest: { type: 'string' },
      'source-revision': { type: 'string' },
      from: { type: 'string' },
      image: { type: 'string' },
    },
  });
  if (!values.env || (!values.from && (!values.digest || !values['source-revision']))) {
    console.error(
      'usage: promote.mjs --env <staging|production> (--digest <sha256:...> --source-revision <sha> | --from <env>)',
    );
    process.exit(2);
  }
  const { release, changed } = promote({
    env: values.env,
    digest: values.digest,
    sourceRevision: values['source-revision'],
    from: values.from,
    image: values.image,
  });
  console.log(`${changed ? 'promoted' : 'unchanged'}: ${release.environment} -> ${release.image}@${release.digest}`);
  console.log(`source revision: ${release.sourceRevision}`);
  // Expose results to GitHub Actions without needing jq.
  if (process.env.GITHUB_OUTPUT) {
    writeFileSync(
      process.env.GITHUB_OUTPUT,
      `changed=${changed}\ndigest=${release.digest}\nsource_revision=${release.sourceRevision}\n`,
      { flag: 'a' },
    );
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    main();
  } catch (err) {
    console.error(`promote failed: ${err.message}`);
    process.exit(1);
  }
}
