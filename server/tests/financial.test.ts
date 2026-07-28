import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  calculateCompoundInterest,
  calculateLoanPayment,
} from '../src/services/financial.service.js';
import { ValidationError } from '../src/errors.js';

/**
 * These tests are the reason the formulas live in the backend: the numbers are
 * checked against independently known values, which is impossible to do for a
 * figure an LLM produced on the fly.
 */

describe('calculateCompoundInterest', () => {
  it('matches the README example: $10,000 for 5 years at 8% compounded annually', () => {
    const r = calculateCompoundInterest({ principal: 10_000, annualRatePercent: 8, years: 5 });
    // 10000 * 1.08^5 = 14693.280768
    assert.equal(r.futureValue, 14_693.28);
    assert.equal(r.totalInterest, 4_693.28);
    assert.equal(r.inputs.compoundsPerYear, 1);
  });

  it('compounds monthly when asked', () => {
    const r = calculateCompoundInterest({
      principal: 10_000,
      annualRatePercent: 8,
      years: 5,
      compoundsPerYear: 12,
    });
    // 10000 * (1 + 0.08/12)^60 = 14898.457...
    assert.equal(r.futureValue, 14_898.46);
    assert.equal(r.effectiveAnnualRatePercent, 8.3); // AER of 8% nominal, monthly
  });

  it('returns the principal unchanged at a 0% rate', () => {
    const r = calculateCompoundInterest({ principal: 5_000, annualRatePercent: 0, years: 10 });
    assert.equal(r.futureValue, 5_000);
    assert.equal(r.totalInterest, 0);
  });

  it('rejects a non-positive principal', () => {
    assert.throws(
      () => calculateCompoundInterest({ principal: 0, annualRatePercent: 5, years: 1 }),
      ValidationError,
    );
  });

  it('rejects an unsupported compounding frequency', () => {
    assert.throws(
      () =>
        calculateCompoundInterest({
          principal: 1_000,
          annualRatePercent: 5,
          years: 1,
          compoundsPerYear: 7,
        }),
      ValidationError,
    );
  });

  it('rejects a rate passed as a decimal fraction disguised as a percent > 100', () => {
    assert.throws(
      () => calculateCompoundInterest({ principal: 1_000, annualRatePercent: 250, years: 1 }),
      ValidationError,
    );
  });
});

describe('calculateLoanPayment', () => {
  it('matches the README example: $300,000 at 6.5% over 30 years', () => {
    const r = calculateLoanPayment({ principal: 300_000, annualRatePercent: 6.5, years: 30 });
    assert.equal(r.monthlyPayment, 1_896.2);
    assert.equal(r.numberOfPayments, 360);
    // Totals reconcile against the rounded payment: 1896.20 * 360.
    assert.equal(r.totalPaid, 682_632);
    assert.equal(r.totalInterest, 382_632);
  });

  it('handles a short high-rate loan', () => {
    // $25,000 at 8.25% over 5 years -> 60 payments
    const r = calculateLoanPayment({ principal: 25_000, annualRatePercent: 8.25, years: 5 });
    assert.equal(r.numberOfPayments, 60);
    assert.equal(r.monthlyPayment, 509.91);
  });

  it('converts a term in months correctly (360 months == 30 years)', () => {
    const byYears = calculateLoanPayment({ principal: 300_000, annualRatePercent: 6.5, years: 30 });
    const byMonths = calculateLoanPayment({
      principal: 300_000,
      annualRatePercent: 6.5,
      years: 360 / 12,
    });
    assert.equal(byYears.monthlyPayment, byMonths.monthlyPayment);
  });

  it('total paid always exceeds the principal for a positive rate', () => {
    const r = calculateLoanPayment({ principal: 100_000, annualRatePercent: 5, years: 15 });
    assert.ok(r.totalPaid > 100_000);
    assert.ok(r.totalInterest > 0);
  });

  it('supports a 0% loan by falling back to principal / n', () => {
    // The general formula is 0/0 at i = 0, so this path is special-cased.
    const r = calculateLoanPayment({ principal: 10_000, annualRatePercent: 0, years: 5 });
    assert.equal(r.monthlyPayment, 166.67);
    assert.equal(r.numberOfPayments, 60);
  });

  it('rejects a negative term', () => {
    assert.throws(
      () => calculateLoanPayment({ principal: 10_000, annualRatePercent: 5, years: -1 }),
      ValidationError,
    );
  });
});
