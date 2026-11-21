import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import CheckoutPage from '../app/checkout/page.js';
import HowItWorksPage from '../app/how-it-works/page.js';
import PricingPage from '../app/pricing/page.js';
import SecurityPage from '../app/security/page.js';
import {
  BUNDLE_DELIVERY_BUSINESS_DAYS,
  BUNDLE_FORMAT,
  BUNDLE_FULFILMENT,
  BUNDLE_TODAY_ID,
  OFF_SALE_PLANS,
  pricingAnnualOverageDisclosure,
} from '../src/plans.js';
import { fillLegalFacts, stubCheckoutEnv, stubSignInEnv } from './sale-env.js';

// The checkout page reads the request (to stay dynamic); no cookie, so no account.
vi.mock('next/headers', () => ({ headers: async () => new Headers() }));

/**
 * Honest copy pass (13): Cloud is never described as working while it is off
 * sale, the bundle is described one way everywhere, and the page says how a
 * bundle is actually made today (by hand: the buyer sends their chain file, never
 * their signing key, and gets the anchored bundle back by email).
 */

const unescape = (s: string) =>
  s.replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const text = (html: string) => unescape(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ');

const pages = {
  howItWorks: renderToStaticMarkup(HowItWorksPage()),
  security: renderToStaticMarkup(SecurityPage()),
  pricing: renderToStaticMarkup(await PricingPage({ searchParams: Promise.resolve({}) })),
  pricingAnnual: renderToStaticMarkup(await PricingPage({ searchParams: Promise.resolve({ billing: 'annual' }) })),
  checkout: renderToStaticMarkup(await CheckoutPage({ searchParams: Promise.resolve({}) })),
};

/**
 * The overclaims the November 2026 legal review took out (#255, #259), kept out.
 *
 * Each of these said more than Lacre's own Security, Verify and Terms pages
 * support, and each was replaced with copy Counsel approved. A sweep is the right
 * guard because the wording is not owned by one component: the same lines were
 * repeated across the home page, the Exhibit A panel, /how-it-works and the
 * GitHub Pages landing, and that repetition is how three of them survived the
 * first pass. Anything reintroducing one fails here rather than on a live page.
 *
 * Comment lines are stripped first, so a comment may still quote a removed
 * phrase to explain why it went -- exhibit-chain.tsx does exactly that.
 */
describe('the overclaims legal review removed stay removed', () => {
  const SURFACES = [
    'packages/site/app/page.tsx',
    'packages/site/app/how-it-works/page.tsx',
    'packages/site/app/security/page.tsx',
    'packages/site/app/pricing/page.tsx',
    'packages/site/app/verify/page.tsx',
    'packages/site/app/terms/page.tsx',
    'packages/site/app/privacy/page.tsx',
    'packages/site/src/exhibit-chain.tsx',
    'packages/site/src/plans.ts',
    'packages/site/src/proof-table.ts',
    'docs/index.html',
    'docs/demo.html',
  ] as const;

  /** Shipped text only: whole-line // and * and <!-- comments dropped. */
  const shipped = (file: string) =>
    readFileSync(new URL(`../../../${file}`, import.meta.url), 'utf8')
      .split('\n')
      .filter((line) => {
        const t = line.trim();
        return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('<!--'));
      })
      .join('\n');

  const BANNED: readonly (readonly [RegExp, string])[] = [
    [/\bProve it\b/i, 'claims proof of the action, not of the record (#255)'],
    [/without trusting (?:you|the operator)/i, 'verification still rests on the keys and the operator (#255, #259)'],
    [/no reason to trust/i, 'same claim, stronger wording (#259)'],
    [/can(?:'|\u2019)t be rewritten|cannot be rewritten/i, 'an anchor makes a change detectable, it does not prevent one (#255)'],
    [/quietly rewritten/i, 'same, and it omits the un-anchored tail (#259)'],
    [/Nothing has been altered/i, 'the demo checks links and the head, not signatures or the timestamp (#255)'],
    [/\bbackdated\b/i, 'overstates what the anchor covers (#259)'],
    [/tamper-proof|\bimmutable\b/i, 'Lacre is tamper-evident, not tamper-proof'],
    [/\badmissible\b|\bin court\b/i, 'no legal-grade claim is substantiated'],
    [/agents? actually did|prove what your agents/i, 'Lacre records what an agent reported (#259)'],
    [/makes it evidence/i, 'overstates what signing and anchoring deliver (#259)'],
  ];

  it('appears on no public surface', () => {
    for (const file of SURFACES) {
      const body = shipped(file);
      for (const [pattern, why] of BANNED) {
        expect(pattern.test(body), `${file} matches ${pattern}: ${why}`).toBe(false);
      }
    }
  });

  it('says the approved thing instead', () => {
    const home = shipped('packages/site/app/page.tsx');
    expect(home).toContain('Get a signed, tamper-evident record of what it reported.');
    expect(home).toContain('any change to history up to the anchor is detected');
    expect(home).toContain('Records added after the last anchor aren\u2019t covered until the next one.');

    const exhibit = shipped('packages/site/src/exhibit-chain.tsx');
    expect(exhibit).toContain('Signatures and the timestamp are not checked on this page.');

    // The stub at the Pages root carries the product title; the demo page beside
     // it is titled as what it is, and carries the recast body copy.
    expect(shipped('docs/index.html')).toContain(
      'Lacre \u2014 tamper-evident receipts for what your agents report',
    );
    expect(shipped('docs/demo.html')).toContain(
      'for signs that a record was changed, removed or reordered after it was signed',
    );
  });
});

describe('Cloud is never described as working', () => {
  it('no page says Cloud anchors, exports or batches in the present tense', () => {
    expect(OFF_SALE_PLANS.has('cloud')).toBe(true);
    for (const [name, html] of Object.entries(pages)) {
      const body = text(html);
      expect(body, name).not.toMatch(/\bCloud (anchors|exports|batches)\b/);
      expect(body, name).not.toMatch(/\bCloud \([^)]*\) (anchors|exports|batches)\b/);
      expect(body, name).not.toMatch(/\bOn Cloud, /);
    }
  });

  it('describes Cloud anchoring as planned and early access wherever it comes up', () => {
    expect(text(pages.howItWorks)).toContain('Cloud (early access, not available yet) is planned to anchor');
    expect(text(pages.security)).toContain('Cloud (early access, not available yet) is planned to anchor');
  });

  it('puts the annual overage disclosure in the future tense', () => {
    expect(pricingAnnualOverageDisclosure()).toMatch(/^When Cloud is available, .* will be charged /);
    expect(text(pages.pricingAnnual)).toContain(pricingAnnualOverageDisclosure());
    expect(text(pages.pricingAnnual)).not.toContain('billed to your card');
  });
});

describe('the evidence bundle, described one way', () => {
  it('uses the same format phrase on /how-it-works and /pricing, and no other', () => {
    expect(text(pages.howItWorks)).toContain(BUNDLE_FORMAT);
    expect(text(pages.pricing)).toContain(BUNDLE_FORMAT);
    for (const html of [pages.howItWorks, pages.pricing]) {
      expect(text(html)).not.toMatch(/human-readable report alongside|PDF and HTML renderings/);
    }
  });

  it('while bundles are closed, says how a bundle will be made, and never "today"', () => {
    // The default test environment has no legal facts, so the sale is closed (src/bundle-sale.ts).
    expect(pages.pricing).toContain(`anchored evidence bundles (<a href="#${BUNDLE_TODAY_ID}">how a bundle will be made</a>)`);
    expect(pages.pricing).toContain(`<h2 id="${BUNDLE_TODAY_ID}">How a bundle will be made</h2>`);
    expect(text(pages.pricing)).toContain(BUNDLE_FULFILMENT);
    expect(BUNDLE_FULFILMENT).toContain(`within ${BUNDLE_DELIVERY_BUSINESS_DAYS} business days`);
    for (const [name, html] of Object.entries(pages)) {
      expect(text(html), name).not.toMatch(/how a bundle is made today|Today (that happens|you get one) /i);
    }
    // Closed checkout links to the same section, worded the same way.
    expect(pages.checkout).toContain('<section data-sale="closed">');
    expect(pages.checkout).toContain(`<a href="/pricing#${BUNDLE_TODAY_ID}">how a bundle will be made</a>`);
    // Security: the RFC 3161 entry does not say you can buy a bundle now.
    expect(text(pages.security)).toContain(
      'will anchor the chain head when you buy an evidence bundle, once bundles open (nothing can be bought yet)',
    );
    expect(text(pages.security)).not.toMatch(/control anchor the chain head when you buy/);
    expect(text(pages.howItWorks)).toContain('once bundles open: we will anchor the head of the chain you send us. Nothing can be bought yet.');
    expect(text(pages.howItWorks)).toContain('Once bundles open, you will get one by buying a bundle');
  });

  it('once bundles are open, says how a bundle is made today', async () => {
    const restore = fillLegalFacts();
    stubCheckoutEnv();
    stubSignInEnv();
    try {
      const pricing = renderToStaticMarkup(await PricingPage({ searchParams: Promise.resolve({}) }));
      const howItWorks = text(renderToStaticMarkup(HowItWorksPage()));
      const security = text(renderToStaticMarkup(SecurityPage()));
      expect(security).toContain('control anchor the chain head when you buy an evidence bundle, and, once Cloud');
      expect(security).not.toContain('once bundles open');
      expect(pricing).toContain(`<h2 id="${BUNDLE_TODAY_ID}">How a bundle is made today</h2>`);
      expect(howItWorks).toContain('Today that happens when you buy an evidence bundle');
      expect(howItWorks).toContain('Today you get one by buying a bundle');
    } finally {
      restore();
      vi.unstubAllEnvs();
    }
  });

  it('never asks for a signing key and never overclaims the timestamp', () => {
    expect(BUNDLE_FULFILMENT).toContain('your signing key stays with you and we never ask for it');
    expect(BUNDLE_FULFILMENT).toContain('not earlier');
  });
});

describe('small fixes', () => {
  it('leaves the step numbers to the <ol> on /how-it-works', () => {
    expect(pages.howItWorks).not.toMatch(/<h2>\d+\. /);
    expect(pages.howItWorks).toContain('<ol role="list"><li data-reveal="true"><h2>Record</h2>');
  });

  it('spells behavior the US way, like the rest of the site', () => {
    for (const html of Object.values(pages)) expect(html).not.toMatch(/behaviour/i);
    expect(readFileSync(new URL('../app/security/page.tsx', import.meta.url), 'utf8')).not.toMatch(/behaviour/);
  });
});
