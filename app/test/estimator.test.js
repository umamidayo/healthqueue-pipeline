import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ACUITY_LEVELS, ValidationError, estimateWait } from '../src/estimator.js';

describe('estimateWait', () => {
  it('sends ESI 1 straight to the front of the queue', () => {
    const r = estimateWait({ acuity: 1, patientsAhead: 40, cliniciansOnShift: 2 });
    assert.equal(r.estimatedWaitMinutes, 0);
    assert.equal(r.priorityBand, 'immediate');
    assert.equal(r.breachesTarget, false);
  });

  it('divides queue work across clinicians and rounds up', () => {
    const r = estimateWait({ acuity: 3, patientsAhead: 5, cliniciansOnShift: 2, avgConsultMinutes: 15 });
    assert.equal(r.estimatedWaitMinutes, 38); // ceil(75 / 2)
    assert.equal(r.targetMinutes, 30);
    assert.equal(r.breachesTarget, true);
  });

  it('defaults the consult length to 15 minutes', () => {
    const r = estimateWait({ acuity: 4, patientsAhead: 2, cliniciansOnShift: 1 });
    assert.equal(r.estimatedWaitMinutes, 30);
    assert.equal(r.breachesTarget, false);
  });

  it('returns zero wait for an empty queue', () => {
    const r = estimateWait({ acuity: 5, patientsAhead: 0, cliniciansOnShift: 3 });
    assert.equal(r.estimatedWaitMinutes, 0);
  });

  it('covers every ESI level', () => {
    for (const acuity of Object.keys(ACUITY_LEVELS).map(Number)) {
      const r = estimateWait({ acuity, patientsAhead: 1, cliniciansOnShift: 1 });
      assert.equal(r.label, ACUITY_LEVELS[acuity].label);
    }
  });

  it('reports every invalid field at once', () => {
    assert.throws(
      () => estimateWait({ acuity: 9, patientsAhead: -1, cliniciansOnShift: 0, avgConsultMinutes: 1.5 }),
      (err) => {
        assert.ok(err instanceof ValidationError);
        assert.deepEqual(
          err.fields.map((f) => f.field),
          ['acuity', 'patientsAhead', 'cliniciansOnShift', 'avgConsultMinutes'],
        );
        return true;
      },
    );
  });

  it('requires mandatory fields', () => {
    assert.throws(() => estimateWait({}), (err) => err.fields.length === 3);
  });

  it('rejects non-object bodies', () => {
    for (const body of [null, [], 'x', 3]) {
      assert.throws(() => estimateWait(body), ValidationError);
    }
  });

  it('rejects numeric strings rather than coercing them', () => {
    assert.throws(() => estimateWait({ acuity: '2', patientsAhead: 1, cliniciansOnShift: 1 }), ValidationError);
  });
});
