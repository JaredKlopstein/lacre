import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { X509Certificate } from 'node:crypto';
import { verifyBundle, type Bundle } from '../src/index.js';
import { runVerify, type VerifyIO } from '../src/cli.js';

/**
 * Deleting the prefix of an anchored bundle used to verify.
 *
 * The hash chain cannot see a deleted prefix: the anchored head is the hash of
 * the last record, not an accumulator over all of them, so dropping earlier
 * records leaves it untouched, and the first receipt of a non-genesis bundle has
 * no predecessor in the bundle to link against. Both signals that could catch it
 * were off -- the declared `range` was never compared with the receipts present,
 * and the anchor's `receipt_count` check was skipped whenever the LOWEST SEQ
 * PRESENT was not 0, which a deletion is exactly what causes.
 *
 * Against the committed sample bundle -- three receipts, head timestamped by
 * DigiCert's production RFC 3161 authority -- deleting seq 0 returned
 * `VERIFIED / ANCHORED`, exit 0, "The authority is in your trust list", with one
 * warning saying the count check had been skipped. Deleting seq 0 and 1 did the
 * same, leaving a one-receipt bundle presented as an anchored three-receipt
 * chain, and `--require-trusted` passed it too.
 *
 * `checkRun` has always rejected the identical truncation of a run, because a
 * run must start at seq 0 with a null prev_hash. A bundle may legitimately cover
 * a partial range, so the equivalent of that rule is to hold a bundle to the
 * range it declares. These tests pin the cases demonstrated in the 1.0.0
 * pre-release audit.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const SAMPLE = join(HERE, '../../../examples/sample-evidence/evidence.json');
const G4_PEM = join(HERE, 'fixtures/digicert-trusted-root-g4.pem');
const G4 = new X509Certificate(readFileSync(G4_PEM));

const sample = () => JSON.parse(readFileSync(SAMPLE, 'utf8')) as Bundle;
const verify = (b: unknown) => verifyBundle(b, { trustAnchors: [G4] });
const kinds = (b: unknown) => verify(b).failures.map((f) => f.kind);

/** The sample with its first `n` receipts deleted and `range` left as it was. */
function prefixDeleted(n: number): Bundle {
  const b = sample();
  b.receipts = b.receipts.slice(n);
  return b;
}

const dir = mkdtempSync(join(tmpdir(), 'lacre-truncation-'));
const write = (name: string, b: unknown) => {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(b));
  return path;
};
function cli(argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const io: VerifyIO = { out: (s) => out.push(s), err: (s) => err.push(s) };
  return { code: runVerify(argv, io), out: out.join('\n'), err: err.join('\n') };
}
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('the sample bundle is still a valid anchored bundle', () => {
  it('verifies unmodified, so the rejections below are about the deletion', () => {
    const v = verify(sample());
    expect(v.failures).toEqual([]);
    expect(v.ok).toBe(true);
    expect(v.verdict).toBe('VERIFIED / ANCHORED');
    expect(v.anchored).toBe(true);
  });
});

describe('a deleted prefix is rejected', () => {
  beforeAll(() => {
    // Guard the premise: the deletion must leave the surviving receipts and the
    // anchored head untouched, or these tests would pass for the wrong reason.
    const b = prefixDeleted(1);
    expect(kinds(b)).not.toContain('HASH_MISMATCH');
    expect(kinds(b)).not.toContain('SIGNATURE_INVALID');
    expect(kinds(b)).not.toContain('ANCHOR_HEAD_MISMATCH');
  });

  for (const [label, n, lowest, held] of [
    ['seq 0 deleted', 1, 1, 2],
    ['seq 0 and 1 deleted, only the anchored head left', 2, 2, 1],
  ] as const) {
    describe(label, () => {
      const b = prefixDeleted(n);

      it('fails rather than verifying', () => {
        const v = verify(b);
        expect(v.ok).toBe(false);
        expect(v.verdict).toBe('VERIFICATION FAILED');
      });

      it('says the bundle does not carry the range it declares', () => {
        const f = verify(b).failures.find((x) => x.kind === 'SEQUENCE_GAP');
        expect(f).toBeDefined();
        expect(f).toMatchObject({ seq: lowest, expected: '0', actual: String(lowest) });
        expect(f!.message).toContain(`declares it starts at seq 0, but its lowest receipt is seq ${lowest}`);
        expect(f!.message).toContain(`${lowest} receipt(s) it claims to carry are missing`);
      });

      it('no longer skips the anchor count check, and that check fails too', () => {
        const v = verify(b);
        expect(v.warnings.join(' ')).not.toMatch(/receipt_count check skipped/);
        const f = v.failures.find((x) => x.kind === 'ANCHOR_COUNT_MISMATCH');
        expect(f).toBeDefined();
        expect(f).toMatchObject({ seq: 2, expected: '3', actual: String(held) });
        expect(f!.message).toContain(`commits to 3 receipt(s), but this bundle holds ${held} receipt(s)`);
      });

      it('exits 1 from the CLI, with and without --require-trusted', () => {
        const path = write(`prefix-deleted-${n}.json`, b);
        expect(cli([path, '--trust', G4_PEM]).code).toBe(1);
        expect(cli([path, '--trust', G4_PEM, '--require-trusted']).code).toBe(1);
        expect(cli([path, '--trust', G4_PEM]).out).toMatch(/VERIFICATION FAILED/);
      });
    });
  }
});

describe('a bundle that honestly declares a partial range still verifies', () => {
  // The distinction the fix turns on: a partial bundle is legitimate, a bundle
  // claiming a range it does not carry is not.
  const honest = (): Bundle => {
    const b = prefixDeleted(1);
    b.range = { from_seq: 1, to_seq: 2 };
    return b;
  };

  it('verifies, anchored, with no failures', () => {
    const v = verify(honest());
    expect(v.failures).toEqual([]);
    expect(v.ok).toBe(true);
    expect(v.verdict).toBe('VERIFIED / ANCHORED');
  });

  it('reports the range it really carries', () => {
    expect(verify(honest()).range).toEqual({ from_seq: 1, to_seq: 2 });
  });

  it('still says the anchor count check could not be reproduced from it', () => {
    expect(verify(honest()).warnings.join(' ')).toMatch(
      /anchor at seq 2: receipt_count check skipped, because this bundle does not declare that it starts at seq 0/,
    );
  });

  it('exits 0 from the CLI', () => {
    expect(cli([write('honest-partial.json', honest()), '--trust', G4_PEM]).code).toBe(0);
  });
});

describe('only the genesis receipt may claim to start the chain', () => {
  // The first receipt of a non-genesis bundle has no predecessor in the bundle,
  // so it cannot be linked. What is still checkable is that it does not present
  // itself as the chain's first record.
  it('rejects a null prev_hash on a receipt above seq 0', () => {
    const b = prefixDeleted(1);
    b.range = { from_seq: 1, to_seq: 2 };
    const first = JSON.parse(b.receipts[0]!.canonical_json) as Record<string, unknown>;
    first.prev_hash = null;
    b.receipts[0]!.canonical_json = JSON.stringify(first);
    const v = verify(b);
    expect(v.ok).toBe(false);
    expect(v.failures.map((f) => f.kind)).toContain('GENESIS_INVALID');
    const f = v.failures.find((x) => x.kind === 'GENESIS_INVALID')!;
    expect(f.message).toContain('the receipt at seq 1 has prev_hash null');
    expect(f.message).toContain('only the genesis receipt at seq 0 may have');
  });

  it('still requires the genesis receipt itself to have a null prev_hash', () => {
    const b = sample();
    const genesis = JSON.parse(b.receipts[0]!.canonical_json) as Record<string, unknown>;
    genesis.prev_hash = 'f'.repeat(64);
    b.receipts[0]!.canonical_json = JSON.stringify(genesis);
    expect(verify(b).failures.map((f) => f.kind)).toContain('GENESIS_INVALID');
  });
});

describe('what this fix deliberately leaves alone', () => {
  /**
   * Scope boundary, pinned so the behaviour is visible rather than assumed. The
   * audit raised three other ways the verifier reports exit 0 on a bundle it
   * could not fully check; none is fixed here, and none should be read as swept
   * up by this change.
   */
  it('a bundle with no receipts still verifies (open finding)', () => {
    const b = sample();
    b.receipts = [];
    const v = verify(b);
    expect(v.ok).toBe(true);
    expect(v.receipts_checked).toBe(0);
  });

  it('a tail truncated below the anchor still downgrades rather than failing (open finding)', () => {
    const b = sample();
    b.receipts = b.receipts.slice(0, 2);
    b.range = { from_seq: 0, to_seq: 1 };
    const v = verify(b);
    expect(v.ok).toBe(true);
    expect(v.verdict).toBe('VERIFIED / NOT ANCHORED');
  });

  it('an anchor with its proof stripped still downgrades rather than failing (open finding)', () => {
    const b = sample();
    b.anchors[0]!.proof = { type: 'none' };
    const v = verify(b);
    expect(v.ok).toBe(true);
    expect(v.verdict).toBe('VERIFIED / NOT ANCHORED');
  });
});
