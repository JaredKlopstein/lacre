import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { PRICE_ENV } from '@lacre/cloud/dist/billing/config.js';
import { bundleSale } from '../src/bundle-sale.js';
import { linkBase } from '../src/auth/email.js';
import { LEGAL, missingFacts } from '../src/legal.js';
import PricingPage from '../app/pricing/page.js';
import { TEST_FACTS, clearLegalFacts, clearSaleEnv, fillLegalFacts, stubCheckoutEnv, stubSignInEnv } from './sale-env.js';
import { withBrandDomain, withoutBrandDomain } from './brand-domain.js';
import { BRAND } from '../src/brand.js';

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
    // SITE_BASE_URL is deliberately not in this list. BRAND.domain now supplies
    // the link base, so unsetting SITE_BASE_URL leaves the base intact and the
    // sale open; the test below covers the base instead.
    for (const name of ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', PRICE_ENV.payg_bundle, PRICE_ENV.cloud_month, 'DATABASE_URL']) {
      open();
      vi.stubEnv(name, '');
      expect(bundleSale().blockers, name).toContain('checkout');
      restoreFacts?.();
      vi.unstubAllEnvs();
    }
  });

  it('stays closed with Stripe fully configured but no webhook secret, so nobody can pay before a payment can be recorded', () => {
    // The state this guard exists for: the Stripe keys and prices set, which is
    // what opens the sale, while nothing is configured to receive the callback.
    // Without the webhook the purchase is never written to the account, and
    // /account would read "A purchase shows here once Stripe confirms it" forever.
    open();
    vi.stubEnv('STRIPE_WEBHOOK_SECRET', '');
    expect(bundleSale()).toEqual({ open: false, blockers: ['checkout'] });
  });

  it('refuses a malformed webhook secret as well as a missing one', () => {
    open();
    vi.stubEnv('STRIPE_WEBHOOK_SECRET', 'not-a-signing-secret');
    expect(bundleSale().blockers).toContain('checkout');
  });

  it('takes its link base from the attached domain, so the environment no longer has to supply one', () => {
    // Before BRAND.domain was attached, clearing SITE_BASE_URL and VERCEL_URL
    // closed the sale for want of a base. The domain now provides it.
    open();
    vi.stubEnv('SITE_BASE_URL', '');
    vi.stubEnv('VERCEL_URL', '');
    expect(BRAND.domain).not.toBeNull();
    expect(bundleSale()).toEqual({ open: true, blockers: [] });
  });

  it('still closes for want of a base once the domain is detached', () => {
    open();
    const restore = withoutBrandDomain();
    try {
      vi.stubEnv('SITE_BASE_URL', '');
      vi.stubEnv('VERCEL_URL', '');
      expect(bundleSale().blockers).toContain('checkout');
    } finally {
      restore();
    }
  });

  /**
   * The check the domain change is most likely to get wrong: attaching a domain
   * makes the first branch of checkoutConfigured's `base` true, and the sale must
   * not open on that alone. Production carries DATABASE_URL and nothing else.
   */
  it('stays closed on production’s environment, where only DATABASE_URL is set', () => {
    restoreFacts = fillLegalFacts();
    vi.stubEnv('DATABASE_URL', 'postgresql://test-user:test-password@db.site.test/site');
    expect(BRAND.domain).not.toBeNull();
    expect(bundleSale()).toEqual({ open: false, blockers: ['checkout', 'sign-in'] });
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

/**
 * The gate must never be more optimistic about the link base than the route it
 * gates.
 *
 * src/checkout.ts:104 refuses with 500 CHECKOUT_UNAVAILABLE when linkBase()
 * returns null. The gate used to ask a different question --
 *   BRAND.domain !== null || set(env, 'SITE_BASE_URL') || set(env, 'VERCEL_URL')
 * -- which tested whether a value was present, not whether an origin came out of
 * it. Each case below sets a base that is present and unusable, so the old
 * expression said yes while linkBase said null: the sale opens, a buyer signs in,
 * reaches checkout and is told the server is misconfigured.
 *
 * The expectation is not written down here. It is read from linkBase itself, for
 * whatever the case produced, so this test cannot drift from the route's rule.
 */
describe('the sale gate cannot accept a base the checkout route would refuse', () => {
  /** Bases that are present but produce no origin. Each leaves the rest of the sale fully configured. */
  const UNUSABLE: Record<string, () => () => void> = {
    'a domain with a path in it': () => withBrandDomain('lacre.dev/landing'),
    'a domain that is not a host': () => withBrandDomain('not a host'),
    'an empty-looking domain': () => withBrandDomain(' '),
    'SITE_BASE_URL on plain http, on a public host': () => {
      const restore = withoutBrandDomain();
      vi.stubEnv('SITE_BASE_URL', 'http://lacre.dev');
      return restore;
    },
    'SITE_BASE_URL that does not parse': () => {
      const restore = withoutBrandDomain();
      vi.stubEnv('SITE_BASE_URL', 'lacre.dev');
      return restore;
    },
    'VERCEL_URL that is not a host': () => {
      const restore = withoutBrandDomain();
      vi.stubEnv('SITE_BASE_URL', '');
      vi.stubEnv('VERCEL_URL', 'https://site.example.test/with/a/path');
      return restore;
    },
  };

  it.each(Object.keys(UNUSABLE))('%s closes the sale, because no link can be built from it', (name) => {
    open();
    const restoreBrand = UNUSABLE[name]!();
    try {
      // The premise: this really is a base the route would refuse.
      expect(linkBase(process.env), name).toBeNull();
      expect(bundleSale().blockers, name).toContain('checkout');
      expect(bundleSale().open, name).toBe(false);
    } finally {
      restoreBrand();
    }
  });

  /**
   * The same rule stated as an implication, over the usable and unusable cases
   * together: wherever the sale is open, a base exists. Nothing here says which
   * cases those are.
   */
  it('never reports the sale open while linkBase has nothing to return', () => {
    const cases: [string, () => () => void][] = [
      ...Object.entries(UNUSABLE),
      ['the attached domain, as shipped', () => () => {}],
      ['SITE_BASE_URL on https', () => {
        const restore = withoutBrandDomain();
        vi.stubEnv('SITE_BASE_URL', 'https://site.example.test');
        return restore;
      }],
      ['VERCEL_URL alone', () => {
        const restore = withoutBrandDomain();
        vi.stubEnv('SITE_BASE_URL', '');
        vi.stubEnv('VERCEL_URL', 'site.example.test');
        return restore;
      }],
    ];
    let openedAtLeastOnce = false;
    for (const [name, setup] of cases) {
      open();
      const restoreBrand = setup();
      try {
        const sale = bundleSale();
        if (sale.open) {
          openedAtLeastOnce = true;
          expect(linkBase(process.env), `${name}: open with no base`).not.toBeNull();
        }
      } finally {
        restoreBrand();
        restoreFacts?.();
        restoreFacts = null;
        vi.unstubAllEnvs();
        clearSaleEnv();
      }
    }
    // Otherwise the implication would hold vacuously and prove nothing.
    expect(openedAtLeastOnce).toBe(true);
  });
});
