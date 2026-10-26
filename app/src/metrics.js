// Minimal Prometheus text-format (v0.0.4) instrumentation.
//
// Hand-rolled instead of depending on prom-client so the runtime image has
// zero third-party packages (docs/adr/0011-stateless-zero-dependency-workload.md).
// Only the features the SLOs need are implemented: counters, gauges and
// cumulative histograms with fixed label sets.

function escapeLabel(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

function labelKey(labels) {
  return JSON.stringify(Object.keys(labels).sort().map((k) => [k, String(labels[k])]));
}

function formatLabels(labels) {
  const entries = Object.entries(labels);
  if (entries.length === 0) return '';
  return `{${entries.map(([k, v]) => `${k}="${escapeLabel(v)}"`).join(',')}}`;
}

function formatNumber(n) {
  if (n === Infinity) return '+Inf';
  if (n === -Infinity) return '-Inf';
  return String(n);
}

class Metric {
  constructor(type, name, help) {
    this.type = type;
    this.name = name;
    this.help = help;
    this.series = new Map();
  }

  header() {
    return [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} ${this.type}`];
  }
}

export class Counter extends Metric {
  constructor(name, help) {
    super('counter', name, help);
  }

  inc(labels = {}, value = 1) {
    if (value < 0) throw new RangeError('counters can only increase');
    const key = labelKey(labels);
    const current = this.series.get(key);
    this.series.set(key, { labels, value: (current?.value ?? 0) + value });
  }

  render() {
    const lines = this.header();
    for (const { labels, value } of this.series.values()) {
      lines.push(`${this.name}${formatLabels(labels)} ${formatNumber(value)}`);
    }
    return lines;
  }
}

export class Gauge extends Metric {
  constructor(name, help, collect) {
    super('gauge', name, help);
    this.collect = collect;
  }

  set(labels, value) {
    this.series.set(labelKey(labels), { labels, value });
  }

  render() {
    if (this.collect) this.collect(this);
    const lines = this.header();
    for (const { labels, value } of this.series.values()) {
      lines.push(`${this.name}${formatLabels(labels)} ${formatNumber(value)}`);
    }
    return lines;
  }
}

export class Histogram extends Metric {
  constructor(name, help, buckets) {
    super('histogram', name, help);
    this.buckets = [...buckets].sort((a, b) => a - b);
  }

  observe(labels, value) {
    const key = labelKey(labels);
    let s = this.series.get(key);
    if (!s) {
      s = { labels, counts: new Array(this.buckets.length).fill(0), sum: 0, count: 0 };
      this.series.set(key, s);
    }
    for (let i = 0; i < this.buckets.length; i += 1) {
      if (value <= this.buckets[i]) s.counts[i] += 1;
    }
    s.sum += value;
    s.count += 1;
  }

  render() {
    const lines = this.header();
    for (const { labels, counts, sum, count } of this.series.values()) {
      this.buckets.forEach((le, i) => {
        lines.push(`${this.name}_bucket${formatLabels({ ...labels, le: formatNumber(le) })} ${counts[i]}`);
      });
      lines.push(`${this.name}_bucket${formatLabels({ ...labels, le: '+Inf' })} ${count}`);
      lines.push(`${this.name}_sum${formatLabels(labels)} ${sum}`);
      lines.push(`${this.name}_count${formatLabels(labels)} ${count}`);
    }
    return lines;
  }
}

export class Registry {
  constructor() {
    this.metrics = [];
  }

  register(metric) {
    this.metrics.push(metric);
    return metric;
  }

  render() {
    return `${this.metrics.flatMap((m) => m.render()).join('\n')}\n`;
  }
}

// The 0.3s bucket is load-bearing: the latency SLI is "requests served in
// <= 300ms" (docs/observability.md). Do not remove it without updating the SLO.
export const LATENCY_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.3, 0.5, 1, 2.5, 5];

export function createMetrics({ version, revision }) {
  const registry = new Registry();
  const startTime = Math.floor(Date.now() / 1000);

  const httpRequests = registry.register(
    new Counter('http_requests_total', 'HTTP requests processed, by route template and status code.'),
  );
  const httpDuration = registry.register(
    new Histogram('http_request_duration_seconds', 'HTTP request latency in seconds.', LATENCY_BUCKETS),
  );
  const estimates = registry.register(
    new Counter('healthqueue_estimates_total', 'Wait-time estimates produced, by priority band.'),
  );
  registry.register(
    new Gauge('healthqueue_build_info', 'Build metadata; always 1.', (g) =>
      g.set({ version, revision }, 1),
    ),
  );
  registry.register(
    new Gauge('process_start_time_seconds', 'Start time of the process since unix epoch in seconds.', (g) =>
      g.set({}, startTime),
    ),
  );
  registry.register(
    new Gauge('process_resident_memory_bytes', 'Resident memory size in bytes.', (g) =>
      g.set({}, process.memoryUsage().rss),
    ),
  );

  return { registry, httpRequests, httpDuration, estimates };
}
