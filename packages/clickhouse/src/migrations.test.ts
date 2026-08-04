import { describe, expect, it } from 'vitest';
import { loadMigrations, splitStatements } from './migrations.js';

describe('splitStatements', () => {
  it('strips comments before splitting, so a semicolon in one is harmless', () => {
    const sql = `
      -- a comment; with a semicolon
      CREATE TABLE a (x UInt8) ENGINE = Memory;
      -- another; comment
      CREATE TABLE b (y UInt8) ENGINE = Memory;
    `;

    const statements = splitStatements(sql);
    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain('CREATE TABLE a');
    expect(statements[1]).toContain('CREATE TABLE b');
  });

  it('ignores a trailing semicolon and blank segments', () => {
    expect(splitStatements('SELECT 1;;\n\n')).toEqual(['SELECT 1']);
  });

  it('returns nothing for a comment-only file', () => {
    expect(splitStatements('-- nothing here\n')).toEqual([]);
  });
});

describe('bundled migrations', () => {
  it('loads in filename order', async () => {
    const migrations = await loadMigrations();
    expect(migrations.map((m) => m.name)).toEqual([
      '001_swaps.sql',
      '002_sol_usd_1m.sql',
      '003_ingest_checkpoints.sql',
      '004_mints.sql',
      '005_ingest_skips.sql',
    ]);
  });

  it('is re-runnable: every CREATE guards with IF NOT EXISTS', async () => {
    // ClickHouse has no transactional DDL, so a half-applied migration has to
    // be safe to run again from the top.
    for (const migration of await loadMigrations()) {
      for (const statement of splitStatements(migration.sql)) {
        expect(statement, `${migration.name}: ${statement.slice(0, 60)}`).toMatch(
          /^CREATE TABLE IF NOT EXISTS/i,
        );
      }
    }
  });

  it('checksums content, so an edited migration is detectable', async () => {
    const [first] = await loadMigrations();
    expect(first?.checksum).toMatch(/^[0-9a-f]{16}$/);
  });

  it('keeps the spec §5 sort-key prefix on swaps', async () => {
    // Spec §5 asks for ORDER BY (mint, slot). The key is extended to identify
    // a row uniquely, but the prefix has to stay or token range scans regress.
    const swaps = (await loadMigrations()).find((m) => m.name === '001_swaps.sql');
    expect(swaps?.sql).toMatch(/ORDER BY \(mint, slot,/);
  });
});
