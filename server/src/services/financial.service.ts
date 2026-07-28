import { ValidationError } from '../errors.js';

/**
 * ===========================================================================
 * Trusted financial engine.
 *
 * This module is the ONLY place a monetary result is ever produced. The LLM
 * may choose which function runs and with what arguments, but it never
 * computes a number itself. Every function here:
 *   1. validates its own inputs (never trusts the caller / the model),
 *   2. applies a textbook formula,
 *   3. returns the inputs alongside the outputs so the result is auditable.
 * ===========================================================================
 */

export type CalculationType = 'compound_interest' | 'loan_payment';

/** Round to cents. Money is presented at 2dp; see README limitations re: floats. */
function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function roundRate(value: number): number {
  return Math.round((value + Number.EPSILON) * 1000) / 1000;
}

/** Guard against NaN/Infinity slipping through arithmetic into the database. */
function assertFinite(value: number, label: string): number {
  if (!Number.isFinite(value)) {
    throw new ValidationError(
      `The ${label} could not be computed from these inputs (result was not a finite number). Please check the values.`,
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// Shared input guards
// ---------------------------------------------------------------------------

const LIMITS = {
  maxPrincipal: 1_000_000_000, // $1B — beyond this it is almost certainly a typo
  maxYears: 100,
  maxRatePercent: 100,
} as const;

function validatePrincipal(principal: number): number {
  if (!Number.isFinite(principal) || principal <= 0) {
    throw new ValidationError('Principal amount must be a positive number.');
  }
  if (principal > LIMITS.maxPrincipal) {
    throw new ValidationError(
      `Principal amount must not exceed ${LIMITS.maxPrincipal.toLocaleString('en-US')}.`,
    );
  }
  return principal;
}

function validateYears(years: number): number {
  if (!Number.isFinite(years) || years <= 0) {
    throw new ValidationError('Term in years must be a positive number.');
  }
  if (years > LIMITS.maxYears) {
    throw new ValidationError(`Term in years must not exceed ${LIMITS.maxYears}.`);
  }
  return years;
}

/**
 * Rates are handled as percentages end-to-end (6.5 means 6.5% per year) and are
 * only converted to a decimal fraction inside the formula. Mixing the two
 * representations is the single most common bug in this kind of code, so the
 * boundary is stated explicitly here.
 */
function validateAnnualRatePercent(annualRatePercent: number): number {
  if (!Number.isFinite(annualRatePercent)) {
    throw new ValidationError('Annual interest rate must be a number.');
  }
  if (annualRatePercent < 0) {
    throw new ValidationError('Annual interest rate cannot be negative.');
  }
  if (annualRatePercent > LIMITS.maxRatePercent) {
    throw new ValidationError(
      `Annual interest rate must not exceed ${LIMITS.maxRatePercent}%. ` +
        'Note the rate is expected as a percentage (e.g. 6.5 for 6.5%).',
    );
  }
  return annualRatePercent;
}

// ---------------------------------------------------------------------------
// 1. Compound interest
// ---------------------------------------------------------------------------

export interface CompoundInterestInput {
  principal: number;
  annualRatePercent: number;
  years: number;
  /** Compounding frequency per year. 1 = annually (default), 12 = monthly. */
  compoundsPerYear?: number;
}

export interface CompoundInterestResult {
  calculationType: 'compound_interest';
  inputs: Required<CompoundInterestInput>;
  futureValue: number;
  totalInterest: number;
  /** Annual Equivalent Rate — what the nominal rate is actually worth once compounded. */
  effectiveAnnualRatePercent: number;
  formula: string;
}

const ALLOWED_COMPOUNDING = [1, 2, 4, 12, 52, 365] as const;

/**
 * A = P * (1 + r/n)^(n*t)
 *
 *   P = principal, r = annual rate as a decimal, n = compounds per year, t = years
 *   Interest earned = A - P
 */
export function calculateCompoundInterest(input: CompoundInterestInput): CompoundInterestResult {
  const principal = validatePrincipal(input.principal);
  const annualRatePercent = validateAnnualRatePercent(input.annualRatePercent);
  const years = validateYears(input.years);
  const compoundsPerYear = input.compoundsPerYear ?? 1;

  if (!ALLOWED_COMPOUNDING.includes(compoundsPerYear as (typeof ALLOWED_COMPOUNDING)[number])) {
    throw new ValidationError(
      `Compounding frequency must be one of: ${ALLOWED_COMPOUNDING.join(', ')} times per year.`,
    );
  }

  const r = annualRatePercent / 100;
  const n = compoundsPerYear;

  const growthFactor = Math.pow(1 + r / n, n * years);
  const futureValue = assertFinite(principal * growthFactor, 'future value');
  const totalInterest = futureValue - principal;
  const effectiveAnnualRate = (Math.pow(1 + r / n, n) - 1) * 100;

  return {
    calculationType: 'compound_interest',
    inputs: { principal, annualRatePercent, years, compoundsPerYear },
    futureValue: roundMoney(futureValue),
    totalInterest: roundMoney(totalInterest),
    effectiveAnnualRatePercent: roundRate(effectiveAnnualRate),
    formula: 'A = P * (1 + r/n)^(n*t)',
  };
}

// ---------------------------------------------------------------------------
// 2. Monthly loan payment (fixed-rate amortisation)
// ---------------------------------------------------------------------------

export interface LoanPaymentInput {
  principal: number;
  annualRatePercent: number;
  years: number;
}

export interface LoanPaymentResult {
  calculationType: 'loan_payment';
  inputs: Required<LoanPaymentInput>;
  monthlyPayment: number;
  numberOfPayments: number;
  totalPaid: number;
  totalInterest: number;
  formula: string;
}

/**
 * M = P * [ i(1+i)^n ] / [ (1+i)^n - 1 ]
 *
 *   P = principal, i = monthly rate (annual / 12), n = total number of payments
 *   Zero-interest edge case degenerates to M = P / n (the formula above is 0/0 there).
 */
export function calculateLoanPayment(input: LoanPaymentInput): LoanPaymentResult {
  const principal = validatePrincipal(input.principal);
  const annualRatePercent = validateAnnualRatePercent(input.annualRatePercent);
  const years = validateYears(input.years);

  const numberOfPayments = Math.round(years * 12);
  if (numberOfPayments < 1) {
    throw new ValidationError('Loan term must cover at least one monthly payment.');
  }

  const i = annualRatePercent / 100 / 12;

  const monthlyPaymentRaw =
    i === 0
      ? principal / numberOfPayments
      : (principal * (i * Math.pow(1 + i, numberOfPayments))) /
        (Math.pow(1 + i, numberOfPayments) - 1);

  const monthlyPayment = roundMoney(assertFinite(monthlyPaymentRaw, 'monthly payment'));
  // Totals are derived from the ROUNDED payment, because that is the amount the
  // borrower is actually billed each month — it keeps `monthly * n == total`
  // reconcilable by hand. Real lenders absorb the few cents of drift in the
  // final instalment; see the limitations section of the README.
  const totalPaid = roundMoney(monthlyPayment * numberOfPayments);

  return {
    calculationType: 'loan_payment',
    inputs: { principal, annualRatePercent, years },
    monthlyPayment,
    numberOfPayments,
    totalPaid,
    totalInterest: roundMoney(totalPaid - principal),
    formula: 'M = P * [ i(1+i)^n ] / [ (1+i)^n - 1 ]',
  };
}

// ---------------------------------------------------------------------------
// Helpers used by the persistence layer
// ---------------------------------------------------------------------------

export type CalculationResult = CompoundInterestResult | LoanPaymentResult;

/** The single headline number stored in messages.calculation_result. */
export function headlineValue(result: CalculationResult): number {
  return result.calculationType === 'compound_interest'
    ? result.futureValue
    : result.monthlyPayment;
}
