import { closePool, query } from './pool.js';

/**
 * Seed data for the product catalogue. Idempotent via ON CONFLICT so it can be
 * re-run after schema changes without duplicating rows.
 */
const products = [
  {
    name: 'Home Loan',
    product_type: 'loan',
    annual_interest_rate: 6.5,
    min_term_years: 5,
    max_term_years: 30,
    description: 'Standard fixed-rate mortgage for residential property purchases.',
  },
  {
    name: 'Auto Loan',
    product_type: 'loan',
    annual_interest_rate: 8.25,
    min_term_years: 1,
    max_term_years: 7,
    description: 'Fixed-rate financing for new and used vehicles.',
  },
  {
    name: 'Personal Loan',
    product_type: 'loan',
    annual_interest_rate: 12.0,
    min_term_years: 1,
    max_term_years: 5,
    description: 'Unsecured fixed-rate loan for general purposes.',
  },
  {
    name: 'High Yield Savings',
    product_type: 'savings',
    annual_interest_rate: 4.25,
    min_term_years: 1,
    max_term_years: 10,
    description: 'Interest-bearing savings account compounded monthly.',
  },
  {
    name: 'Fixed Deposit',
    product_type: 'investment',
    annual_interest_rate: 7.0,
    min_term_years: 1,
    max_term_years: 10,
    description: 'Term deposit with a locked-in annual rate, compounded annually.',
  },
] as const;

async function seed(): Promise<void> {
  for (const p of products) {
    await query(
      `INSERT INTO financial_products
         (name, product_type, annual_interest_rate, min_term_years, max_term_years, description)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (name) DO UPDATE SET
         product_type         = EXCLUDED.product_type,
         annual_interest_rate = EXCLUDED.annual_interest_rate,
         min_term_years       = EXCLUDED.min_term_years,
         max_term_years       = EXCLUDED.max_term_years,
         description          = EXCLUDED.description`,
      [p.name, p.product_type, p.annual_interest_rate, p.min_term_years, p.max_term_years, p.description],
    );
    console.log(`  + ${p.name} (${p.product_type} @ ${p.annual_interest_rate}%)`);
  }
  console.log(`Seeded ${products.length} financial product(s).`);
}

seed()
  .then(closePool)
  .catch(async (err) => {
    console.error(err);
    await closePool();
    process.exit(1);
  });
