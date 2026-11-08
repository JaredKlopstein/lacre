import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Bundle } from '@lacre/verifier';
import { bundleToHtml } from '../src/bundle/html.js';
import { VERIFY_GUIDE_URL, verifyCommand, establishes } from '../src/bundle/report-copy.js';
import { verifyBundle, VERDICT_NAMES } from '@lacre/verifier';

const SAMPLE = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../examples/sample-evidence/evidence.json',
);
const bundle = JSON.parse(readFileSync(SAMPLE, 'utf8')) as Bundle;

describe('HTML evidence report', () => {
  const html = bundleToHtml(bundle, { title: 'Q3 Agent Activity', organization: 'Acme Corp' });

  it('renders the verdict and the attesting authority', () => {
    expect(html).toContain('DigiCert');
    expect(html).toContain('Q3 Agent Activity');
  });

  it('does NOT claim settled proof when the authority is untrusted', () => {
    // The sample carries a real DigiCert token but no trust list. Calling that
    // "externally anchored" in the headline while the anchor row says "not in
    // your trust list" would contradict itself on the same page -- and would be
    // the exact overclaim the product exists to avoid.
    expect(html).toContain('<strong>VERIFIED / ANCHORED / AUTHORITY NOT IN YOUR TRUST LIST</strong>');
    expect(html).not.toContain('<strong>VERIFIED / ANCHORED</strong>');
    expect(html).toContain('not in your trust list');
    expect(html).toContain('It does not yet establish that the history is unaltered');
    // The fingerprint shown is the token's own chain top, so pinning it would
    // be trusting the bundle. The fix is the authority's root, from the authority.
    expect(html).not.toContain('--trust-fingerprint');
  });

  it('claims proof only once the authority is actually trusted', () => {
    const DIGICERT_ROOT_FP =
      '33846b545a49c9be4903c60e01713c1bd4e4ef31ea65cd95d69e62794f30b941';
    const trusted = bundleToHtml(bundle, { trustedFingerprints: [DIGICERT_ROOT_FP] });
    expect(trusted).toContain('<strong>VERIFIED / ANCHORED</strong>');
    expect(trusted).toContain('a timestamp authority you have told this tool to trust');
    // The footer used to carry its own label for this state; it now uses the one name.
    expect(trusted).toMatch(/<footer>[\s\S]*VERIFIED \/ ANCHORED\s*<\/footer>/);
  });

  it('states that the page is not the evidence', () => {
    // The framing is the product's integrity, not decoration. If this line ever
    // disappears we are selling a pretty page people mistake for proof.
    expect(html).toContain('This page is a summary, not the evidence');
    expect(html).toContain('carries no cryptography');
  });

  it('keeps the compliance disclaimer', () => {
    expect(html).toContain('not make anyone compliant');
    expect(html).toContain('not legal advice');
  });

  it('tells the reader how to check it without trusting the operator, with steps that work today', () => {
    // @lacre/verifier is not on npm yet, so an npx line fails on first contact.
    expect(html).not.toContain('npx');
    expect(html).toContain(VERIFY_GUIDE_URL);
    expect(html).toContain(verifyCommand('bundle.json').replace(/</g, '&lt;').replace(/>/g, '&gt;'));
    expect(html).toContain('without trusting whoever operates this');
  });

  it('shows the receipt dates and the anchor time side by side', () => {
    expect(html).toContain('Receipts dated');
    expect(html).toContain('2026-10-27T16:28:00.135Z');
    expect(html).toContain('2026-10-27T16:28:01.000Z');
    expect(html).toContain('Anchor time');
    expect(html).toContain('2026-10-27T16:28:05.000Z');
    expect(html).not.toContain('could not have altered');
  });

  it('describes the agent keys as coming from the bundle', () => {
    expect(html).toContain('agent public keys included in this bundle');
    expect(html).not.toContain('registered agent keys');
  });

  it('says what a verified bundle cannot show about the actions themselves', () => {
    expect(html).toContain('It does not establish that the actions happened as recorded, or that every action was recorded');
  });

  it('reports trust separately from validity', () => {
    // The sample is anchored by a real authority but carries no trust list.
    expect(html).toContain('In your trust list');
    expect(html).toContain('NO — confirm independently');
  });

  it('is fully self-contained: no external resource of any kind', () => {
    // An evidence report that phones out to a CDN cannot be opened in the
    // air-gapped room where audits actually happen.
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/https?:\/\/[^"'\s)]+\.(js|css|woff2?|png|jpg|svg)/i);
    expect(html).not.toMatch(/<link[^>]+rel=["']stylesheet/i);
    expect(html).not.toMatch(/@import/);
  });

  it('escapes attacker-controlled receipt content', () => {
    // Agents choose their own action names, and a hosted verifier page renders
    // bundles uploaded by strangers. Both are untrusted input.
    const hostile: Bundle = {
      ...bundle,
      chain_id: '<img src=x onerror=alert(1)>',
      summary: { ...(bundle.summary as object), by_action: { '<script>alert(1)</script>': 1 } },
    };
    const out = bundleToHtml(hostile);
    expect(out).not.toContain('<img src=x');
    expect(out).not.toContain('<script>alert(1)</script>');
    expect(out).toContain('&lt;script&gt;');
  });

  it('warns loudly when a bundle is not anchored', () => {
    const unanchored = bundleToHtml({ ...bundle, anchors: [] });
    expect(unanchored).toContain('<strong>VERIFIED / NOT ANCHORED</strong>');
    expect(unanchored).toContain('could have rebuilt');
    expect(unanchored).toContain('does NOT establish that the history is unaltered');
  });

  it('renders a failure report when the bundle is broken', () => {
    const broken: Bundle = {
      ...bundle,
      receipts: bundle.receipts.map((r, i) =>
        i === 1 ? { ...r, canonical_json: r.canonical_json.replace(/"amount_usd":\d+/, '"amount_usd":999999') } : r,
      ),
    };
    const out = bundleToHtml(broken);
    expect(out).toContain('<strong>VERIFICATION FAILED</strong>');
    expect(out).toContain('HASH_MISMATCH');
    expect(out).toContain('Still provably intact');
  });
});

describe('the PDF and HTML reports share one set of words', () => {
  const src = (f: string) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src', f), 'utf8');

  it('both take their headline, instructions and limits from report-copy', () => {
    for (const f of ['bundle/pdf.ts', 'bundle/html.ts']) {
      expect(src(f)).toContain("from './report-copy.js'");
      // The headline is the verifier's own verdict name, never a local variant.
      expect(src(f)).toMatch(/\.verdict\b/);
    }
  });

  it('no report source or export action tells anyone to npx an unpublished package', () => {
    for (const f of ['bundle/pdf.ts', 'bundle/html.ts', 'bundle/report-copy.ts', 'actions/bundle.ts']) {
      expect(src(f)).not.toMatch(/npx @lacre/);
    }
  });

  it('no report source calls the bundle\'s keys registered', () => {
    for (const f of ['bundle/pdf.ts', 'bundle/html.ts', 'bundle/report-copy.ts']) {
      expect(src(f)).not.toMatch(/registered agent keys/);
    }
  });

  it('points to the from-source steps in words that stay true after publishing', () => {
    expect(VERIFY_GUIDE_URL).toBe('https://github.com/JaredKlopstein/lacre/blob/main/docs/getting-started.md');
    expect(verifyCommand('out.json')).toBe('lacre-verify out.json --trust <authority-root.pem>');
  });

  it('gives every verdict state a limits section that never overclaims', () => {
    const states = [
      verifyBundle(bundle, { trustedFingerprints: ['33846b545a49c9be4903c60e01713c1bd4e4ef31ea65cd95d69e62794f30b941'] }),
      verifyBundle(bundle),
      verifyBundle({ ...bundle, anchors: [] }),
    ];
    expect(states.map((v) => v.verdict)).toEqual([VERDICT_NAMES[0], VERDICT_NAMES[1], VERDICT_NAMES[2]]);
    for (const v of states) {
      const text = establishes(v).map((b) => b.text).join(' ');
      expect(text).toContain('agent public keys included in this bundle');
      expect(text).toContain('does not establish that the actions happened as recorded');
      expect(text).toContain('not make anyone compliant');
    }
    // Only the trusted state claims the history is unaltered, and only since the anchor time.
    const trustedText = establishes(states[0]!).map((b) => b.text).join(' ');
    expect(trustedText).toMatch(/has not been altered since 2026-10-27T16:28:05\.000Z/);
    expect(trustedText).toMatch(/before that time/);
  });
});
