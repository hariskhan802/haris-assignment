import { query } from '../db/pool.js';
import { NotFoundError, ValidationError } from '../errors.js';

export interface FinancialProduct {
  id: number;
  name: string;
  productType: 'loan' | 'savings' | 'investment';
  annualInterestRate: number;
  minTermYears: number | null;
  maxTermYears: number | null;
  description: string | null;
}

interface ProductRow {
  id: number;
  name: string;
  product_type: FinancialProduct['productType'];
  annual_interest_rate: number;
  min_term_years: number | null;
  max_term_years: number | null;
  description: string | null;
}

function toProduct(row: ProductRow): FinancialProduct {
  return {
    id: row.id,
    name: row.name,
    productType: row.product_type,
    annualInterestRate: row.annual_interest_rate,
    minTermYears: row.min_term_years,
    maxTermYears: row.max_term_years,
    description: row.description,
  };
}

const SELECT_COLUMNS = `
  id, name, product_type, annual_interest_rate, min_term_years, max_term_years, description
`;

export async function listFinancialProducts(): Promise<FinancialProduct[]> {
  const { rows } = await query<ProductRow>(
    `SELECT ${SELECT_COLUMNS} FROM financial_products ORDER BY product_type, name`,
  );
  return rows.map(toProduct);
}

/**
 * Look a product up by name. Matching is deliberately forgiving because the
 * name arrives from natural language ("home loan", "the Home Loan product"):
 *   1. exact, case-insensitive
 *   2. substring, case-insensitive — only accepted when it is unambiguous
 *
 * All parameterised queries; the model-supplied string never reaches SQL as text.
 */
export async function getFinancialProduct(name: string): Promise<FinancialProduct> {
  const trimmed = name?.trim();
  if (!trimmed) {
    throw new ValidationError('A product name is required to look up a financial product.');
  }

  const exact = await query<ProductRow>(
    `SELECT ${SELECT_COLUMNS} FROM financial_products WHERE LOWER(name) = LOWER($1) LIMIT 1`,
    [trimmed],
  );
  if (exact.rows[0]) return toProduct(exact.rows[0]);

  const partial = await query<ProductRow>(
    `SELECT ${SELECT_COLUMNS} FROM financial_products WHERE name ILIKE '%' || $1 || '%' ORDER BY name`,
    [trimmed],
  );

  if (partial.rows.length === 1) return toProduct(partial.rows[0]!);

  const available = (await listFinancialProducts()).map((p) => p.name);

  if (partial.rows.length > 1) {
    throw new NotFoundError(
      `"${trimmed}" matches more than one product. Ask the user which one they mean.`,
      { matches: partial.rows.map((r) => r.name), availableProducts: available },
    );
  }

  throw new NotFoundError(`No financial product named "${trimmed}" exists in the database.`, {
    availableProducts: available,
  });
}

/**
 * Terms outside the product's advertised range are a business-rule violation,
 * not a maths error — so it is checked here rather than in the formula module.
 */
export function assertTermWithinProductRange(product: FinancialProduct, years: number): void {
  const { minTermYears, maxTermYears } = product;
  if (minTermYears !== null && years < minTermYears) {
    throw new ValidationError(
      `${product.name} requires a term of at least ${minTermYears} year(s); ${years} was requested.`,
    );
  }
  if (maxTermYears !== null && years > maxTermYears) {
    throw new ValidationError(
      `${product.name} allows a term of at most ${maxTermYears} year(s); ${years} was requested.`,
    );
  }
}
