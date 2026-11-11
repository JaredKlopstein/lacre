import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { metadata as layoutMetadata } from '../app/layout.js';
import HomePage, { metadata } from '../app/page.js';
import SecurityPage from '../app/security/page.js';
import { BRAND } from '../src/brand.js';
import {
  BUNDLE_CLOSED_LINE,
  BUNDLE_DELIVERY_BUSINESS_DAYS,
  BUNDLE_OPENS_SOON,
  BUNDLE_TODAY_ID,
  GETTING_STARTED_URL,
  OFF_SALE_PLANS,
  WAITLIST_HREF,
  priceCards,
} from '../src/plans.js';
import { PROOF_TABLE } from '../src/proof-table.js';
import { STANDARDS } from '../src/standards-strip.js';
import { fillLegalFacts, stubCheckoutEnv, stubSignInEnv } from './sale-env.js';

const html = renderToStaticMarkup(HomePage());

const unescape = (s: string) =>
  s.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** The visible text of the page, with tags stripped. */
const text = unescape(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ');

/** The hero's copy column: everything before the Exhibit A slot. */
const hero = /<section aria-labelledby="hero-title"[^>]*>[\s\S]*?(?=<div data-slot="exhibit")/.exec(html)?.[0] ?? '';

/** Each table body row as [property, local, anchored]. */
const tableRows = (page: string) =>
  [...(/<tbody>([\s\S]*?)<\/tbody>/.exec(page)?.[1] ?? '').matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map(([, row]) =>
    [...row!.matchAll(/<t[hd][^>]*>([^<]*)<\/t[hd]>/g)].map(([, cell]) => unescape(cell!)),
  );

describe('home page', () => {
  it('labels the getting-started link as leaving the site for GitHub', () => {
    expect(html).toContain(
      `<a href="${BRAND.repository}/blob/main/docs/getting-started.md">Getting started (GitHub)</a>`,
    );
  });

  it('leads with the approved H1 (D2) and a sub-line that does not say the free tier is timestamped (M4)', () => {
    expect(hero).toContain('<h1 id="hero-title">Your agent says it refunded $42.50. Prove it.</h1>');
    expect(unescape(hero).replace(/\s+/g, ' ')).toContain(
      '>Every consequential action gets a signed, hash-chained receipt. Anchor the chain with a timestamp from an authority you don’t control, and anyone can verify the record offline, without trusting you.</p>',
    );
    expect(text).not.toContain('receipt, timestamped by an authority');
  });

  it('puts a mono eyebrow above the H1 and the not-on-npm note under the buttons', () => {
    expect(hero).toMatch(/<span class="eyebrow">For teams running AI agents that touch money, mail or customer data<\/span><h1 /);
    expect(text).toContain('Open source (MIT). Packages are not on npm yet: run from source.');
  });

  it('qualifies the anchoring proof point: it applies only once you anchor (M4)', () => {
    const proofPoints = /<section aria-label="Proof points">[\s\S]*?<\/section>/.exec(html)?.[0] ?? '';
    expect(unescape(proofPoints)).toContain('When you anchor (with an evidence bundle), the chain head is timestamped');
  });

  it('shows the open standards in their own strip, with no logos, customers or counts', () => {
    const strip = /<section aria-label="Built on open standards"[^>]*>([\s\S]*?)<\/section>/.exec(html)?.[1] ?? '';
    expect([...strip.matchAll(/<li>([^<]+)<\/li>/g)].map((m) => m[1])).toEqual([...STANDARDS]);
    expect(STANDARDS).toEqual(['RFC 8785', 'SHA-256', 'Ed25519', 'RFC 9421', 'RFC 3161']);
    expect(strip).toContain('MIT-licensed core and verifier');
    expect(strip).toContain(`<a href="${BRAND.repository}">Source on GitHub</a>`);
    expect(strip).not.toMatch(/<img|<svg|customers?|trusted by|\d+\+? (teams|companies|users)/i);
    // The strip comes straight after the hero.
    expect(html.indexOf('aria-label="Built on open standards"')).toBeGreaterThan(html.indexOf('data-slot="exhibit"'));
  });

  it('lays the hero out as copy plus the Exhibit A slot', () => {
    expect(html).toMatch(/<div data-slot="exhibit"[^>]*><section aria-labelledby="exhibit-title"/);
  });

  it('keeps the standards out of the hero and in the proof points below it', () => {
    for (const standard of ['RFC 8785', 'SHA-256', 'Ed25519', 'RFC 3161']) {
      expect(hero).not.toContain(standard);
      const proofPoints = /<section aria-label="Proof points">[\s\S]*?<\/section>/.exec(html)?.[0] ?? '';
      expect(proofPoints).toContain(standard);
    }
  });

  it('says "AI agents", never "autonomous agents"', () => {
    expect(text).toContain('AI agents');
    expect(text).not.toMatch(/autonomous/i);
  });

  it('shows Exhibit A in the hero slot: three real receipts, the anchor, and the intact verdict server-rendered', () => {
    const slot = /<div data-slot="exhibit"[^>]*>([\s\S]*)<\/div><\/section>/.exec(html)?.[1] ?? '';
    expect(slot).toMatch(/^<section aria-labelledby="exhibit-title"/);
    expect(slot).toContain('<h2 id="exhibit-title">Exhibit A: live chain</h2>');
    expect(slot.match(/>SEQ \d</g)).toHaveLength(3);
    expect(slot).toContain('>ANCHOR<');
    expect(slot).toContain('<strong>Intact</strong>');
    expect(html.match(/id="exhibit-title"/g)).toHaveLength(1);
    // The static example is gone, and with it the page's only <pre> (7/9 adds one back).
    expect(html).not.toContain('aria-label="Example receipt"');
    expect(html).not.toMatch(/<pre[ >]/);
  });

  it('fetches and signs nothing on the server: Exhibit A hashes its static data in the browser', () => {
    const src = readFileSync(new URL('../app/page.tsx', import.meta.url), 'utf8');
    expect(src).not.toMatch(/\bfetch\(|\bawait\b|@lacre\/|packages\/core|\bsign\(/);
  });

  it('renders the limits table from the shared PROOF_TABLE under its own heading', () => {
    expect(html).toContain(
      '<h2 id="proof-table-title">Once anchored, history up to the anchor can’t be rewritten: not by your agents, and not by you.</h2>',
    );
    expect(tableRows(html)).toEqual(PROOF_TABLE.map((r) => [r.property, r.local, r.anchored]));
  });

  it('heads the table with a claim the table supports: scoped to anchored history', () => {
    // The old heading ("can’t rewrite, and neither can you") was contradicted by the "no" cells below it.
    expect(text).not.toContain('neither can you');
    expect(text).toContain('Before an anchor, a chain is self-attested');
    const rebuild = PROOF_TABLE.filter((r) => /rebuild/.test(r.property));
    expect(rebuild.map((r) => [r.property, r.anchored])).toEqual([
      ['Detects a full rebuild of anchored history by the operator', 'yes'],
      ['Detects a rebuild made before that history was anchored', 'no'],
    ]);
  });

  it('shares PROOF_TABLE with the security page, which renders the same rows unchanged', () => {
    expect(tableRows(renderToStaticMarkup(SecurityPage()))).toEqual(tableRows(html));
    expect(PROOF_TABLE.map((r) => [r.property, r.local, r.anchored])).toEqual([
      ['Detects casual tampering', 'yes', 'yes'],
      ['Detects a full rebuild of anchored history by the operator', 'no', 'yes'],
      ['Detects a rebuild made before that history was anchored', 'no', 'no'],
      ['Detects backdating after the anchor', 'no', 'yes'],
      ['Detects truncation of the un-anchored tail', 'no', 'no'],
    ]);
    for (const page of ['../app/page.tsx', '../app/security/page.tsx']) {
      const src = readFileSync(new URL(page, import.meta.url), 'utf8');
      expect(src).toMatch(/import \{ PROOF_TABLE \} from '[./]+src\/proof-table'/);
      expect(src).not.toMatch(/const PROOF_TABLE\b/);
    }
  });

  it('exports its own meta description, leaving the layout’s unchanged', () => {
    expect(metadata.description).toContain('tamper-evident receipts for AI agents');
    expect(layoutMetadata.description).toBe(`${BRAND.name}: ${BRAND.tagline}.`);
  });

  it('keeps the two hero buttons from #94 with the same labels and links', () => {
    const links = [...hero.matchAll(/<a href="([^"]+)">([^<]+)<\/a>/g)].map(([, href, label]) => ({ label, href }));
    expect(links).toEqual([
      { label: 'Start free', href: GETTING_STARTED_URL },
      { label: 'See pricing', href: '/pricing' },
    ]);
  });
  it('names every region by a heading on the page, never "Hero" or "Links"', () => {
    expect(html).not.toMatch(/aria-label="(Hero|Links)"/);
    const ids = [...html.matchAll(/<section aria-labelledby="([^"]+)"/g)].map((m) => m[1]!);
    expect(ids).toEqual(expect.arrayContaining(['hero-title', 'proof-table-title', 'today-title']));
    for (const id of ids) expect(html, id).toMatch(new RegExp(`<h[12] id="${id}">[^<]+</h[12]>`));
  });

  /** The "What you can get today" section's markup, and its text. */
  const today = /<section aria-labelledby="today-title">([\s\S]*?)<\/section>/.exec(html)?.[1] ?? '';
  const todayText = unescape(today.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ');

  it('says what you can get today: Core free from source, the bundle at its plans.ts price, Cloud early access', () => {
    expect(today).toContain('<h2 id="today-title">What you can get today</h2>');
    expect(todayText).toContain(`${BRAND.name} Core: free.`);
    expect(todayText).toContain('Run it from source: the packages are not on npm yet.');
    const bundle = priceCards('monthly').find((c) => c.id === 'bundle')!;
    // The default test environment has no legal facts, so bundles are closed and the
    // section says so instead of promising delivery (src/bundle-sale.ts).
    // Checkout-not-open comes first, so the price never reads as an offer.
    expect(todayText).toContain(
      `Evidence bundle: ${BUNDLE_OPENS_SOON.toLowerCase()}. ${BUNDLE_CLOSED_LINE} The planned price is ${bundle.price}, and your first bundle is free.`,
    );
    expect(todayText.indexOf(BUNDLE_CLOSED_LINE)).toBeLessThan(todayText.indexOf(bundle.price));
    expect(todayText).not.toContain(`Evidence bundle: ${bundle.price}`);
    expect(todayText).not.toContain(`within ${BUNDLE_DELIVERY_BUSINESS_DAYS} business days`);
    expect(today).toContain(`href="/pricing#${BUNDLE_TODAY_ID}"`);
    expect(today).toContain(`href="${WAITLIST_HREF}"`);
    if (OFF_SALE_PLANS.has('cloud')) {
      expect(todayText).toContain('Cloud: early access. Continuous anchoring is planned, not available yet.');
      expect(today).toContain(`href="${WAITLIST_HREF}"`);
    }
    // No price is typed into the page: it comes from plans.ts.
    expect(readFileSync(new URL('../app/page.tsx', import.meta.url), 'utf8')).not.toContain(bundle.price);
  });

  it('ends with a styled call-to-action pair, not a bare list of repository links', () => {
    expect(today).toMatch(/<p class="[^"]*ctas[^"]*"><a href="[^"]+">Getting started \(GitHub\)<\/a> <a href="\/verify">Verify a bundle<\/a><\/p>$/);
    expect(html).not.toContain(`<li><a href="${BRAND.repository}">Source on GitHub</a></li>`);
  });

  it('does not present Exhibit A’s anchor as checkable on the page, and says where it is', () => {
    const slot = /<div data-slot="exhibit"[^>]*>([\s\S]*)<\/div><\/section>/.exec(html)?.[1] ?? '';
    const note = unescape(slot.slice(slot.lastIndexOf('<p')).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ');
    expect(note).toContain('the anchor and the signatures can’t be checked here');
    expect(note).toContain('verify the sample bundle in the repository, a separate three-receipt chain');
    expect(slot).toContain('<a href="/verify">Verify a bundle</a>');
    expect(text).not.toMatch(/\breal (DigiCert|anchor|receipts)\b/i);
  });
});

describe('home page once bundles are open', () => {
  it('describes the bundle and its delivery, the way /pricing does', () => {
    const restore = fillLegalFacts();
    stubCheckoutEnv();
    stubSignInEnv();
    try {
      const open = renderToStaticMarkup(HomePage());
      const section = /<section aria-labelledby="today-title">([\s\S]*?)<\/section>/.exec(open)?.[1] ?? '';
      const words = unescape(section.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ');
      expect(words).toContain(`within ${BUNDLE_DELIVERY_BUSINESS_DAYS} business days`);
      expect(words).not.toContain(BUNDLE_OPENS_SOON);
      expect(words).not.toContain(BUNDLE_CLOSED_LINE);
    } finally {
      restore();
      vi.unstubAllEnvs();
    }
  });
});
