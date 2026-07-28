import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closePool, pool } from './pool.js';

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

/**
 * Minimal forward-only migration runner. Each .sql file runs once, inside a
 * transaction, and is recorded in schema_migrations. Deliberately hand-rolled
 * instead of pulling in an ORM — the schema is three tables and this keeps the
 * SQL itself reviewable.
 */
async function migrate(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename    TEXT        PRIMARY KEY,
        applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    const applied = new Set(
      (await client.query<{ filename: string }>('SELECT filename FROM schema_migrations')).rows.map(
        (r) => r.filename,
      ),
    );

    const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();

    let ran = 0;
    for (const file of files) {
      if (applied.has(file)) {
        console.log(`  = ${file} (already applied)`);
        continue;
      }
      const sql = await readFile(join(migrationsDir, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
        await client.query('COMMIT');
        console.log(`  + ${file} applied`);
        ran++;
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`, { cause: err });
      }
    }

    console.log(ran === 0 ? 'Database already up to date.' : `Applied ${ran} migration(s).`);
  } finally {
    client.release();
  }
}

migrate()
  .then(closePool)
  .catch(async (err) => {
    console.error(err);
    await closePool();
    process.exit(1);
  });
