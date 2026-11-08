import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { runVerify, type VerifyIO } from '../src/cli.js';

/**
 * The exit code is the CI contract, so bundle mode is driven end to end
 * through runVerify against the committed sample bundle -- a real anchored
 * bundle -- with no network and nothing from core or cloud.
 */
const SAMPLE = join(dirname(fileURLToPath(import.meta.url)), '../../../examples/sample-evidence/evidence.json');

function cli(argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const io: VerifyIO = { out: (s) => out.push(s), err: (s) => err.push(s) };
  const code = runVerify(argv, io);
  return { code, out: out.join('\n'), err: err.join('\n') };
}

const dir = mkdtempSync(join(tmpdir(), 'lacre-cli-'));
const path = (n: string) => join(dir, n);

beforeAll(() => {
  const bundle = JSON.parse(readFileSync(SAMPLE, 'utf8')) as { receipts: { canonical_json: string }[] };
  const before = bundle.receipts[1]!.canonical_json;
  bundle.receipts[1]!.canonical_json = before.replace('"amount_usd":50', '"amount_usd":5000');
  expect(bundle.receipts[1]!.canonical_json).not.toBe(before);
  writeFileSync(path('tampered.json'), JSON.stringify(bundle));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('lacre-verify bundle mode: existing behavior', () => {
  it('exits 0 on the valid sample bundle', () => {
    const r = cli([SAMPLE]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/VERIFIED \/ ANCHORED/);
    expect(r.err).toBe('');
  });

  it('exits 0 with a JSON verdict under --json', () => {
    const r = cli([SAMPLE, '--json']);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ ok: true, anchored: true });
  });

  it('applies a well-formed --trust-fingerprint and --backdate-tolerance-ms', () => {
    const untrusted = JSON.parse(cli([SAMPLE, '--json']).out) as {
      anchors: { timestamp: { trusted: boolean; chain: { top: { fingerprint_sha256: string } } } }[];
    };
    expect(untrusted.anchors[0]!.timestamp.trusted).toBe(false);
    const fp = untrusted.anchors[0]!.timestamp.chain.top.fingerprint_sha256;

    const r = cli(['--trust-fingerprint', fp, '--backdate-tolerance-ms', '0', SAMPLE, '--json']);
    expect(r.code).toBe(0);
    const v = JSON.parse(r.out) as typeof untrusted;
    expect(v.anchors[0]!.timestamp.trusted).toBe(true);
  });

  it('exits 1 on a copy with one canonical_json value edited', () => {
    const r = cli([path('tampered.json')]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/VERIFICATION FAILED/);
    expect(r.out).toMatch(/HASH_MISMATCH/);
    expect(JSON.parse(cli([path('tampered.json'), '--json']).out)).toMatchObject({ ok: false });
  });

  it('exits 2 on an unreadable path', () => {
    const r = cli([path('missing.json')]);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/could not read/);
    expect(r.out).toBe('');
  });

  it('exits 0 on --help and 2 with no arguments, describing every exit code', () => {
    const help = cli(['--help']);
    expect(help.code).toBe(0);
    expect(help.out).toMatch(/0 verified\s+1 verification failed\s+2 bundle unreadable or bad arguments/);
    const none = cli([]);
    expect(none.code).toBe(2);
    expect(none.out).toMatch(/lacre-verify <bundle\.json> \[options\]/);
  });
});

describe('lacre-verify bundle mode: usage errors exit 2 without a verdict', () => {
  const cases: { name: string; argv: string[]; names: RegExp }[] = [
    { name: 'an unknown option', argv: [SAMPLE, '--trusted', 'x.pem'], names: /unknown option '--trusted'.*--trust,/ },
    { name: '--trust with no value', argv: [SAMPLE, '--trust'], names: /--trust needs a value/ },
    { name: '--trust followed by another option', argv: ['--trust', '--trust-fingerprint', 'x', SAMPLE], names: /--trust needs a value/ },
    { name: '--trust-fingerprint with no value', argv: [SAMPLE, '--trust-fingerprint'], names: /--trust-fingerprint needs a value/ },
    { name: '--backdate-tolerance-ms with no value', argv: [SAMPLE, '--backdate-tolerance-ms'], names: /--backdate-tolerance-ms needs a value/ },
    { name: 'a non-numeric tolerance', argv: [SAMPLE, '--backdate-tolerance-ms', 'abc'], names: /--backdate-tolerance-ms must be a non-negative integer.*'abc'/ },
    { name: 'a negative tolerance', argv: [SAMPLE, '--backdate-tolerance-ms', '-5'], names: /--backdate-tolerance-ms must be a non-negative integer.*'-5'/ },
    { name: 'a fractional tolerance', argv: [SAMPLE, '--backdate-tolerance-ms', '1.5'], names: /--backdate-tolerance-ms must be a non-negative integer/ },
    { name: 'two bundle paths', argv: [SAMPLE, path('tampered.json')], names: /unexpected argument .*tampered\.json.*exactly one bundle file/ },
    { name: 'a fingerprint that is not hex', argv: [SAMPLE, '--trust-fingerprint', 'nonsense'], names: /--trust-fingerprint 'nonsense' is not a SHA-256 certificate fingerprint: expected 64 hexadecimal characters/ },
    { name: 'a fingerprint of the wrong length', argv: [SAMPLE, '--trust-fingerprint', 'abcd'], names: /--trust-fingerprint 'abcd' is not a SHA-256 .*got 4/ },
    { name: 'a SHA-1 thumbprint', argv: [SAMPLE, '--trust-fingerprint', 'ddfb16cd4931c973a2037d3fc83a4d7d775d05e4'], names: /SHA-1/ },
  ];

  for (const c of cases) {
    it(`rejects ${c.name}`, () => {
      const r = cli(c.argv);
      expect(r.code).toBe(2);
      expect(r.err).toMatch(c.names);
      expect(r.err.split('\n')).toHaveLength(1);
      expect(r.out).toBe('');
    });

    it(`rejects ${c.name} with a USAGE object under --json`, () => {
      const argv = c.argv.includes('--json') ? c.argv : [...c.argv, '--json'];
      const r = cli(argv);
      expect(r.code).toBe(2);
      expect(r.err).toMatch(c.names);
      const body = JSON.parse(r.out) as { ok: boolean; error: { code: string; message: string } };
      expect(body).toEqual({ ok: false, error: { code: 'USAGE', message: expect.stringMatching(c.names) } });
      expect(body).not.toHaveProperty('anchors');
    });
  }

  it('reports a missing bundle file as a USAGE error under --json', () => {
    const r = cli(['--json']);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/no bundle file given/);
    expect(JSON.parse(r.out)).toMatchObject({ ok: false, error: { code: 'USAGE' } });
  });
});

describe('lacre-verify bundle mode: trust anchors', () => {
  const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
  const SELF_SIGNED_G4 = join(FIX, 'digicert-trusted-root-g4.pem');
  const IMPOSTOR_G4 = join(FIX, 'impostor-trusted-root-g4.pem');
  const SELF_SIGNED_FP = '552f7bdcf1a7af9e6ce672017f4f12abf77240c78e761ac203d1d9d20ac89988';

  it('trusts the sample bundle under the self-signed G4 root DigiCert publishes', () => {
    const r = cli([SAMPLE, '--trust', SELF_SIGNED_G4]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/trusted by you: yes/);
    // The reader can compare this with DigiCert's published fingerprint.
    expect(r.out).toContain(SELF_SIGNED_FP);
    const v = JSON.parse(cli([SAMPLE, '--trust', SELF_SIGNED_G4, '--json']).out) as {
      anchor_authority_trusted: boolean;
    };
    expect(v.anchor_authority_trusted).toBe(true);
  });

  it('does not trust it under an impostor with the same subject and another key', () => {
    const r = cli([SAMPLE, '--trust', IMPOSTOR_G4]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/trusted by you: NO/);
  });

  it('shows who issued the chain top, so a cross-signed root is visible as one', () => {
    const r = cli([SAMPLE]);
    expect(r.out).toMatch(/chain top\s+: .*CN=DigiCert Trusted Root G4/);
    expect(r.out).toMatch(/issued by\s+: .*CN=DigiCert Assured ID Root CA/);
  });

  it('explains why a pin of a certificate the token does not carry cannot match', () => {
    const r = cli([SAMPLE, '--trust-fingerprint', SELF_SIGNED_FP]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/trusted by you: NO/);
    expect(r.out).toMatch(/matched no certificate on this chain/);
    expect(r.out).toMatch(/pass the root certificate itself with --trust/);
  });
});
