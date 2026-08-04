import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * Finds a file by walking up from a starting directory.
 *
 * The CLI is launched through `pnpm --filter`, which runs it with the working
 * directory set to `apps/ingest`. A `.env` at the repository root — where
 * `.env.example` sits, and so where anyone following the README puts it — is two
 * levels above anything a relative path would find.
 */
function findUp(name: string, from: string): string | null {
  let dir = resolve(from);
  for (;;) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Loads the nearest `.env` into `process.env` and returns the path it used.
 *
 * Values already present in the real environment win. A `.env` is a convenience
 * for local runs; an exported variable, or one set by a process manager, is a
 * deliberate act and must not be silently replaced by a file on disk.
 *
 * `ENV_FILE` overrides the search entirely, which is what a systemd unit or a
 * container with several deployments in one tree wants.
 */
export function loadEnvFile(start: string = process.cwd()): string | null {
  const explicit = process.env['ENV_FILE'];
  const path = explicit ? resolve(explicit) : findUp('.env', start);
  if (path === null || !existsSync(path)) return null;

  const preset = { ...process.env };
  process.loadEnvFile(path);
  for (const [key, value] of Object.entries(preset)) {
    if (value !== undefined) process.env[key] = value;
  }
  return path;
}
