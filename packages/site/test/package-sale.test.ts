import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import PricingPage from '../app/pricing/page.js';
import TermsPage from '../app/terms/page.js';
import PrivacyPage from '../app/privacy/page.js';
import { FREE_FIRST_BUNDLES, PAYG_BUNDLE_PRICE_USD } from '../../cloud/src/pricing.js';
import { FIRST_BUNDLE_FREE, bundleTerms, firstBundleClaim, priceCards, pricingFaq } from '../src/plans.js';
import { TEST_FACTS, fillLegalFacts } from './sale-env.js';

/**
 * The bundle is $5 after a free first one.
 *
 * The 90-day package was withdrawn, so the gate and card tests that were here
 * went with it. What remains is the bundle's pricing, and the Terms and Privacy
 * copy -- which still describes the package, because a past purchaser's rights
 * do not end with the offer. Those clauses go only once Stripe confirms nobody
 * bought it.
 */

const unescape = (s: string) => s.replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
const pricing = async () => unescape(renderToStaticMarkup(await PricingPage({ searchParams: Promise.resolve({}) })));

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
  vi.unstubAllEnvs();
});

describe('the evidence bundle price', () => {
  it('is $5 each, with the first bundle free', () => {
    expect(PAYG_BUNDLE_PRICE_USD).toBe(5);
    expect(FREE_FIRST_BUNDLES).toBe(1);
    const bundle = priceCards('monthly').find((c) => c.id === 'bundle')!;
    expect(bundle.price).toBe('$5 each');
    expect(bundle.priceNote).toBe(FIRST_BUNDLE_FREE);
    expect(FIRST_BUNDLE_FREE).toBe('First bundle free');
  });

  it('says how to get the free first bundle: one per customer, by email, not through checkout, which charges', () => {
    expect(firstBundleClaim('contact@frontierforge.tech')).toBe(
      'Your first bundle is free, one per customer: request it by email at contact@frontierforge.tech instead of ' +
        'checking out, and we make it by hand. After that, $5 each',
    );
    // Before the owner's contact address is set, it points at the contact form instead.
    expect(firstBundleClaim(null)).toContain('one per customer: request it through the contact form instead of checking out');
    expect(bundleTerms()).toContain(firstBundleClaim());
    expect(pricingFaq()[3]!.answer).toBe(
      'No. The evidence bundle is pay as you go, no subscription, at $5 each, and your first bundle is free.',
    );
  });
});

/**
 * The point of removing the offer path rather than leaving its gate closed.
 *
 * While the package was gated, setting one environment variable put the card
 * back on /pricing with a live payment button. The offer was withdrawn on the
 * owner's word, so no variable should be able to reopen it, and there is no
 * longer any code that would.
 */
describe('the withdrawn 90-day package', () => {
  it('cannot be put back on /pricing by setting its old environment variable', async () => {
    restore = fillLegalFacts();
    vi.stubEnv('NINETY_DAY_PACKAGE_PAYMENT_LINK', 'https://buy.stripe.com/test_00example123');
    const html = await pricing();
    expect(html).not.toContain('data-tier="package"');
    expect(html).not.toContain('evidence package');
    expect(html).not.toContain('249');
    expect(html).not.toContain('buy.stripe.com');
    // "90-day" on its own is Cloud's retention term, which stays.
    expect(html).toContain('90-day retention');
  });

  it('is offered by no price card, whatever the options', () => {
    for (const billing of ['monthly', 'annual'] as const) {
      for (const opts of [{}, { bundleOpen: true }, { bundleOpen: false }]) {
        expect(priceCards(billing, opts).map((c) => c.id)).toEqual(['core', 'bundle', 'cloud', 'enterprise']);
      }
    }
  });
});


describe('the Terms describe the one offer there is, without a price', () => {
  const terms = unescape(renderToStaticMarkup(TermsPage())).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

  it('the free first bundle: one per customer, requested by email at the contact address instead of checking out', () => {
    expect(terms).toContain('Your first evidence bundle is free, one per customer: request it by email at');
    expect(terms).toContain('instead of checking out, and we make it the same way as a paid one.');
  });

  it('still state the bundle refund terms, which are unchanged', () => {
    restore = fillLegalFacts();
    const filled = unescape(renderToStaticMarkup(TermsPage())).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    // TEST_FACTS has a zero-day window, so bundles read as non-refundable.
    expect(filled).toContain('Purchases are not refundable, except where the law requires otherwise.');
    expect(filled).toContain('A subscription can be cancelled at any time in the billing portal');
  });

  it('name no price', () => {
    expect(terms).not.toMatch(/\$\d/);
  });
});

/**
 * The reason this change exists, rather than tidiness.
 *
 * Until these clauses went, the Terms taking effect 2026-11-14 described a
 * 90-day package with 12 weekly anchors, a retention term and a pro-rated
 * refund -- an offer that was never purchasable, never shown on any
 * deployment, and for which no Stripe Payment Link was ever created. In-force
 * Terms must not describe something that does not exist.
 */
describe('neither the Terms nor the Privacy Policy describes the withdrawn package', () => {
  const render = (page: string) => unescape(page).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  const bodies = () => [
    render(renderToStaticMarkup(TermsPage())),
    render(renderToStaticMarkup(PrivacyPage())),
  ];

  it('mentions no evidence package, weekly anchors, auditor call or pro-rated refund', () => {
    for (const body of bodies()) {
      expect(body).not.toContain('evidence package');
      expect(body).not.toContain('once a week');
      expect(body).not.toContain('12 anchors');
      expect(body).not.toContain('auditor or reviewer');
      expect(body).not.toContain('pro-rated');
      expect(body).not.toContain('Anchors already delivered');
      expect(body).not.toContain('payment link');
    }
  });

  it('says the same with the owner\'s facts filled in, since the refund wording branches on them', () => {
    restore = fillLegalFacts();
    for (const body of bodies()) {
      expect(body).not.toContain('evidence package');
      expect(body).not.toContain('pro-rated');
    }
  });

  it('keeps what the package clauses sat beside: the bundle chain file and its retention', () => {
    const [, privacy] = bodies();
    expect(privacy).toContain('Your chain file, if you buy an evidence bundle.');
    expect(privacy).toMatch(/we keep the chain file and the bundle for \S/);
  });
});
