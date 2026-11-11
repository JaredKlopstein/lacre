import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { PRICE_ENV } from '@lacre/cloud/dist/billing/config.js';
import { bundleSale } from '../src/bundle-sale.js';
import { LEGAL, missingFacts } from '../src/legal.js';
import PricingPage from '../app/pricing/page.js';
import { TEST_FACTS, clearLegalFacts, clearSaleEnv, fillLegalFacts, stubCheckoutEnv, stubSignInEnv } from './sale-env.js';

/**
 * Whether a bundle can be bought here: the legal facts filled in, checkout
 * configured and sign-in configured, all three, read from LEGAL and the
 * environment on each call. Production today has DATABASE_URL and nothing else,
 * so it must read as closed.
 */

let restoreFacts: (() => void) | null = null;
const logged: string[] = [];

beforeEach(() => {
  logged.length = 0;
  for (const level of ['error', 'warn', 'log', 'info', 'debug'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(' ')));
  }
  clearSaleEnv();
});
afterEach(() => {
  restoreFacts?.();
  restoreFacts = null;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const open = () => {
  restoreFacts = fillLegalFacts();
  stubCheckoutEnv();
  stubSignInEnv();
};

describe('bundle sale', () => {
  it('is closed while any legal fact is missing, even with checkout and sign-in configured', () => {
    restoreFacts = clearLegalFacts();
    expect(missingFacts(LEGAL).length).toBeGreaterThan(0);
    stubCheckoutEnv();
    stubSignInEnv();
    expect(bundleSale()).toEqual({ open: false, blockers: ['terms'] });
  });

  it('as shipped, every legal fact is supplied, so only checkout and sign-in block the sale', () => {
    expect(missingFacts(LEGAL)).toEqual([]);
    expect(bundleSale({})).toEqual({ open: false, blockers: ['checkout', 'sign-in'] });
  });

  it('is closed with only DATABASE_URL set, as production is today', () => {
    restoreFacts = fillLegalFacts();
    vi.stubEnv('DATABASE_URL', 'postgresql://test-user:test-password@db.site.test/site');
    vi.stubEnv('VERCEL_URL', 'site.example.test');
    expect(bundleSale()).toEqual({ open: false, blockers: ['checkout', 'sign-in'] });
    expect(bundleSale(process.env, LEGAL).open).toBe(false);
  });

  it('opens by itself once the facts, checkout and sign-in are all in place', () => {
    open();
    expect(bundleSale()).toEqual({ open: true, blockers: [] });
  });

  it('closes again when any one checkout variable is missing', () => {
    for (const name of ['STRIPE_SECRET_KEY', PRICE_ENV.payg_bundle, PRICE_ENV.cloud_month, 'DATABASE_URL', 'SITE_BASE_URL']) {
      open();
      vi.stubEnv(name, '');
      expect(bundleSale().blockers, name).toContain('checkout');
      restoreFacts?.();
      vi.unstubAllEnvs();
    }
  });

  it("follows cloud's own checkout config: a live key without live mode keeps checkout closed", () => {
    open();
    vi.stubEnv('STRIPE_SECRET_KEY', ['sk', 'live', 'y'.repeat(24)].join('_'));
    expect(bundleSale().blockers).toEqual(['checkout']);
  });

  it('closes when sign-in is off or any auth variable is missing', () => {
    for (const [name, value] of [
      ['MAGIC_LINK_ENABLED', ''],
      ['MAGIC_LINK_ENABLED', 'true'],
      ['SESSION_SECRET', ''],
      ['EMAIL_API_URL', ''],
      ['EMAIL_API_KEY', ''],
      ['EMAIL_FROM', ''],
    ] as const) {
      open();
      vi.stubEnv(name, value);
      expect(bundleSale().blockers, `${name}=${value}`).toEqual(['sign-in']);
      restoreFacts?.();
      vi.unstubAllEnvs();
    }
  });

  it('closes when any one required legal fact is null', () => {
    open();
    expect(bundleSale(process.env, { ...TEST_FACTS, refundWindowDays: null }).blockers).toEqual(['terms']);
    expect(bundleSale(process.env, { ...TEST_FACTS, entityName: null }).blockers).toEqual(['terms']);
  });

  it('logs nothing and names no variable, however it is configured', () => {
    expect(bundleSale().open).toBe(false);
    open();
    expect(bundleSale().open).toBe(true);
    expect(logged).toEqual([]);
  });
});

describe('the pricing page follows the sale', () => {
  const render = async () => renderToStaticMarkup(await PricingPage({ searchParams: Promise.resolve({}) }));
  const bundle = (html: string) => /<article data-tier="bundle">([\s\S]*?)<\/article>/.exec(html)?.[1] ?? '';

  it('closed: says bundles open soon and offers the waitlist, never checkout', async () => {
    const card = bundle(await render());
    expect(card).toContain('<p data-status="opens-soon"><strong>Bundles open soon</strong>: Checkout is not open yet');
    expect(card).toContain('<p data-badge="true">Opens soon</p>');
    expect(card).toContain('<a href="/pricing#waitlist">Tell me when bundles open</a>');
    expect(card).not.toContain('/checkout');
  });

  it('open: the same card offers Buy a bundle at /checkout', async () => {
    open();
    const card = bundle(await render());
    expect(card).toContain('<a href="/checkout">Buy a bundle</a>');
    expect(card).toContain('<p data-badge="true">Available now</p>');
    expect(card).not.toContain('opens-soon');
    expect(card).not.toContain('#waitlist');
  });

  it('reads the sale on each request rather than at build time', () => {
    const src = readFileSync(new URL('../app/pricing/page.tsx', import.meta.url), 'utf8');
    expect(src).toMatch(/const sale = bundleSale\(\);/);
    expect(src).not.toMatch(/force-static|generateStaticParams/);
  });
});
