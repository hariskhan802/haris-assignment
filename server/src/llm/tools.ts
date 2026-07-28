import { z } from 'zod';
import { AppError } from '../errors.js';
import {
  calculateCompoundInterest,
  calculateLoanPayment,
  headlineValue,
  type CalculationType,
} from '../services/financial.service.js';
import {
  assertTermWithinProductRange,
  getFinancialProduct,
  listFinancialProducts,
} from '../services/product.service.js';

/**
 * ===========================================================================
 * Tool registry — the contract between the LLM and the backend.
 *
 * Each entry carries FOUR things:
 *   1. `parameters` — a provider-agnostic JSON Schema advertised to the model.
 *   2. `schema`     — a Zod schema the backend uses to re-validate whatever the
 *                     model actually sent. The model's arguments are treated as
 *                     untrusted input, exactly like a request body.
 *   3. `execute`    — the real work: DB access + trusted formula.
 *   4. `description`— prompt-engineering surface; this is how the model decides.
 * ===========================================================================
 */

// --- provider-agnostic JSON Schema subset -----------------------------------

export interface JsonSchemaProperty {
  type: 'string' | 'number' | 'integer' | 'boolean';
  description: string;
  enum?: string[];
}

export interface JsonSchemaObject {
  type: 'object';
  properties: Record<string, JsonSchemaProperty>;
  required: string[];
}

// --- execution result -------------------------------------------------------

/** A verified calculation, ready to be persisted and explained. */
export interface CalculationOutcome {
  type: CalculationType;
  result: number;
  details: Record<string, unknown>;
}

export type ToolExecutionResult =
  | { ok: true; data: Record<string, unknown>; calculation?: CalculationOutcome }
  | { ok: false; error: { code: string; message: string; details?: unknown } };

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: JsonSchemaObject;
  execute: (rawArgs: unknown) => Promise<ToolExecutionResult>;
}

// --- helpers ----------------------------------------------------------------

const positiveNumber = z.number().finite().positive();

/**
 * Wraps a typed handler with Zod validation and error normalisation, so every
 * tool fails the same shape. Errors are RETURNED (not thrown) because they are
 * fed back to the model as a function response — that is what lets the model
 * say "what term did you want?" instead of the request 500-ing.
 */
function defineTool<TSchema extends z.ZodTypeAny>(config: {
  name: string;
  description: string;
  parameters: JsonSchemaObject;
  schema: TSchema;
  handler: (args: z.infer<TSchema>) => Promise<{
    data: Record<string, unknown>;
    calculation?: CalculationOutcome;
  }>;
}): ToolDefinition {
  return {
    name: config.name,
    description: config.description,
    parameters: config.parameters,
    async execute(rawArgs: unknown): Promise<ToolExecutionResult> {
      const parsed = config.schema.safeParse(rawArgs ?? {});
      if (!parsed.success) {
        return {
          ok: false,
          error: {
            code: 'VALIDATION_ERROR',
            message:
              'The arguments supplied are invalid. Ask the user for the missing or corrected values.',
            details: parsed.error.issues.map((i) => ({
              field: i.path.join('.') || '(root)',
              problem: i.message,
            })),
          },
        };
      }

      try {
        const { data, calculation } = await config.handler(parsed.data);
        return calculation ? { ok: true, data, calculation } : { ok: true, data };
      } catch (err) {
        if (err instanceof AppError) {
          return { ok: false, error: { code: err.code, message: err.message, details: err.details } };
        }
        console.error(`Tool ${config.name} failed unexpectedly:`, err);
        return {
          ok: false,
          error: {
            code: 'INTERNAL_ERROR',
            message: 'The calculation service failed unexpectedly. Apologise and ask them to retry.',
          },
        };
      }
    },
  };
}

/**
 * Resolves the interest rate for a calculation.
 *
 * When the user names a stored product, the DB rate WINS — any rate the model
 * supplied alongside it is discarded. This is the guard that makes
 * "using the stored interest rate" trustworthy even if the model hallucinates
 * a number in the same tool call.
 */
async function resolveRate(args: { productName?: string; annualRatePercent?: number }): Promise<{
  annualRatePercent: number;
  product: Awaited<ReturnType<typeof getFinancialProduct>> | null;
  rateSource: 'database' | 'user_supplied';
}> {
  if (args.productName) {
    const product = await getFinancialProduct(args.productName);
    return { annualRatePercent: product.annualInterestRate, product, rateSource: 'database' };
  }
  if (args.annualRatePercent === undefined) {
    return Promise.reject(
      new AppError(
        'No interest rate available: supply annualRatePercent, or productName to use a stored rate.',
        'MISSING_RATE',
        400,
      ),
    );
  }
  return { annualRatePercent: args.annualRatePercent, product: null, rateSource: 'user_supplied' };
}

// ---------------------------------------------------------------------------
// Tool 1 — look up a stored product
// ---------------------------------------------------------------------------

const getFinancialProductTool = defineTool({
  name: 'get_financial_product',
  description:
    'Look up a financial product stored in the database and return its official annual interest ' +
    'rate and allowed term range. Use this when the user asks about a named product (for example ' +
    '"Home Loan"), or asks what rate a product carries.',
  parameters: {
    type: 'object',
    properties: {
      productName: {
        type: 'string',
        description: 'Name of the product as the user referred to it, e.g. "Home Loan".',
      },
    },
    required: ['productName'],
  },
  schema: z.object({ productName: z.string().min(1) }),
  async handler({ productName }) {
    const product = await getFinancialProduct(productName);
    return { data: { product } };
  },
});

// ---------------------------------------------------------------------------
// Tool 2 — list the catalogue
// ---------------------------------------------------------------------------

const listFinancialProductsTool = defineTool({
  name: 'list_financial_products',
  description:
    'List every financial product available in the database with its type and annual interest ' +
    'rate. Use this when the user asks what products, loans or rates are offered.',
  parameters: { type: 'object', properties: {}, required: [] },
  schema: z.object({}).passthrough(),
  async handler() {
    return { data: { products: await listFinancialProducts() } };
  },
});

// ---------------------------------------------------------------------------
// Tool 3 — compound interest
// ---------------------------------------------------------------------------

const compoundInterestTool = defineTool({
  name: 'calculate_compound_interest',
  description:
    'Calculate the future value of a lump-sum investment or savings balance that earns compound ' +
    'interest. Use this for questions like "what will $10,000 become after 5 years at 8%?". ' +
    'Provide either annualRatePercent, or productName to use the rate stored in the database.',
  parameters: {
    type: 'object',
    properties: {
      principal: {
        type: 'number',
        description: 'The starting amount invested or deposited, in dollars. Must be positive.',
      },
      years: { type: 'number', description: 'Investment term in years. Must be positive.' },
      annualRatePercent: {
        type: 'number',
        description:
          'Annual interest rate as a PERCENTAGE, e.g. 8 for 8% (not 0.08). Omit when productName is given.',
      },
      productName: {
        type: 'string',
        description:
          'Name of a stored product whose interest rate should be used instead of a user-supplied rate.',
      },
      compoundsPerYear: {
        type: 'integer',
        description:
          'Compounding frequency per year: 1 annually (default), 2 semi-annually, 4 quarterly, ' +
          '12 monthly, 52 weekly, 365 daily. Only set it if the user states the frequency.',
      },
    },
    required: ['principal', 'years'],
  },
  schema: z
    .object({
      principal: positiveNumber,
      years: positiveNumber,
      annualRatePercent: z.number().finite().min(0).optional(),
      productName: z.string().min(1).optional(),
      compoundsPerYear: z.number().int().positive().optional(),
    })
    .refine((a) => a.annualRatePercent !== undefined || a.productName !== undefined, {
      message: 'Either annualRatePercent or productName must be provided.',
    }),
  async handler(args) {
    const { annualRatePercent, product, rateSource } = await resolveRate(args);

    const result = calculateCompoundInterest({
      principal: args.principal,
      annualRatePercent,
      years: args.years,
      ...(args.compoundsPerYear !== undefined ? { compoundsPerYear: args.compoundsPerYear } : {}),
    });

    const details = { ...result, rateSource, product };
    return {
      data: { ...details, currency: 'USD' },
      calculation: { type: result.calculationType, result: headlineValue(result), details },
    };
  },
});

// ---------------------------------------------------------------------------
// Tool 4 — monthly loan payment
// ---------------------------------------------------------------------------

const loanPaymentTool = defineTool({
  name: 'calculate_loan_payment',
  description:
    'Calculate the fixed monthly payment for an amortising loan, plus the total paid and total ' +
    'interest over its life. Use this for questions like "what is the monthly payment on a ' +
    '$300,000 loan at 6.5% over 30 years?". Provide either annualRatePercent, or productName to ' +
    'use the rate stored in the database (required when the user says "the stored rate").',
  parameters: {
    type: 'object',
    properties: {
      principal: { type: 'number', description: 'Loan amount in dollars. Must be positive.' },
      years: { type: 'number', description: 'Loan term in years. Must be positive.' },
      annualRatePercent: {
        type: 'number',
        description:
          'Annual interest rate as a PERCENTAGE, e.g. 6.5 for 6.5% (not 0.065). Omit when productName is given.',
      },
      productName: {
        type: 'string',
        description:
          'Name of a stored loan product, e.g. "Home Loan". When set, the database rate is used ' +
          'and the term is validated against the product rules.',
      },
    },
    required: ['principal', 'years'],
  },
  schema: z
    .object({
      principal: positiveNumber,
      years: positiveNumber,
      annualRatePercent: z.number().finite().min(0).optional(),
      productName: z.string().min(1).optional(),
    })
    .refine((a) => a.annualRatePercent !== undefined || a.productName !== undefined, {
      message: 'Either annualRatePercent or productName must be provided.',
    }),
  async handler(args) {
    const { annualRatePercent, product, rateSource } = await resolveRate(args);

    if (product) assertTermWithinProductRange(product, args.years);

    const result = calculateLoanPayment({
      principal: args.principal,
      annualRatePercent,
      years: args.years,
    });

    const details = { ...result, rateSource, product };
    return {
      data: { ...details, currency: 'USD' },
      calculation: { type: result.calculationType, result: headlineValue(result), details },
    };
  },
});

// ---------------------------------------------------------------------------

export const toolRegistry: ToolDefinition[] = [
  getFinancialProductTool,
  listFinancialProductsTool,
  compoundInterestTool,
  loanPaymentTool,
];

export const toolsByName = new Map(toolRegistry.map((t) => [t.name, t]));
