import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { buildRelease, setImageDigest } from '../promote.mjs';

const D1 = `sha256:${'a'.repeat(64)}`;
const D2 = `sha256:${'b'.repeat(64)}`;
const SHA = 'c'.repeat(40);
const sample = `images:
  - name: healthqueue-api
    newName: ghcr.io/umamidayo/healthqueue-api
    digest: ${D1}
`;

describe('setImageDigest', () => {
  it('replaces only the digest', () => {
    const out = setImageDigest(`kind: Kustomization\n${sample}`, { digest: D2 });
    assert.match(out, new RegExp(`digest: ${D2}`));
    assert.doesNotMatch(out, new RegExp(D1));
    assert.match(out, /newName: ghcr.io\/umamidayo\/healthqueue-api/);
  });

  it('can retarget the image name', () => {
    const out = setImageDigest(`x\n${sample}`, { newName: 'ghcr.io/fork/healthqueue-api', digest: D2 });
    assert.match(out, /newName: ghcr.io\/fork\/healthqueue-api/);
  });

  it('refuses to edit an unexpected structure', () => {
    assert.throws(() => setImageDigest('images:\n  - name: other\n', { digest: D2 }), /refusing to edit/);
  });

  it('rejects malformed digests', () => {
    assert.throws(() => setImageDigest(sample, { digest: 'sha256:xyz' }), /invalid digest/);
  });

  it('works on the real staging and production overlays', () => {
    for (const env of ['staging', 'production']) {
      const text = readFileSync(new URL(`../../deploy/overlays/${env}/kustomization.yaml`, import.meta.url), 'utf8');
      assert.match(setImageDigest(text, { digest: D2 }), new RegExp(D2));
    }
  });
});

describe('buildRelease', () => {
  it('records provenance for lead-time measurement', () => {
    const r = buildRelease({
      environment: 'production',
      image: 'ghcr.io/umamidayo/healthqueue-api',
      digest: D1,
      sourceRevision: SHA,
      promotedAt: '2026-10-01T00:00:00.000Z',
      promotedFrom: 'staging',
    });
    assert.equal(r.sourceRevision, SHA);
    assert.equal(r.promotedFrom, 'staging');
  });

  it('validates inputs', () => {
    const base = { environment: 'staging', image: 'i', digest: D1, sourceRevision: SHA, promotedAt: 'x' };
    assert.throws(() => buildRelease({ ...base, environment: 'local' }), /unknown environment/);
    assert.throws(() => buildRelease({ ...base, sourceRevision: 'abc' }), /invalid source revision/);
    assert.throws(() => buildRelease({ ...base, digest: 'nope' }), /invalid digest/);
  });
});
