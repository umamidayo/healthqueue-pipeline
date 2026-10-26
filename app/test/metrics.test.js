import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Counter, Histogram, LATENCY_BUCKETS, Registry } from '../src/metrics.js';

describe('metrics', () => {
  it('renders counters with escaped labels', () => {
    const r = new Registry();
    const c = r.register(new Counter('x_total', 'help'));
    c.inc({ route: '/a"b' });
    c.inc({ route: '/a"b' }, 2);
    assert.match(r.render(), /x_total\{route="\/a\\"b"\} 3/);
  });

  it('refuses to decrement a counter', () => {
    assert.throws(() => new Counter('x', 'h').inc({}, -1), RangeError);
  });

  it('renders cumulative histogram buckets', () => {
    const r = new Registry();
    const h = r.register(new Histogram('lat_seconds', 'help', [0.1, 0.3, 1]));
    h.observe({ route: '/r' }, 0.05);
    h.observe({ route: '/r' }, 0.2);
    h.observe({ route: '/r' }, 5);
    const out = r.render();
    assert.match(out, /lat_seconds_bucket\{route="\/r",le="0.1"\} 1/);
    assert.match(out, /lat_seconds_bucket\{route="\/r",le="0.3"\} 2/);
    assert.match(out, /lat_seconds_bucket\{route="\/r",le="1"\} 2/);
    assert.match(out, /lat_seconds_bucket\{route="\/r",le="\+Inf"\} 3/);
    assert.match(out, /lat_seconds_count\{route="\/r"\} 3/);
  });

  it('keeps the 300ms bucket the latency SLO depends on', () => {
    assert.ok(LATENCY_BUCKETS.includes(0.3));
  });
});
