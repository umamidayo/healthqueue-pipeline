// Triage wait-time estimator.
//
// Pure functions only: no I/O, no clock, no randomness. This keeps the
// business logic trivially testable and keeps the service stateless (see
// docs/adr/0011-stateless-zero-dependency-workload.md).
//
// Acuity follows the five-level Emergency Severity Index (ESI). The service
// never receives or stores patient identifiers; inputs are aggregate counts.

export const ACUITY_LEVELS = Object.freeze({
  1: Object.freeze({ label: 'Resuscitation', priorityBand: 'immediate', targetMinutes: 0 }),
  2: Object.freeze({ label: 'Emergent', priorityBand: 'high', targetMinutes: 10 }),
  3: Object.freeze({ label: 'Urgent', priorityBand: 'medium', targetMinutes: 30 }),
  4: Object.freeze({ label: 'Less urgent', priorityBand: 'low', targetMinutes: 60 }),
  5: Object.freeze({ label: 'Non-urgent', priorityBand: 'low', targetMinutes: 120 }),
});

export const DEFAULT_CONSULT_MINUTES = 15;

const LIMITS = Object.freeze({
  patientsAhead: { min: 0, max: 10_000 },
  cliniciansOnShift: { min: 1, max: 1_000 },
  avgConsultMinutes: { min: 1, max: 480 },
});

export class ValidationError extends Error {
  constructor(fields) {
    super('invalid request');
    this.name = 'ValidationError';
    this.fields = fields;
  }
}

function checkInteger(errors, input, field, { min, max }, required = true) {
  const value = input[field];
  if (value === undefined || value === null) {
    if (required) errors.push({ field, message: 'is required' });
    return;
  }
  if (!Number.isInteger(value)) {
    errors.push({ field, message: 'must be an integer' });
  } else if (value < min || value > max) {
    errors.push({ field, message: `must be between ${min} and ${max}` });
  }
}

export function validateEstimateRequest(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new ValidationError([{ field: '(body)', message: 'must be a JSON object' }]);
  }
  const errors = [];
  checkInteger(errors, input, 'acuity', { min: 1, max: 5 });
  checkInteger(errors, input, 'patientsAhead', LIMITS.patientsAhead);
  checkInteger(errors, input, 'cliniciansOnShift', LIMITS.cliniciansOnShift);
  checkInteger(errors, input, 'avgConsultMinutes', LIMITS.avgConsultMinutes, false);
  if (errors.length > 0) throw new ValidationError(errors);
  return {
    acuity: input.acuity,
    patientsAhead: input.patientsAhead,
    cliniciansOnShift: input.cliniciansOnShift,
    avgConsultMinutes: input.avgConsultMinutes ?? DEFAULT_CONSULT_MINUTES,
  };
}

export function estimateWait(input) {
  const req = validateEstimateRequest(input);
  const level = ACUITY_LEVELS[req.acuity];

  // ESI 1 patients bypass the queue entirely.
  const estimatedWaitMinutes =
    req.acuity === 1
      ? 0
      : Math.ceil((req.patientsAhead * req.avgConsultMinutes) / req.cliniciansOnShift);

  return {
    acuity: req.acuity,
    label: level.label,
    priorityBand: level.priorityBand,
    estimatedWaitMinutes,
    targetMinutes: level.targetMinutes,
    breachesTarget: estimatedWaitMinutes > level.targetMinutes,
  };
}
