/**
 * Design law 4 for the two ways a store can fail to open at all: the database
 * file is not readable SQLite (corrupt, truncated, or some other file), or the
 * native SQLite binding was never built (pnpm blocks dependency build scripts by
 * default; npm skips them with --ignore-scripts). Both used to surface as
 * INVALID_INPUT with "This was not a recognised Lacre error", which teaches an
 * agent nothing. Found by installing the packed @lacre/core tarball into a
 * fresh project.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli, type CliIO } from '../src/adapters/cli.js';
import { ERROR_CODES, toLacreError } from '../src/errors.js';
import { buildManifest } from '../src/registry/discover.js';

let root: string;

async function json(argv: string[]): Promise<{ code: number; body: Record<string, unknown> }> {
  let out = '';
  let err = '';
  const io: CliIO = { out: (t) => (out += t + '\n'), err: (t) => (err += t + '\n') };
  const code = await runCli([...argv, '--json'], io);
  return { code, body: JSON.parse(code === 0 ? out : err) as Record<string, unknown> };
}

interface ErrorBody {
  code: string;
  message: string;
  retryable: boolean;
  fix: { action?: string; note: string };
}
const errorOf = (body: Record<string, unknown>) => body.error as ErrorBody;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'lacre-store-errors-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('a store whose database file is not readable SQLite', () => {
  function garbageStore(): string {
    const dir = join(root, 'garbage');
    mkdirSync(dir);
    writeFileSync(join(dir, 'lacre.db'), Buffer.alloc(4096, 0x5a));
    return dir;
  }

  async function truncatedStore(): Promise<string> {
    const good = join(root, 'good');
    expect((await json(['init', '--store', good])).code).toBe(0);
    const dir = join(root, 'truncated');
    mkdirSync(dir);
    writeFileSync(join(dir, 'lacre.db'), readFileSync(join(good, 'lacre.db')).subarray(0, 2000));
    return dir;
  }

  it('chain verify exits 1 with STORE_UNREADABLE, not INVALID_INPUT', async () => {
    const r = await json(['chain', 'verify', '--store', garbageStore()]);
    expect(r.code).toBe(1);
    const e = errorOf(r.body);
    expect(e.code).toBe('STORE_UNREADABLE');
    expect(e.retryable).toBe(false);
  });

  it('teaches the fix: nothing was written, keep the file, restore from backup or point --store elsewhere', async () => {
    const e = errorOf((await json(['chain', 'verify', '--store', garbageStore()])).body);
    expect(e.fix.note).toMatch(/nothing was (written|read or written)/i);
    expect(e.fix.note).toMatch(/backup/i);
    expect(e.fix.note).toContain('--store');
    expect(e.fix.note).not.toContain('not a recognised Lacre error');
  });

  it('a truncated database is reported the same way', async () => {
    const r = await json(['receipts', 'query', '--store', await truncatedStore()]);
    expect(r.code).toBe(1);
    expect(errorOf(r.body).code).toBe('STORE_UNREADABLE');
  });

  it('keeps the SQLite message so the cause is still visible', async () => {
    const e = errorOf((await json(['chain', 'verify', '--store', garbageStore()])).body);
    expect(e.message).toMatch(/not a database|malformed/i);
  });
});

// SQLite treats a 0-byte file as an empty database, so without a check it would
// verify as a clean chain with 0 receipts, and migrating it would grow the file.
// A typo'd copy or a truncation to nothing would then look like a sound record.
describe('a store whose lacre.db is 0 bytes', () => {
  function emptyFileStore(): { dir: string; file: string } {
    const dir = join(root, 'empty');
    mkdirSync(dir);
    const file = join(dir, 'lacre.db');
    writeFileSync(file, '');
    return { dir, file };
  }

  it('chain verify --json exits non-zero with STORE_UNREADABLE, not a verified empty chain', async () => {
    const { dir } = emptyFileStore();
    const r = await json(['chain', 'verify', '--store', dir]);
    expect(r.code).not.toBe(0);
    expect(r.body.ok).toBe(false);
    const e = errorOf(r.body);
    expect(e.code).toBe('STORE_UNREADABLE');
    expect(e.retryable).toBe(false);
    expect(e.message).toMatch(/0 bytes/);
    expect(e.fix.note).toMatch(/backup/i);
  });

  it('leaves the file at 0 bytes and creates no WAL or shared-memory file', async () => {
    const { dir, file } = emptyFileStore();
    await json(['chain', 'verify', '--store', dir]);
    expect(statSync(file).size).toBe(0);
    expect(existsSync(`${file}-wal`)).toBe(false);
    expect(existsSync(`${file}-shm`)).toBe(false);
  });

  it('a write action is refused the same way and writes nothing', async () => {
    const { dir, file } = emptyFileStore();
    const r = await json(['record', '--store', dir, '--action', 'test.noop', '--action-detail', '{}']);
    expect(r.code).not.toBe(0);
    expect(errorOf(r.body).code).toBe('STORE_UNREADABLE');
    expect(statSync(file).size).toBe(0);
  });

  it('a store with no lacre.db at all is still NOT_INITIALIZED, and nothing is created', async () => {
    const dir = join(root, 'absent');
    mkdirSync(dir);
    const r = await json(['chain', 'verify', '--store', dir]);
    expect(r.code).not.toBe(0);
    expect(errorOf(r.body).code).toBe('NOT_INITIALIZED');
    expect(existsSync(join(dir, 'lacre.db'))).toBe(false);
  });
});

describe('the native SQLite binding is missing or built for another Node', () => {
  // The exact messages the `bindings` loader and Node print. The binding cannot
  // be removed from under the test process, so these drive toLacreError, the
  // single place every surface turns an untyped throw into a typed error.
  const missing = new Error(
    'Could not locate the bindings file. Tried:\n → /app/node_modules/better-sqlite3/build/better_sqlite3.node',
  );
  const wrongAbi = new Error(
    "The module '/app/node_modules/better-sqlite3/build/Release/better_sqlite3.node'\n" +
      'was compiled against a different Node.js version using\nNODE_MODULE_VERSION 127. This version of Node.js requires\n' +
      'NODE_MODULE_VERSION 137. Please try re-compiling or re-installing',
  );

  for (const [name, err] of [['missing binding', missing], ['binding built for another Node', wrongAbi]] as const) {
    it(`${name}: NATIVE_DEPENDENCY_MISSING, saying nothing ran and how to build it`, () => {
      const e = toLacreError(err).toJSON().error;
      expect(e.code).toBe('NATIVE_DEPENDENCY_MISSING');
      expect(e.retryable).toBe(false);
      expect(e.fix?.note).toMatch(/nothing was (executed|read or written)/i);
      expect(e.fix?.note).toContain('pnpm approve-builds');
      expect(e.fix?.note).toContain('npm rebuild better-sqlite3');
      expect(e.message).toContain('better-sqlite3');
    });
  }

  it('an unrelated error is still the generic fallback', () => {
    expect(toLacreError(new Error('something else')).code).toBe('INVALID_INPUT');
  });
});

describe('discover lists the new codes', () => {
  it('STORE_UNREADABLE and NATIVE_DEPENDENCY_MISSING are in the manifest', () => {
    const codes = (buildManifest() as { errors: { codes: string[] } }).errors.codes;
    expect(codes).toContain(ERROR_CODES.STORE_UNREADABLE);
    expect(codes).toContain(ERROR_CODES.NATIVE_DEPENDENCY_MISSING);
  });
});
