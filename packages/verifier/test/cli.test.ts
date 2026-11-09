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

  it('exits 2 on a file that is not JSON, with no verdict', () => {
    writeFileSync(path('not-json.json'), '{"format":');
    const r = cli([path('not-json.json'), '--json']);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/could not read/);
    const body = JSON.parse(r.out) as { ok: boolean; error: { code: string }; verdict?: string };
    expect(body).toMatchObject({ ok: false, error: { code: 'BUNDLE_UNREADABLE' } });
    expect(body.verdict).toBeUndefined();
  });

  // Fail closed: a JSON document that is not a bundle gets a verdict, so a
  // script reading stdout under --json always has one to read.
  it('exits 1 with a VERIFICATION FAILED verdict on JSON that is not a bundle', () => {
    writeFileSync(path('not-a-bundle.json'), '{"hello":"world"}');
    const r = cli([path('not-a-bundle.json'), '--json']);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out)).toMatchObject({ ok: false, verdict: 'VERIFICATION FAILED' });
    expect(r.out).toMatch(/unknown bundle format/);
  });

  it('exits 0 on --help and 2 with no arguments, describing every exit code', () => {
    const help = cli(['--help']);
    expect(help.code).toBe(0);
    expect(help.out).toMatch(/0 verified\s+1 verification failed\s+2 bundle unreadable or bad arguments/);
    // The help says where the line between 1 and 2 falls, naming each exit-2
    // code the CLI emits; the tests above and below pin the behavior itself.
    const exits = help.out.replace(/\s+/g, ' ');
    expect(exits).toContain('1 A VERIFICATION FAILED verdict saying why, including for valid JSON that is not a bundle.');
    expect(exits).toContain('2 No verdict. The bundle could not be read or is not JSON (BUNDLE_UNREADABLE)');
    expect(exits).toContain('a --trust file could not be read or holds no certificate (TRUST_FILE_UNREADABLE)');
    expect(exits).toContain('or an option was wrong (USAGE).');
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

describe('lacre-verify bundle mode: verdict banner', () => {
  const G4 = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'digicert-trusted-root-g4.pem');

  it('names the untrusted-authority state in the banner, not only in a note', () => {
    const r = cli([SAMPLE]);
    expect(r.out.split('\n')[1]).toBe('VERIFIED / ANCHORED / AUTHORITY NOT IN YOUR TRUST LIST');
  });

  it('prints VERIFIED / ANCHORED once the authority is trusted', () => {
    expect(cli([SAMPLE, '--trust', G4]).out.split('\n')[1]).toBe('VERIFIED / ANCHORED');
  });

  it('names a broken anchored head VERIFICATION FAILED / FORGERY DETECTED', () => {
    const b = JSON.parse(readFileSync(SAMPLE, 'utf8')) as { receipts: { canonical_json: string }[] };
    b.receipts[2]!.canonical_json = b.receipts[2]!.canonical_json.replace('"amount_usd":75', '"amount_usd":7500');
    writeFileSync(path('forged-head.json'), JSON.stringify(b));
    const r = cli([path('forged-head.json')]);
    expect(r.code).toBe(1);
    expect(r.out.split('\n')[1]).toBe('VERIFICATION FAILED / FORGERY DETECTED');
  });

  it('prints the receipt dates next to the range', () => {
    expect(cli([SAMPLE]).out).toMatch(/dated\s+2026-10-27T16:28:00\.135Z to 2026-10-27T16:28:01\.000Z/);
  });
});

describe('lacre-verify bundle mode: --require-trusted', () => {
  const G4 = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'digicert-trusted-root-g4.pem');
  const IMPOSTOR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'impostor-trusted-root-g4.pem');

  it('leaves the default exit code alone: an untrusted authority still exits 0', () => {
    expect(cli([SAMPLE]).code).toBe(0);
  });

  it('exits 1 when no trusted authority is pinned', () => {
    const r = cli([SAMPLE, '--require-trusted']);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/REQUIREMENT NOT MET: --require-trusted/);
    expect(r.out).toMatch(/--trust/);
  });

  it('exits 1 when the only anchor supplied is the wrong key', () => {
    expect(cli([SAMPLE, '--require-trusted', '--trust', IMPOSTOR]).code).toBe(1);
  });

  it('exits 1 for a bundle that is not anchored at all', () => {
    const b = JSON.parse(readFileSync(SAMPLE, 'utf8')) as Record<string, unknown>;
    writeFileSync(path('unanchored.json'), JSON.stringify({ ...b, anchors: [] }));
    expect(cli([path('unanchored.json'), '--require-trusted', '--trust', G4]).code).toBe(1);
  });

  it('exits 0 when the authority is trusted', () => {
    const r = cli([SAMPLE, '--require-trusted', '--trust', G4]);
    expect(r.code).toBe(0);
    expect(r.out).not.toMatch(/REQUIREMENT NOT MET/);
  });

  it('reports the requirement in the --json verdict', () => {
    const unmet = cli([SAMPLE, '--require-trusted', '--json']);
    expect(unmet.code).toBe(1);
    expect(JSON.parse(unmet.out)).toMatchObject({
      ok: true,
      require_trusted: { met: false, reason: expect.stringMatching(/--trust/) },
    });
    const met = cli([SAMPLE, '--require-trusted', '--trust', G4, '--json']);
    expect(met.code).toBe(0);
    expect(JSON.parse(met.out)).toMatchObject({ require_trusted: { met: true, reason: null } });
  });

  it('is documented in --help', () => {
    expect(cli(['--help']).out).toMatch(/--require-trusted/);
  });
});

describe('lacre-verify bundle mode: every error is JSON under --json', () => {
  it('reports an unreadable bundle as a JSON error with exit 2', () => {
    const r = cli([path('missing.json'), '--json']);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/could not read/);
    expect(JSON.parse(r.out)).toEqual({
      ok: false,
      error: { code: 'BUNDLE_UNREADABLE', message: expect.stringMatching(/could not read .*missing\.json/) },
    });
  });

  it('reports a bundle that is not JSON as a JSON error with exit 2', () => {
    writeFileSync(path('not-json.json'), 'this is not json');
    const r = cli([path('not-json.json'), '--json']);
    expect(r.code).toBe(2);
    expect(JSON.parse(r.out)).toMatchObject({ ok: false, error: { code: 'BUNDLE_UNREADABLE' } });
  });

  it('reports an unreadable trust file as a JSON error with exit 2', () => {
    const r = cli([SAMPLE, '--trust', path('no-such-root.pem'), '--json']);
    expect(r.code).toBe(2);
    expect(JSON.parse(r.out)).toMatchObject({ ok: false, error: { code: 'TRUST_FILE_UNREADABLE' } });
  });

  it('rejects a trust file that holds no certificate instead of silently trusting nothing', () => {
    writeFileSync(path('empty-root.pem'), 'not a certificate\n');
    const r = cli([SAMPLE, '--trust', path('empty-root.pem')]);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/no certificate/);
    expect(JSON.parse(cli([SAMPLE, '--trust', path('empty-root.pem'), '--json']).out))
      .toMatchObject({ ok: false, error: { code: 'TRUST_FILE_UNREADABLE' } });
  });

  it('accepts a DER certificate, which is how DigiCert serves .crt files', () => {
    const pem = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'digicert-trusted-root-g4.pem'), 'utf8');
    const der = Buffer.from(pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''), 'base64');
    writeFileSync(path('DigiCertTrustedRootG4.crt'), der);
    const r = cli([SAMPLE, '--trust', path('DigiCertTrustedRootG4.crt')]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/trusted by you: yes/);
  });
});
