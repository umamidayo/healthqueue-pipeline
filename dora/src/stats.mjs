export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;

export const hoursBetween = (a, b) => (new Date(b) - new Date(a)) / HOUR_MS;

/** Linear-interpolated percentile (p in [0, 100]); null for empty input. */
export function percentile(values, p) {
  const xs = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  if (xs.length === 1) return xs[0];
  const rank = (p / 100) * (xs.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  return xs[lo] + (xs[hi] - xs[lo]) * (rank - lo);
}

export const median = (values) => percentile(values, 50);

export const ratio = (num, den) => (den > 0 ? num / den : null);

/** Monday 00:00 UTC of the week containing `date`. */
export function weekStart(date) {
  const d = new Date(date);
  const day = (d.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day));
}

export function formatHours(hours) {
  if (hours === null || hours === undefined) return 'n/a';
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  if (hours < 48) return `${hours.toFixed(1)}h`;
  return `${(hours / 24).toFixed(1)}d`;
}

export const formatPct = (r) => (r === null || r === undefined ? 'n/a' : `${(r * 100).toFixed(1)}%`);

export const isoDate = (d) => new Date(d).toISOString().slice(0, 10);
