/**
 * Design law 4: every error teaches its own fix. These pin the cases an
 * agent-as-user test found teaching nothing: bad JSON in an option, a
 * validation error that did not say which option or what type, an error
 * envelope with no `ok`, a manifest quickstart whose CLI line disagreed with
 * its own arguments, and a noop anchor that did not say it proves nothing.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli, type CliIO } from '../src/adapters/cli.js';

let store: string;

async function run(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = '';
  let err = '';
  const io: CliIO = { out: (t) => (out += t + '\n'), err: (t) => (err += t + '\n') };
  const code = await runCli([...argv, '--store', store], io);
  return { code, out, err };
}

async function json(argv: string[]): Promise<{ code: number; body: Record<string, unknown> }> {
  const r = await run([...argv, '--json']);
  return { code: r.code, body: JSON.parse(r.code === 0 ? r.out : r.err) as Record<string, unknown> };
}

interface ErrorBody {
  code: string;
  message: string;
  fix: { action?: string; arguments?: Record<string, unknown>; note: string };
  details?: Record<string, unknown>;
}

const errorOf = (body: Record<string, unknown>) => body.error as ErrorBody;

beforeEach(async () => {
  store = mkdtempSync(join(tmpdir(), 'lacre-teach-'));
  expect((await json(['init'])).code).toBe(0);
});
afterEach(() => rmSync(store, { recursive: true, force: true }));

describe('invalid JSON in an option', () => {
  it('names --action-detail and shows a valid example, and nothing is executed', async () => {
    const r = await json(['record', '--action', 'refund.issue', '--action-detail', '{customer_id:c1}']);
    expect(r.code).toBe(1);
    const e = errorOf(r.body);
    expect(e.code).toBe('INVALID_INPUT');
    expect(e.message).toContain('--action-detail');
    expect(e.message).toMatch(/not valid JSON/i);
    expect(e.message.toLowerCase()).toContain('nothing was executed');
    expect(e.details).toMatchObject({ option: '--action-detail', field: 'action_detail' });

    // The example in the fix is itself valid JSON, quoted for a shell.
    const example = e.fix.note.match(/--action-detail '([^']+)'/);
    expect(example).not.toBeNull();
    expect(() => JSON.parse(example![1]!)).not.toThrow();
    expect(e.fix.action).toBe('record');
    // No ready-to-run arguments: running an example value would record made-up facts.
    expect(e.fix.arguments).toBeUndefined();

    expect(((await json(['chain', 'head'])).body.result as { count: number }).count).toBe(0);
  });

  it('names an array option too', async () => {
    const r = await json(['receipts', 'query', '--fields', '[seq,']);
    const e = errorOf(r.body);
    expect(e.code).toBe('INVALID_INPUT');
    expect(e.message).toContain('--fields');
    expect(e.fix.note).toMatch(/--fields/);
  });
});

describe('validation errors name the option and the expected type', () => {
  it('a missing required option', async () => {
    const e = errorOf((await json(['record'])).body);
    expect(e.code).toBe('INVALID_INPUT');
    expect(e.message).toContain('--action');
    expect(e.message).toMatch(/expected string/);
    expect(e.details?.fields).toEqual([
      expect.objectContaining({ field: 'action', option: '--action', expected: 'string' }),
    ]);
  });

  it('a value outside an enum lists the allowed values', async () => {
    const e = errorOf((await json(['record', '--action', 'x', '--side-effect-class', 'money'])).body);
    expect(e.message).toContain('--side-effect-class');
    expect(e.message).toContain('one of "read" | "write" | "irreversible"');
    expect(e.message).toContain('"money"');
    expect(e.details?.fields).toEqual([
      expect.objectContaining({ field: 'side_effect_class', expected: 'one of "read" | "write" | "irreversible"' }),
    ]);
  });

  it('a value of the wrong type', async () => {
    const e = errorOf((await json(['record', '--action', 'x', '--risk-score', 'high'])).body);
    expect(e.message).toContain('--risk-score');
    expect(e.message).toMatch(/expected number/);
  });
});

describe('error envelopes carry ok: false', () => {
  it.each([
    ['an unknown command', ['nope']],
    ['a validation error', ['record']],
    ['an unknown option', ['record', '--action', 'x', '--dryrun']],
    ['bad JSON', ['record', '--action', 'x', '--action-detail', '{']],
  ])('%s', async (_label, argv) => {
    const r = await json(argv);
    expect(r.code).toBe(1);
    expect(r.body.ok).toBe(false);
    expect(errorOf(r.body).code).toBeTruthy();
  });

  it('the manifest documents ok: false in the error shape', async () => {
    const manifest = JSON.parse((await run(['discover'])).out) as { errors: { shape: Record<string, unknown> } };
    expect(manifest.errors.shape.ok).toBe(false);
  });
});

describe('the manifest agrees with the CLI', () => {
  let manifest: Record<string, any>;
  beforeEach(async () => {
    manifest = JSON.parse((await run(['discover', '--json'])).out);
  });

  it('says discover returns the bare manifest, which is what it does', () => {
    expect(manifest).not.toHaveProperty('ok');
    expect(manifest.success.note).toMatch(/discover/);
    expect(manifest.success.note).toMatch(/bare manifest|not wrapped/i);
  });

  it('every quickstart cli line passes every argument its step lists', () => {
    for (const step of manifest.quickstart as Array<{ cli: string; arguments: Record<string, unknown> }>) {
      for (const key of Object.keys(step.arguments)) {
        expect(step.cli, `step cli is missing --${key.replace(/_/g, '-')}`).toContain(`--${key.replace(/_/g, '-')}`);
      }
    }
  });

  it('the write step uses an idempotency key', () => {
    const write = (manifest.quickstart as Array<{ step: number; cli: string }>).find((s) => s.step === 3)!;
    expect(write.cli).toContain('--idempotency-key refund-0001');
  });

  it('does not claim the website serves HTTP endpoints', () => {
    expect(manifest.auth.endpoints_note).toMatch(/collector/i);
    expect(manifest.auth.endpoints_note).toMatch(/website/i);
    expect(manifest.auth.endpoints_note).toMatch(/lacre discover --json/);
  });
});

describe('a noop anchor says plainly that it proves nothing', () => {
  beforeEach(async () => {
    await json(['record', '--action', 'refund.issue']);
  });

  it('anchor now', async () => {
    const r = await json(['anchor', 'now']);
    expect(r.code).toBe(0);
    const note = (r.body.result as { note: string; is_external: boolean }).note;
    expect((r.body.result as { is_external: boolean }).is_external).toBe(false);
    expect(note).toMatch(/proves nothing/i);
    expect(note).toMatch(/RFC 3161/);
    expect(note).toMatch(/open-source build/i);
    expect(note).toMatch(/Lacre Cloud/);
  });

  it('anchor now --dry-run', async () => {
    const note = ((await json(['anchor', 'now', '--dry-run'])).body.result as { note: string }).note;
    expect(note).toMatch(/proves nothing/i);
    expect(note).toMatch(/RFC 3161/);
  });
});
