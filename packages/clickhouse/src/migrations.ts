import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { DataIntegrityError, StorageError, silentLogger, type Logger } from '@exitliquidity/core';
import type { ClickHouseClient } from './client.js';

/** Resolves to `packages/clickhouse/migrations` from both `src` and `dist`. */
const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

const MIGRATIONS_TABLE = `
CREATE TABLE IF NOT EXISTS schema_migrations
(
    name       String,
    checksum   String,
    applied_at DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(applied_at)
ORDER BY (name)
`;

export interface Migration {
  readonly name: string;
  readonly sql: string;
  readonly checksum: string;
}

export interface AppliedMigration {
  readonly name: string;
  readonly status: 'applied' | 'already-applied';
}

/** Reads migrations off disk in filename order. Prefixes decide the order. */
export async function loadMigrations(directory = MIGRATIONS_DIR): Promise<Migration[]> {
  const entries = (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort();

  return Promise.all(
    entries.map(async (name) => {
      const sql = await readFile(join(directory, name), 'utf8');
      return { name, sql, checksum: createHash('sha256').update(sql).digest('hex').slice(0, 16) };
    }),
  );
}

/**
 * Applies every pending migration, in order, inside one client.
 *
 * ClickHouse has no transactional DDL, so a migration must be written to be
 * safe to re-run — every statement here is `IF NOT EXISTS`. The checksum guard
 * catches the more dangerous mistake: editing a migration that has already run
 * somewhere, which would leave two environments with different schemas and no
 * sign of it.
 */
export async function runMigrations(
  client: ClickHouseClient,
  options: { logger?: Logger; directory?: string } = {},
): Promise<AppliedMigration[]> {
  const logger = options.logger ?? silentLogger;
  const migrations = await loadMigrations(options.directory ?? MIGRATIONS_DIR);

  await client.command({ query: MIGRATIONS_TABLE });

  const applied = await fetchApplied(client);
  const results: AppliedMigration[] = [];

  for (const migration of migrations) {
    const previous = applied.get(migration.name);

    if (previous !== undefined) {
      if (previous !== migration.checksum) {
        throw new DataIntegrityError(
          `migration ${migration.name} changed after it was applied (${previous} -> ${migration.checksum}); add a new migration instead of editing this one`,
          {
            context: { migration: migration.name, expected: previous, actual: migration.checksum },
          },
        );
      }
      results.push({ name: migration.name, status: 'already-applied' });
      continue;
    }

    logger.info({ migration: migration.name }, 'applying migration');
    for (const statement of splitStatements(migration.sql)) {
      try {
        await client.command({ query: statement });
      } catch (error) {
        throw new StorageError(`migration ${migration.name} failed`, {
          cause: error,
          context: { migration: migration.name, statement: statement.slice(0, 200) },
        });
      }
    }

    await client.insert({
      table: 'schema_migrations',
      values: [{ name: migration.name, checksum: migration.checksum }],
      format: 'JSONEachRow',
    });
    results.push({ name: migration.name, status: 'applied' });
  }

  return results;
}

async function fetchApplied(client: ClickHouseClient): Promise<Map<string, string>> {
  const result = await client.query({
    // FINAL because a re-applied checksum row is only collapsed at merge time,
    // and reading the stale one would fire a spurious drift error.
    query: 'SELECT name, checksum FROM schema_migrations FINAL',
    format: 'JSONEachRow',
  });
  const rows = await result.json<{ name: string; checksum: string }>();
  return new Map(rows.map((row) => [row.name, row.checksum]));
}

/**
 * Splits a migration file into statements.
 *
 * Comments are stripped first so a `;` inside one cannot split a statement.
 * String literals are not handled — no migration here contains one, and a
 * migration that needs one should be a separate file.
 */
export function splitStatements(sql: string): string[] {
  return sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n')
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}
