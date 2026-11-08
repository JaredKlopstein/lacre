/**
 * Correctness of what the CLI tells a script: a broken chain must not exit 0,
 * a dry run must apply idempotency exactly as the real call does, and a read
 * against a store that does not exist must fail closed instead of creating one.
 *
 * Each of these let a broken or empty record look verified to an automated
 * caller, which is the one thing this product exists to prevent.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { runCli, type CliIO } from '../src/adapters/cli.js';

let root: string;
let store: string;

async function run(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = '';
  let err = '';
  const io: CliIO = { out: (t) => (out += t + '\n'), err: (t) => (err += t + '\n') };
  const code = await runCli(argv, io);
  return { code, out, err };
}

/** Runs against `store`, with --json, and parses whichever stream carries the body. */
async function json(argv: string[], at: string = store): Promise<{ code: number; out: string; err: string; body: Record<string, unknown> }> {
  const r = await run([...argv, '--store', at, '--json']);
  return { ...r, body: JSON.parse(r.code === 0 ? r.out : r.err) as Record<string, unknown> };
}

const REFUND = ['record', '--action', 'refund.issue', '--action-detail', '{"customer_id":"c_8812","amount_cents":4250}', '--side-effect-class', 'irreversible'];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'lacre-correct-'));
  store = join(root, 'store');
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

// ------------------------------------------------------------ chain verify

/** Edit a stored receipt the way an operator with database access could. */
function tamper(seq: number): void {
  const db = new Database(join(store, 'lacre.db'));
  try {
    db.exec('DROP TRIGGER IF EXISTS receipts_no_update;');
    const row = db.prepare('SELECT canonical_json FROM receipts WHERE seq = ?').get(seq) as { canonical_json: string };
    const doctored = row.canonical_json.replace('"amount_cents":4250', '"amount_cents":999999');
    expect(doctored).not.toBe(row.canonical_json);
    db.prepare('UPDATE receipts SET canonical_json = ? WHERE seq = ?').run(doctored, seq);
  } finally {
    db.close();
  }
}

describe('chain verify on a tampered store', () => {
  beforeEach(async () => {
    expect((await json(['init'])).code).toBe(0);
    for (let i = 0; i < 3; i++) {
      expect((await json([...REFUND, '--idempotency-key', `refund-${i}`])).code).toBe(0);
    }
    tamper(1);
  });

  it('exits non-zero with a CHAIN_BROKEN error envelope and nothing on stdout', async () => {
    const r = await json(['chain', 'verify']);
    expect(r.code).toBe(1);
    expect(r.out).toBe('');
    const error = r.body.error as { code: string; message: string; retryable: boolean };
    expect(error.code).toBe('CHAIN_BROKEN');
    expect(error.retryable).toBe(false);
    expect(error.message).toMatch(/\bseq 1\b/);
  });

  it('keeps the full verification result in the error details', async () => {
    const r = await json(['chain', 'verify']);
    const details = (r.body.error as { details: { result: Record<string, unknown> } }).details;
    expect(details.result.ok).toBe(false);
    expect(details.result.receipts_checked).toBe(3);
    const failures = details.result.failures as Array<{ seq: number; kind: string }>;
    expect(failures.map((f) => f.seq)).toContain(1);
    expect(failures.map((f) => f.kind)).toContain('HASH_MISMATCH');
    expect(details.result.intact_ranges).toEqual(expect.arrayContaining([{ from_seq: 0, to_seq: 0 }]));
    expect(details.result.anchor_note).toMatch(/self-attested/);
    expect(details.result).toHaveProperty('head');
    expect(details.result).toHaveProperty('warnings');
  });

  it('teaches the fix: an executable query for the broken receipt', async () => {
    const r = await json(['chain', 'verify']);
    const fix = (r.body.error as { fix: { action: string; arguments: Record<string, unknown>; note: string } }).fix;
    expect(fix.action).toBe('receipts.query');
    expect(fix.arguments).toEqual({ from_seq: 1, to_seq: 1, depth: 'full' });
    expect(fix.note).toMatch(/backup/i);
    // The fix must itself run.
    const follow = await json(['receipts', 'query', '--from-seq', '1', '--to-seq', '1', '--depth', 'full']);
    expect(follow.code).toBe(0);
  });

  it('exits non-zero without --json too, naming the code', async () => {
    const r = await run(['chain', 'verify', '--store', store]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/CHAIN_BROKEN/);
  });

  it('a range that excludes the tampered receipt still verifies', async () => {
    const r = await json(['chain', 'verify', '--from', '2', '--to', '2']);
    expect(r.code).toBe(0);
    expect((r.body.result as { ok: boolean }).ok).toBe(true);
  });

  it('an untampered chain still exits 0 with ok true', async () => {
    const other = join(root, 'clean');
    await json(['init'], other);
    await json([...REFUND], other);
    const r = await json(['chain', 'verify'], other);
    expect(r.code).toBe(0);
    expect(r.body.ok).toBe(true);
    expect((r.body.result as { ok: boolean }).ok).toBe(true);
  });
});

// ------------------------------------------------------------ dry-run idempotency

describe('record --dry-run applies idempotency exactly as the real call does', () => {
  let original: { seq: number; self_hash: string; receipt: Record<string, unknown> };

  beforeEach(async () => {
    expect((await json(['init'])).code).toBe(0);
    const rec = await json([...REFUND, '--idempotency-key', 'refund-c_8812-0001']);
    expect(rec.code).toBe(0);
    original = rec.body.result as typeof original;
    expect(original.seq).toBe(0);
  });

  async function count(): Promise<number> {
    return ((await json(['chain', 'head'])).body.result as { count: number }).count;
  }

  it('reports the replay, with the existing receipt, for an already-used key', async () => {
    const dry = await json([...REFUND, '--idempotency-key', 'refund-c_8812-0001', '--dry-run']);
    expect(dry.code).toBe(0);
    const result = dry.body.result as typeof original & { replayed: boolean; dry_run: boolean };
    expect(result.replayed).toBe(true);
    expect(result.dry_run).toBe(true);
    expect(result.seq).toBe(0);
    expect(result.self_hash).toBe(original.self_hash);
    expect(result.receipt).toEqual(original.receipt);
    expect(await count()).toBe(1);
  });

  it('matches the real replay field for field, apart from dry_run', async () => {
    const dry = await json([...REFUND, '--idempotency-key', 'refund-c_8812-0001', '--dry-run']);
    const real = await json([...REFUND, '--idempotency-key', 'refund-c_8812-0001']);
    const { dry_run, ...dryRest } = dry.body.result as Record<string, unknown>;
    expect(dry_run).toBe(true);
    expect(dryRest).toEqual(real.body.result);
    expect(await count()).toBe(1);
  });

  it('ignores the same volatile fields the real call ignores', async () => {
    const dry = await json([...REFUND, '--idempotency-key', 'refund-c_8812-0001', '--latency-ms', '77', '--dry-run']);
    expect((dry.body.result as { replayed: boolean }).replayed).toBe(true);
  });

  it('raises IDEMPOTENCY_MISMATCH for a reused key with different arguments, as the real call does', async () => {
    const different = ['record', '--action', 'refund.issue', '--action-detail', '{"amount_cents":100}', '--idempotency-key', 'refund-c_8812-0001'];
    const dry = await json([...different, '--dry-run']);
    expect(dry.code).toBe(1);
    expect(dry.out).toBe('');
    const real = await json(different);
    expect(real.code).toBe(1);
    expect(dry.body).toEqual(real.body);
    expect((dry.body.error as { code: string }).code).toBe('IDEMPOTENCY_MISMATCH');
    expect(await count()).toBe(1);
  });

  it('still previews a new receipt for a key that has not been used', async () => {
    const dry = await json([...REFUND, '--idempotency-key', 'refund-c_8812-0002', '--dry-run']);
    const result = dry.body.result as { replayed: boolean; seq: number; prev_hash: string };
    expect(result.replayed).toBe(false);
    expect(result.seq).toBe(1);
    expect(result.prev_hash).toBe(original.self_hash);
    expect(await count()).toBe(1);
  });

  it('does not tell a replayed dry run to verify "after this write"', async () => {
    const dry = await json([...REFUND, '--idempotency-key', 'refund-c_8812-0001', '--dry-run']);
    const why = (dry.body.next_actions as Array<{ why: string }>).map((n) => n.why).join(' ');
    expect(why).not.toMatch(/after this write/);
    expect(why).toMatch(/nothing (new )?was written/i);
  });
});

// ------------------------------------------------------------ fail closed

const READS: Array<[string, string[]]> = [
  ['chain verify', ['chain', 'verify']],
  ['chain head', ['chain', 'head']],
  ['receipts query', ['receipts', 'query']],
  ['anchor list', ['anchor', 'list']],
  ['agent list', ['agent', 'list']],
];

function expectNotInitialized(body: Record<string, unknown>, path: string): void {
  const error = body.error as { code: string; message: string; fix: { action: string; note: string }; details: Record<string, unknown> };
  expect(error.code).toBe('NOT_INITIALIZED');
  expect(error.message).toContain(path);
  expect(error.message.toLowerCase()).toMatch(/nothing was (executed|written|created)/);
  expect(error.fix.action).toBe('init');
  expect(error.fix.note).toMatch(/LACRE_HOME/);
  expect(error.fix.note).toMatch(/--store/);
  expect(error.details.store).toBe(path);
}

describe('read commands fail closed on a store that does not exist', () => {
  it.each(READS)('%s on a missing directory raises NOT_INITIALIZED and creates nothing', async (_label, argv) => {
    const typo = join(root, 'typo-store');
    const r = await json(argv, typo);
    expect(r.code).toBe(1);
    expect(r.out).toBe('');
    expectNotInitialized(r.body, typo);
    expect(existsSync(typo)).toBe(false);
  });

  it.each(READS)('%s on an existing directory with no database raises NOT_INITIALIZED and writes nothing', async (_label, argv) => {
    const empty = mkdtempSync(join(root, 'empty-'));
    const r = await json(argv, empty);
    expect(r.code).toBe(1);
    expectNotInitialized(r.body, empty);
    expect(readdirSync(empty)).toEqual([]);
  });

  it('names the path resolved from a misspelled LACRE_HOME', async () => {
    const typo = join(root, 'lacre-hoem');
    vi.stubEnv('LACRE_HOME', typo);
    const r = await run(['chain', 'verify', '--json']);
    expect(r.code).toBe(1);
    expectNotInitialized(JSON.parse(r.err) as Record<string, unknown>, typo);
    expect(existsSync(typo)).toBe(false);
  });

  it('still reads a store once it is initialized', async () => {
    expect((await json(['init'])).code).toBe(0);
    for (const [, argv] of READS) expect((await json(argv)).code).toBe(0);
  });

  it('write commands keep creating the store', async () => {
    const fresh = join(root, 'fresh');
    expect((await json(['init'], fresh)).code).toBe(0);
    expect(existsSync(join(fresh, 'lacre.db'))).toBe(true);
  });

  it('a dry run on a missing store creates no files', async () => {
    const fresh = join(root, 'fresh');
    const r = await json(['init', '--dry-run'], fresh);
    expect(r.code).toBe(0);
    expect(existsSync(fresh)).toBe(false);
  });

  it('invalid arguments are reported before the store is touched', async () => {
    const typo = join(root, 'typo-store');
    const r = await json(['chain', 'verify', '--dry-run'], typo);
    expect((r.body.error as { code: string }).code).toBe('INVALID_INPUT');
    expect(existsSync(typo)).toBe(false);
  });
});
