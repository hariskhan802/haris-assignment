import type { LlmGenerateInput, LlmGenerateOutput, LlmProvider } from './provider.js';

/**
 * ===========================================================================
 * Offline test double for the LLM (LLM_PROVIDER=mock).
 *
 * This is NOT the product's intelligence — the real integration is
 * GeminiProvider. It exists so the API, the tool loop, the validation path and
 * the database writes can be exercised in tests and on a machine with no API
 * key or no network. It uses crude regexes and understands only the handful of
 * phrasings in the README's example questions.
 * ===========================================================================
 */

const MULTIPLIERS: Record<string, number> = { k: 1_000, m: 1_000_000, thousand: 1_000, million: 1_000_000 };

const KNOWN_PRODUCTS = ['home loan', 'auto loan', 'personal loan', 'high yield savings', 'fixed deposit'];

function parseAmount(text: string): number | undefined {
  // Prefer an explicitly signed amount ("$300,000"), else the largest bare number.
  const dollar = /\$\s*([\d,]+(?:\.\d+)?)\s*(k|m|thousand|million)?/i.exec(text);
  if (dollar) {
    const base = Number(dollar[1]!.replace(/,/g, ''));
    return base * (MULTIPLIERS[dollar[2]?.toLowerCase() ?? ''] ?? 1);
  }
  const candidates = [...text.matchAll(/([\d,]+(?:\.\d+)?)\s*(k|m|thousand|million)?/gi)]
    .map((m) => Number(m[1]!.replace(/,/g, '')) * (MULTIPLIERS[m[2]?.toLowerCase() ?? ''] ?? 1))
    .filter((n) => Number.isFinite(n) && n >= 1000);
  return candidates.length ? Math.max(...candidates) : undefined;
}

function parseRatePercent(text: string): number | undefined {
  const m = /([\d.]+)\s*(?:%|percent)/i.exec(text);
  return m ? Number(m[1]) : undefined;
}

function parseYears(text: string): number | undefined {
  const years = /([\d.]+)\s*(?:years?|yrs?)/i.exec(text);
  if (years) return Number(years[1]);
  const months = /([\d.]+)\s*months?/i.exec(text);
  if (months) return Number(months[1]) / 12;
  return undefined;
}

function parseProductName(text: string): string | undefined {
  const lower = text.toLowerCase();
  return KNOWN_PRODUCTS.find((p) => lower.includes(p));
}

const money = (n: unknown): string =>
  typeof n === 'number' ? `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : String(n);

/** Turn the tool payloads already in the history into a human-readable answer. */
function summariseToolResults(input: LlmGenerateInput): string | null {
  const lastResult = [...input.history]
    .reverse()
    .flatMap((m) => m.parts)
    .find((p) => p.kind === 'toolResult');

  if (!lastResult || lastResult.kind !== 'toolResult') return null;

  const payload = lastResult.response as
    | { ok: true; data: Record<string, unknown> }
    | { ok: false; error: { message: string; details?: unknown } };

  if (!payload.ok) {
    return `I could not complete that: ${payload.error.message}`;
  }

  const d = payload.data;
  const fromDb = d['rateSource'] === 'database';
  const product = d['product'] as { name: string } | null;
  const source = fromDb && product ? ` using the stored ${product.name} rate of ${d['annualRatePercent'] ?? (d['inputs'] as Record<string, unknown> | undefined)?.['annualRatePercent']}%` : '';

  if (lastResult.name === 'calculate_loan_payment') {
    return (
      `Your estimated monthly payment is ${money(d['monthlyPayment'])}${source}. ` +
      `Over ${d['numberOfPayments']} payments you would repay ${money(d['totalPaid'])} in total, ` +
      `of which ${money(d['totalInterest'])} is interest.`
    );
  }
  if (lastResult.name === 'calculate_compound_interest') {
    return (
      `That would grow to ${money(d['futureValue'])}${source}, ` +
      `earning ${money(d['totalInterest'])} in interest.`
    );
  }
  if (lastResult.name === 'get_financial_product') {
    const p = d['product'] as { name: string; annualInterestRate: number; productType: string };
    return `The ${p.name} is a ${p.productType} product with an annual interest rate of ${p.annualInterestRate}%.`;
  }
  if (lastResult.name === 'list_financial_products') {
    const products = d['products'] as { name: string; annualInterestRate: number }[];
    return `We currently offer: ${products.map((p) => `${p.name} (${p.annualInterestRate}%)`).join(', ')}.`;
  }
  return 'Here is the result of your calculation.';
}

export class MockProvider implements LlmProvider {
  readonly name = 'mock';

  async generate(input: LlmGenerateInput): Promise<LlmGenerateOutput> {
    const alreadyCalledTool = input.history.some((m) => m.parts.some((p) => p.kind === 'toolResult'));

    if (alreadyCalledTool) {
      return { text: summariseToolResults(input) ?? 'Done.', toolCalls: [] };
    }

    const lastUserText =
      [...input.history]
        .reverse()
        .flatMap((m) => m.parts)
        .find((p) => p.kind === 'text')?.text ?? '';

    const text = lastUserText.toLowerCase();
    const principal = parseAmount(lastUserText);
    const years = parseYears(lastUserText);
    const productName = parseProductName(lastUserText);
    const ratePercent = parseRatePercent(lastUserText);

    if (/what (products|loans)|list .*(products|rates)|offer/.test(text)) {
      return { text: null, toolCalls: [{ name: 'list_financial_products', args: {} }] };
    }

    const wantsLoan = /monthly payment|loan payment|mortgage|\bloan\b/.test(text);
    const wantsCompound = /compound|become|grow|invest|savings|deposit|after \d+\s*years?/.test(text);

    if ((wantsLoan || wantsCompound) && principal !== undefined && years !== undefined) {
      const args: Record<string, unknown> = { principal, years };
      // Stored rate wins, mirroring the system prompt's instruction to the real model.
      if (productName) args['productName'] = productName;
      else if (ratePercent !== undefined) args['annualRatePercent'] = ratePercent;
      else return { text: 'What interest rate should I use?', toolCalls: [] };

      return {
        text: null,
        toolCalls: [
          { name: wantsLoan ? 'calculate_loan_payment' : 'calculate_compound_interest', args },
        ],
      };
    }

    if (productName && !principal) {
      return { text: null, toolCalls: [{ name: 'get_financial_product', args: { productName } }] };
    }

    return {
      text:
        '[mock LLM] I could not extract the details from that. Try: "What is the monthly payment ' +
        'for a $300,000 loan at 6.5% for 30 years?"',
      toolCalls: [],
    };
  }
}
