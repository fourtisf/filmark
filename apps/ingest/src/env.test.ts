import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadEnvFile } from './env.js';

describe('loadEnvFile', () => {
  let root: string;
  let nested: string;
  const touched: string[] = [];

  const set = (key: string, value: string) => {
    touched.push(key);
    process.env[key] = value;
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'env-'));
    nested = join(root, 'apps', 'ingest');
    mkdirSync(nested, { recursive: true });
  });

  afterEach(() => {
    // Deletion, not assignment: process.env stringifies, so setting a variable
    // to undefined leaves the literal text "undefined" behind.
    for (const key of touched.splice(0)) Reflect.deleteProperty(process.env, key);
    Reflect.deleteProperty(process.env, 'ENV_FILE');
    rmSync(root, { recursive: true, force: true });
  });

  it('finds a .env in a parent directory', () => {
    // The failure this exists to prevent: pnpm --filter runs the CLI from
    // apps/ingest, and the .env the README asks for is at the repo root.
    writeFileSync(join(root, '.env'), 'ENV_TEST_RPC=https://rpc.example\n');
    touched.push('ENV_TEST_RPC');

    const used = loadEnvFile(nested);

    expect(used).toBe(join(root, '.env'));
    expect(process.env['ENV_TEST_RPC']).toBe('https://rpc.example');
  });

  it('does not overwrite a variable already in the environment', () => {
    set('ENV_TEST_RPC', 'https://exported.example');
    writeFileSync(join(root, '.env'), 'ENV_TEST_RPC=https://file.example\n');

    loadEnvFile(nested);

    expect(process.env['ENV_TEST_RPC']).toBe('https://exported.example');
  });

  it('prefers the nearest .env when both exist', () => {
    writeFileSync(join(root, '.env'), 'ENV_TEST_RPC=https://root.example\n');
    writeFileSync(join(nested, '.env'), 'ENV_TEST_RPC=https://nested.example\n');
    touched.push('ENV_TEST_RPC');

    expect(loadEnvFile(nested)).toBe(join(nested, '.env'));
    expect(process.env['ENV_TEST_RPC']).toBe('https://nested.example');
  });

  it('honours ENV_FILE over the search', () => {
    const elsewhere = join(root, 'deploy.env');
    writeFileSync(elsewhere, 'ENV_TEST_RPC=https://explicit.example\n');
    writeFileSync(join(nested, '.env'), 'ENV_TEST_RPC=https://nested.example\n');
    set('ENV_FILE', elsewhere);
    touched.push('ENV_TEST_RPC');

    expect(loadEnvFile(nested)).toBe(elsewhere);
    expect(process.env['ENV_TEST_RPC']).toBe('https://explicit.example');
  });

  it('returns null when there is no file to load', () => {
    expect(loadEnvFile(nested)).toBeNull();
  });
});
