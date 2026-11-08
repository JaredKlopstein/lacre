import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { X509Certificate } from 'node:crypto';
import { verifyBundle, VERDICT_NAMES, type Bundle } from '../src/index.js';

/**
 * The verdict a human reads first, and the sentence under it.
 *
 * An auditor persona test found two problems. The same state had three names
 * across the CLI, the PDF and the HTML. And the conclusion said "the operator
 * could not have altered anything at or before that position", which is only
 * true from the anchor time on: an anchor made months after the actions says
 * nothing about whether they were rewritten before it.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const SAMPLE = join(HERE, '../../../examples/sample-evidence/evidence.json');
const G4 = new X509Certificate(readFileSync(join(HERE, 'fixtures/digicert-trusted-root-g4.pem')));
const sample = () => JSON.parse(readFileSync(SAMPLE, 'utf8')) as Bundle;

const ANCHOR_TIME = '2026-10-27T16:28:05.000Z';
const FIRST = '2026-10-27T16:28:00.135Z';
const LAST = '2026-10-27T16:28:01.000Z';

describe('one name per verdict state', () => {
  it('exports exactly the five canonical names', () => {
    expect(VERDICT_NAMES).toEqual([
      'VERIFIED / ANCHORED',
      'VERIFIED / ANCHORED / AUTHORITY NOT IN YOUR TRUST LIST',
      'VERIFIED / NOT ANCHORED',
      'VERIFICATION FAILED',
      'VERIFICATION FAILED / FORGERY DETECTED',
    ]);
  });

  it('names an anchor from a trusted authority VERIFIED / ANCHORED', () => {
    expect(verifyBundle(sample(), { trustAnchors: [G4] }).verdict).toBe('VERIFIED / ANCHORED');
  });

  it('names the first-run state, authority not yet trusted, as its own state', () => {
    expect(verifyBundle(sample()).verdict).toBe('VERIFIED / ANCHORED / AUTHORITY NOT IN YOUR TRUST LIST');
  });

  it('names a bundle with no anchors VERIFIED / NOT ANCHORED', () => {
    expect(verifyBundle({ ...sample(), anchors: [] }).verdict).toBe('VERIFIED / NOT ANCHORED');
  });

  it('names an edited receipt below the anchor VERIFICATION FAILED', () => {
    const b = sample();
    b.receipts[0]!.canonical_json = b.receipts[0]!.canonical_json.replace('"amount_usd":25', '"amount_usd":2500');
    expect(verifyBundle(b).verdict).toBe('VERIFICATION FAILED');
  });

  it('names an edit that breaks the anchored head VERIFICATION FAILED / FORGERY DETECTED', () => {
    const b = sample();
    b.receipts[2]!.canonical_json = b.receipts[2]!.canonical_json.replace('"amount_usd":75', '"amount_usd":7500');
    expect(verifyBundle(b).verdict).toBe('VERIFICATION FAILED / FORGERY DETECTED');
  });

  it('names an unreadable bundle VERIFICATION FAILED', () => {
    expect(verifyBundle({ format: 'nope' }).verdict).toBe('VERIFICATION FAILED');
  });
});

describe('the anchored conclusion says what the anchor time does and does not establish', () => {
  const trusted = verifyBundle(sample(), { trustAnchors: [G4] });
  const untrusted = verifyBundle(sample());

  it('no longer claims the operator could not have altered anything', () => {
    for (const v of [trusted, untrusted]) {
      expect(v.conclusion).not.toMatch(/could not have altered/);
    }
  });

  it('reports the receipt dates so they can be compared with the anchor time', () => {
    expect(trusted.receipt_time_range).toEqual({ first: FIRST, last: LAST });
    expect(trusted.conclusion).toContain(`dated ${FIRST} to ${LAST}`);
  });

  it('states the anchor time and the gap since the last receipt it covers', () => {
    expect(trusted.conclusion).toContain(ANCHOR_TIME);
    expect(trusted.conclusion).toMatch(/4 seconds after the last receipt it covers/);
  });

  it('says changes are ruled out only from the anchor time on', () => {
    expect(trusted.conclusion).toContain(`Nothing at or before seq 2 can have been changed after ${ANCHOR_TIME} without detection`);
    expect(trusted.conclusion).toMatch(/does not show the record was unchanged before/);
    expect(trusted.conclusion).toMatch(/compare .* with the dates of the actions you are auditing/);
  });

  it('says plainly that an untrusted authority does not establish who issued the timestamp', () => {
    expect(untrusted.conclusion).toMatch(/not in your trust list/);
    expect(untrusted.conclusion).toMatch(/does not yet establish who issued the timestamp/);
    expect(untrusted.conclusion).toMatch(/--trust/);
    expect(trusted.conclusion).not.toMatch(/not in your trust list/i);
  });

  it('describes the agent keys as coming from the bundle, not as registered', () => {
    for (const v of [trusted, untrusted]) {
      expect(v.conclusion).toMatch(/agent keys included in this bundle/);
      expect(v.conclusion).not.toMatch(/registered/);
    }
  });

  it('keeps the not-anchored conclusion explicit about self-attestation', () => {
    const v = verifyBundle({ ...sample(), anchors: [] });
    expect(v.conclusion).toMatch(/could have rebuilt this entire history/);
    expect(v.conclusion).toMatch(/self-attested/);
    expect(v.conclusion).toContain(`dated ${FIRST} to ${LAST}`);
  });

  it('does not warn about a gap of a few seconds', () => {
    expect(trusted.warnings.filter((w) => /after the last receipt it covers/.test(w))).toEqual([]);
  });
});
