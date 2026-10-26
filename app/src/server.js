import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { ACUITY_LEVELS, ValidationError, estimateWait } from './estimator.js';
import { createMetrics } from './metrics.js';

const MAX_BODY_BYTES = 16 * 1024;

export function loadConfig(env = process.env) {
  return {
    port: Number.parseInt(env.PORT ?? '8080', 10),
    version: env.BUILD_VERSION ?? 'dev',
    revision: env.BUILD_REVISION ?? 'unknown',
    logLevel: env.LOG_LEVEL ?? 'info',
    // Chaos hooks let you exercise the SLO burn-rate alerts locally. They are
    // only honoured when explicitly enabled; staging/production never set this.
    chaosEnabled: env.CHAOS_ENABLED === 'true',
    shutdownGraceMs: Number.parseInt(env.SHUTDOWN_GRACE_MS ?? '5000', 10),
  };
}

function createLogger(level) {
  const order = { debug: 10, info: 20, warn: 30, error: 40 };
  const threshold = order[level] ?? order.info;
  const write = (lvl, msg, fields) => {
    if (order[lvl] < threshold) return;
    process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), level: lvl, msg, ...fields })}\n`);
  };
  return {
    debug: (msg, f) => write('debug', msg, f),
    info: (msg, f) => write('info', msg, f),
    warn: (msg, f) => write('warn', msg, f),
    error: (msg, f) => write('error', msg, f),
  };
}

class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(payload);
}

async function readJson(req) {
  const type = req.headers['content-type'] ?? '';
  if (!type.startsWith('application/json')) {
    throw new HttpError(415, 'content-type must be application/json');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'request body too large');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'request body is not valid JSON');
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createApp(config = loadConfig()) {
  const log = createLogger(config.logLevel);
  const metrics = createMetrics({ version: config.version, revision: config.revision });
  const state = { ready: true };

  // Route table keyed by "METHOD path". `route` is the low-cardinality label
  // recorded in metrics; unknown paths collapse to "unmatched".
  const routes = {
    'GET /healthz': { route: '/healthz', handler: (_req, res) => sendJson(res, 200, { status: 'ok' }) },
    'GET /readyz': {
      route: '/readyz',
      handler: (_req, res) =>
        state.ready ? sendJson(res, 200, { status: 'ready' }) : sendJson(res, 503, { status: 'draining' }),
    },
    'GET /metrics': {
      route: '/metrics',
      handler: (_req, res) => {
        const body = metrics.registry.render();
        res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' });
        res.end(body);
      },
    },
    'GET /version': {
      route: '/version',
      handler: (_req, res) => sendJson(res, 200, { version: config.version, revision: config.revision }),
    },
    'GET /api/v1/acuity-levels': {
      route: '/api/v1/acuity-levels',
      handler: (_req, res) => sendJson(res, 200, { levels: ACUITY_LEVELS }),
    },
    'POST /api/v1/estimate': {
      route: '/api/v1/estimate',
      handler: async (req, res) => {
        const body = await readJson(req);
        const result = estimateWait(body);
        metrics.estimates.inc({ priority_band: result.priorityBand });
        sendJson(res, 200, result);
      },
    },
  };

  async function applyChaos(req) {
    if (!config.chaosEnabled) return;
    const mode = req.headers['x-chaos'];
    if (mode === 'error') throw new HttpError(503, 'chaos: injected failure');
    if (mode === 'slow') await sleep(500);
  }

  const server = http.createServer(async (req, res) => {
    const started = process.hrtime.bigint();
    const url = new URL(req.url, 'http://localhost');
    const entry = routes[`${req.method} ${url.pathname}`];
    const route = entry?.route ?? 'unmatched';

    try {
      if (!entry) {
        const pathKnown = Object.keys(routes).some((k) => k.endsWith(` ${url.pathname}`));
        throw new HttpError(pathKnown ? 405 : 404, pathKnown ? 'method not allowed' : 'not found');
      }
      if (route.startsWith('/api/')) await applyChaos(req);
      await entry.handler(req, res);
    } catch (err) {
      if (err instanceof ValidationError) {
        sendJson(res, 400, { error: err.message, fields: err.fields });
      } else if (err instanceof HttpError) {
        sendJson(res, err.status, { error: err.message, ...(err.details ? { details: err.details } : {}) });
      } else {
        log.error('unhandled error', { route, err: err?.stack ?? String(err) });
        if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
      }
    } finally {
      const seconds = Number(process.hrtime.bigint() - started) / 1e9;
      const code = String(res.statusCode);
      metrics.httpRequests.inc({ method: req.method, route, code });
      metrics.httpDuration.observe({ method: req.method, route }, seconds);
      if (route !== '/healthz' && route !== '/readyz' && route !== '/metrics') {
        log.info('request', { method: req.method, route, code: res.statusCode, durationMs: Math.round(seconds * 1000) });
      }
    }
  });

  // Keep-alive must outlive the load balancer's idle timeout to avoid races
  // where the LB reuses a socket the server is closing.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  server.requestTimeout = 30_000;

  return { server, state, log, metrics };
}

export function start(config = loadConfig()) {
  const app = createApp(config);
  const { server, state, log } = app;

  server.listen(config.port, () => {
    log.info('listening', { port: config.port, version: config.version, revision: config.revision });
  });

  // Graceful shutdown: fail readiness first so the Service stops routing new
  // traffic, wait for endpoints to converge, then drain in-flight requests.
  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    state.ready = false;
    log.info('shutdown requested', { signal, graceMs: config.shutdownGraceMs });
    setTimeout(() => {
      server.close(() => {
        log.info('shutdown complete');
        process.exit(0);
      });
      server.closeIdleConnections();
      setTimeout(() => process.exit(1), 10_000).unref();
    }, config.shutdownGraceMs).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  return app;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  start();
}
