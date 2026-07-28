import pg from 'pg';
import { env } from '../config/env.js';

/**
 * Postgres returns NUMERIC as a string to avoid silent float precision loss.
 * Our values (rates, money) are well within IEEE-754 safe range, and the API
 * layer needs real numbers, so we opt into parsing them here in one place.
 */
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (value) => Number(value));
pg.types.setTypeParser(pg.types.builtins.INT8, (value) => Number(value));

export const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle Postgres client', err);
});

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<pg.QueryResult<T>> {
  return pool.query<T>(text, params);
}

export async function closePool(): Promise<void> {
  await pool.end();
}
