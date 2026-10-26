import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createApp, loadConfig } from '../src/server.js';

function listen(config) {
  const app = createApp({ ...loadConfig({}), logLevel: 'error', ...config });
  return new Promise((resolve) => {
    app.server.listen(0, '127.0.0.1', () => {
      const { port } = app.server.address();
      resolve({ app, base: `http://127.0.0.1:${port}` });
    });
  });
}

const post = (url, body, headers = {}) =>
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

describe('http server', () => {
  let ctx;
  before(async () => {
    ctx = await listen({ version: '1.2.3', revision: 'abc123' });
  });
  after(() => ctx.app.server.close());

  it('serves liveness and readiness', async () => {
    assert.equal((await fetch(`${ctx.base}/healthz`)).status, 200);
    assert.equal((await fetch(`${ctx.base}/readyz`)).status, 200);
  });

  it('fails readiness while draining', async () => {
    ctx.app.state.ready = false;
    try {
      assert.equal((await fetch(`${ctx.base}/readyz`)).status, 503);
    } finally {
      ctx.app.state.ready = true;
    }
  });

  it('reports the build it is running', async () => {
    const body = await (await fetch(`${ctx.base}/version`)).json();
    assert.deepEqual(body, { version: '1.2.3', revision: 'abc123' });
  });

  it('estimates a wait', async () => {
    const res = await post(`${ctx.base}/api/v1/estimate`, { acuity: 2, patientsAhead: 3, cliniciansOnShift: 3 });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.estimatedWaitMinutes, 15);
    assert.equal(body.breachesTarget, true);
  });

  it('lists acuity levels', async () => {
    const body = await (await fetch(`${ctx.base}/api/v1/acuity-levels`)).json();
    assert.equal(Object.keys(body.levels).length, 5);
  });

  it('returns 400 with field errors for invalid input', async () => {
    const res = await post(`${ctx.base}/api/v1/estimate`, { acuity: 0 });
    assert.equal(res.status, 400);
    assert.ok((await res.json()).fields.length >= 1);
  });

  it('returns 400 for malformed JSON', async () => {
    assert.equal((await post(`${ctx.base}/api/v1/estimate`, '{nope')).status, 400);
  });

  it('returns 415 for non-JSON bodies', async () => {
    const res = await fetch(`${ctx.base}/api/v1/estimate`, { method: 'POST', body: 'x' });
    assert.equal(res.status, 415);
  });

  it('returns 413 for oversized bodies', async () => {
    const res = await post(`${ctx.base}/api/v1/estimate`, JSON.stringify({ pad: 'x'.repeat(20_000) }));
    assert.equal(res.status, 413);
  });

  it('distinguishes 404 from 405', async () => {
    assert.equal((await fetch(`${ctx.base}/nope`)).status, 404);
    assert.equal((await fetch(`${ctx.base}/api/v1/estimate`)).status, 405);
  });

  it('ignores chaos headers unless chaos is enabled', async () => {
    const res = await post(
      `${ctx.base}/api/v1/estimate`,
      { acuity: 3, patientsAhead: 0, cliniciansOnShift: 1 },
      { 'x-chaos': 'error' },
    );
    assert.equal(res.status, 200);
  });

  it('exposes SLI metrics with bounded route labels', async () => {
    await fetch(`${ctx.base}/some/random/path/123`);
    const text = await (await fetch(`${ctx.base}/metrics`)).text();
    assert.match(text, /http_requests_total\{method="POST",route="\/api\/v1\/estimate",code="200"\} \d+/);
    assert.match(text, /http_request_duration_seconds_bucket\{method="POST",route="\/api\/v1\/estimate",le="0.3"\}/);
    assert.match(text, /route="unmatched"/);
    assert.doesNotMatch(text, /random/);
    assert.match(text, /healthqueue_build_info\{version="1.2.3",revision="abc123"\} 1/);
  });
});

describe('chaos mode', () => {
  let ctx;
  before(async () => {
    ctx = await listen({ chaosEnabled: true });
  });
  after(() => ctx.app.server.close());

  it('injects failures on API routes when asked', async () => {
    const res = await post(
      `${ctx.base}/api/v1/estimate`,
      { acuity: 3, patientsAhead: 0, cliniciansOnShift: 1 },
      { 'x-chaos': 'error' },
    );
    assert.equal(res.status, 503);
  });

  it('never injects failures on health endpoints', async () => {
    const res = await fetch(`${ctx.base}/healthz`, { headers: { 'x-chaos': 'error' } });
    assert.equal(res.status, 200);
  });
});
