import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import PricingPage from '../app/pricing/page.js';
import TermsPage from '../app/terms/page.js';
import PrivacyPage from '../app/privacy/page.js';
import { FREE_FIRST_BUNDLES, NINETY_DAY_PACKAGE, PAYG_BUNDLE_PRICE_USD } from '../../cloud/src/pricing.js';
import { FIRST_BUNDLE_FREE, bundleTerms, firstBundleClaim, priceCards, pricingFaq } from '../src/plans.js';
import { TEST_FACTS, fillLegalFacts } from './sale-env.js';

/**
 * The bundle is $5 after a free first one.
 *
 * The 90-day package was withdrawn (#235). Its description is gone from the
 * Terms and the Privacy Policy; its refund clause deliberately stays, because a
 * link-holder can still buy one and nothing else in the Terms covers them.
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

  /**
   * In-force Terms must not describe a purchase a reader cannot make. The
   * package was withdrawn (#235) and is on no page; this is what it used to
   * promise, and none of it may be offered any more.
   */
  it('offer no 90-day package: no weekly anchors, no kept-anchor term, no auditor call, no payment link', () => {
    for (const promise of [
      'The 90-day evidence package is a one-time purchase through a Stripe payment link.',
      'we anchor your chain once a week',
      '12 anchors in all',
      'one call with your auditor or reviewer',
      'payment link',
    ]) {
      expect(terms, promise).not.toContain(promise);
    }
    expect(terms).not.toMatch(/\$\d/);
  });

  /**
   * The refund clause stays, and this is the test that should stop anyone
   * deleting it as an orphan.
   *
   * Anyone holding the Stripe payment link can still buy the package: Stripe
   * hosts that page and nothing in this repository gates it. The clause above
   * it does not cover such a buyer -- it is scoped to "an evidence bundle we
   * have not yet delivered", a different product -- so deleting this would
   * leave someone who paid $249 with no applicable refund terms at all.
   *
   * It goes once the link is deactivated AND Stripe confirms nobody bought one.
   */
  it('keeps the package refund clause, word for word, because a link-holder can still buy one', () => {
    expect(terms).toMatch(/For the 90-day evidence package, you can request a refund within \S.* of purchase, pro-rated for the weeks not yet anchored\./);
    expect(terms).toContain('Anchors already delivered are not refundable.');
    // The clause that does not cover them, for contrast: a different product.
    expect(terms).toContain('for an evidence bundle we have not yet delivered');
  });

  it('keeps it under every branch of the refund window, not just the shipped one', () => {
    // 0 days: the package reads as non-refundable rather than silently vanishing.
    restore = fillLegalFacts();
    const zero = unescape(renderToStaticMarkup(TermsPage())).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    expect(TEST_FACTS.refundWindowDays).toBe(0);
    expect(zero).toContain('The 90-day evidence package is not refundable, except where the law requires otherwise.');
    // ...and the offer description is absent in that branch too.
    expect(zero).not.toContain('one call with your auditor or reviewer');
  });
});

describe('the Privacy Policy no longer describes collecting anchors for the package', () => {
  const privacy = () => unescape(renderToStaticMarkup(PrivacyPage())).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

  it('drops the anchors bullet, which described a collection that cannot happen', () => {
    const body = privacy();
    expect(body).not.toContain('Your anchors, if you buy the 90-day evidence package.');
    expect(body).not.toContain('every anchor we make for you for the 90-day package term');
    expect(body).not.toMatch(/\$\d/);
  });

  it('keeps what that bullet sat beside: the chain file for an evidence bundle, and its retention', () => {
    const body = privacy();
    expect(body).toContain('Your chain file, if you buy an evidence bundle.');
    expect(body).toMatch(/we keep the chain file and the bundle for \S/);
  });
});
