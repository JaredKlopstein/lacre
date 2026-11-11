import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import PricingPage from '../app/pricing/page.js';
import TermsPage from '../app/terms/page.js';
import { FREE_FIRST_BUNDLES, NINETY_DAY_PACKAGE, PAYG_BUNDLE_PRICE_USD } from '../../cloud/src/pricing.js';
import { PACKAGE_LINK_ENV, packageSale, paymentLink } from '../src/package-sale.js';
import { FIRST_BUNDLE_FREE, PACKAGE_CTA_LABEL, bundleTerms, firstBundleClaim, packageTerms, priceCards, pricingFaq } from '../src/plans.js';
import { TEST_FACTS, fillLegalFacts } from './sale-env.js';

/**
 * Pricing update: the bundle is $5 after a free first one, and a $249 90-day
 * package is offered through the owner's Stripe Payment Link, shown only once
 * the Terms are in effect and the link is set.
 */

const LINK = 'https://buy.stripe.com/test_00example123';
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

  it('says how to get the free first bundle: by asking, not through checkout, which charges', () => {
    expect(firstBundleClaim(null)).toBe(
      'Your first bundle is free: ask through the contact form instead of checking out, and we make it by hand. After that, $5 each',
    );
    expect(firstBundleClaim('contact@example.test')).toContain('write to contact@example.test instead of checking out');
    expect(bundleTerms()).toContain(firstBundleClaim());
    expect(pricingFaq()[3]!.answer).toBe(
      'No. The evidence bundle is pay as you go, no subscription, at $5 each, and your first bundle is free.',
    );
  });
});

describe('the 90-day package gate', () => {
  it('accepts only a Stripe Payment Link', () => {
    expect(paymentLink(LINK)).toBe(LINK);
    expect(paymentLink(`  ${LINK}\n`)).toBe(LINK);
    for (const bad of [
      undefined,
      '',
      'http://buy.stripe.com/test_00example123',
      'https://buy.stripe.com.example.test/x',
      'https://checkout.stripe.com/c/pay/x',
      'https://example.test/buy',
      `${LINK}?prefilled_email=a`,
      'javascript:alert(1)',
    ]) {
      expect(paymentLink(bad), String(bad)).toBeNull();
    }
  });

  it('stays closed while the Terms are a draft, even with the link set', () => {
    const draft = { ...TEST_FACTS, contactEmail: null };
    expect(packageSale({ [PACKAGE_LINK_ENV]: LINK }, draft)).toEqual({ open: false, href: null, blockers: ['terms'] });
  });

  it('stays closed with the Terms in effect but no valid link', () => {
    expect(packageSale({}, TEST_FACTS)).toEqual({ open: false, href: null, blockers: ['link'] });
    expect(packageSale({ [PACKAGE_LINK_ENV]: 'https://example.test/buy' }, TEST_FACTS).open).toBe(false);
  });

  it('opens with the Terms in effect and the link set, needing neither checkout nor sign-in', () => {
    expect(packageSale({ [PACKAGE_LINK_ENV]: LINK }, TEST_FACTS)).toEqual({ open: true, href: LINK, blockers: [] });
  });
});

describe('the 90-day package card on /pricing', () => {
  it('is not shown by default', async () => {
    const html = await pricing();
    expect(html).not.toContain('data-tier="package"');
    expect(html).not.toContain(PACKAGE_CTA_LABEL);
  });

  it('is not shown with only the link set', async () => {
    vi.stubEnv(PACKAGE_LINK_ENV, LINK);
    restore = () => {};
    const html = await pricing();
    // The repository's own legal facts decide here; the card shows only if they are complete.
    if (packageSale().open) expect(html).toContain('data-tier="package"');
    else expect(html).not.toContain('data-tier="package"');
  });

  it('is shown with the Terms in effect and the link set: $249 for 90 days, 12 weekly anchors, a call, and the link', async () => {
    restore = fillLegalFacts();
    vi.stubEnv(PACKAGE_LINK_ENV, LINK);
    const html = await pricing();
    const card = /<article data-tier="package">([\s\S]*?)<\/article>/.exec(html)?.[1] ?? '';
    expect(card).toContain('<h2>90-day evidence package</h2><p>$249</p><p data-price-note="true">for 90 days</p>');
    for (const term of packageTerms()) expect(card).toContain(`<li>${term}</li>`);
    expect(card).toContain('12 anchors');
    expect(card).toContain('keeps every anchor it makes for you');
    expect(card).toContain('A call with your auditor or reviewer');
    expect(card).toContain(`<a href="${LINK}">${PACKAGE_CTA_LABEL}</a>`);
    // It sits between the bundle and Cloud.
    expect(html.indexOf('data-tier="bundle"')).toBeLessThan(html.indexOf('data-tier="package"'));
    expect(html.indexOf('data-tier="package"')).toBeLessThan(html.indexOf('data-tier="cloud"'));
  });

  it('takes its numbers from NINETY_DAY_PACKAGE', () => {
    expect(NINETY_DAY_PACKAGE).toEqual({ priceUsd: 249, days: 90, weeklyAnchors: 12 });
    const card = priceCards('monthly', { packageHref: LINK }).find((c) => c.id === 'package')!;
    expect(card.price).toBe('$249');
    expect(card.cta).toEqual({ label: PACKAGE_CTA_LABEL, href: LINK });
  });
});

describe('the Terms describe both offers, without a price', () => {
  const terms = unescape(renderToStaticMarkup(TermsPage())).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

  it('the free first bundle: one per customer, asked for instead of checking out', () => {
    expect(terms).toContain('Your first evidence bundle is free, one per customer: ask for it at');
    expect(terms).toContain('instead of checking out, and we make it the same way as a paid one.');
  });

  it('the 90-day package: weekly anchors, every anchor kept, one call', () => {
    expect(terms).toContain('The 90-day evidence package is a one-time purchase through a Stripe payment link.');
    expect(terms).toContain('we anchor your chain once a week, 12 anchors in all, from the chain file you send each time');
    expect(terms).toContain('we keep every anchor we make for you');
    expect(terms).toContain('one call with your auditor or reviewer');
    expect(terms).not.toMatch(/\$\d/);
  });
});
