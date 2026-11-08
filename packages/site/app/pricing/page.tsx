import type { Metadata } from 'next';
import Link from 'next/link';
import { BRAND } from '../../src/brand';
import { bundleSale } from '../../src/bundle-sale';
import {
  BILLING_PARAM,
  BILLINGS,
  BUNDLE_CLOSED_LINE,
  BUNDLE_DEFINITION,
  BUNDLE_FULFILMENT,
  BUNDLE_OPENS_SOON,
  BUNDLE_TODAY_ID,
  EARLY_ACCESS_LABEL,
  priceCards,
  pricingAnnualOverageDisclosure,
  pricingFaq,
  type Billing,
} from '../../src/plans';
import { BUNDLE_WAITLIST_NEED, WAITLIST_NEED, WaitlistForm } from './waitlist-form';
import { WAITLIST_ID, WaitlistOpen } from './waitlist-open';

export const metadata: Metadata = {
  title: 'Pricing',
  description: `${BRAND.name} pricing: Core is free, evidence bundles are priced each, Cloud is in early access, Enterprise is by contract.`,
};

// Every price below comes from src/plans.ts, which reads cloud's pricing module.
// Type no price into this file.
const BILLING_LABELS: Record<Billing, string> = { monthly: 'Monthly', annual: 'Annual' };
const BILLING_HREFS: Record<Billing, string> = {
  monthly: '/pricing',
  annual: `/pricing?${BILLING_PARAM}=annual`,
};
const WAITLIST_HEADING_ID = 'waitlist-heading';

type SearchParams = Record<string, string | string[] | undefined>;

export default async function PricingPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const billing: Billing = params[BILLING_PARAM] === 'annual' ? 'annual' : 'monthly';
  // A cancelled Stripe checkout returns here with ?checkout=cancelled.
  const cancelled = params.checkout === 'cancelled';
  // Read on each request, so the bundle opens by itself once checkout, sign-in and the Terms are ready.
  const sale = bundleSale();

  return (
    <>
      <section>
        <h1>Pricing</h1>
        {cancelled && <p role="status">Checkout cancelled, nothing was charged.</p>}
        <p>
          Writing receipts and verifying them stays free on every plan. You pay for evidence a third
          party can check: anchored evidence bundles (<a href={`#${BUNDLE_TODAY_ID}`}>how a bundle is made today</a>),
          and later Cloud to run the collector and anchoring for you.
        </p>
        <p data-definition="evidence-bundle">{BUNDLE_DEFINITION}</p>
      </section>
      <section aria-label="Plans">
        {priceCards(billing, { bundleOpen: sale.open }).map((card) => (
          <article key={card.id} data-tier={card.id}>
            <h2>{card.title}</h2>
            <p>{card.price}</p>
            {/* Only the bundle, the offer meant to be on sale, carries a badge; no card is ever "recommended". */}
            {card.priceNote && <p data-price-note>{card.priceNote}</p>}
            {card.badge && <p data-badge>{card.badge}</p>}
            {card.id === 'cloud' && (
              // The only price the period changes is Cloud's, so the toggle lives on its card.
              <nav aria-label="Cloud billing period">
                <ul>
                  {BILLINGS.map((b) => (
                    <li key={b}>
                      <Link href={BILLING_HREFS[b]} scroll={false} aria-current={b === billing ? 'page' : undefined}>
                        {BILLING_LABELS[b]}
                      </Link>
                    </li>
                  ))}
                </ul>
              </nav>
            )}
            {card.opensSoon && (
              <p data-status="opens-soon">
                <strong>{BUNDLE_OPENS_SOON}</strong>: {BUNDLE_CLOSED_LINE}
              </p>
            )}
            {card.offSale && (
              <>
                <p data-status="early-access">
                  <strong>{EARLY_ACCESS_LABEL}</strong>: not on sale yet. The hosted collector and continuous
                  anchoring are still being built.
                </p>
                <h3>Planned, not available yet</h3>
              </>
            )}
            <ul>
              {card.terms.map((term) => (
                <li key={term}>{term}</li>
              ))}
            </ul>
            {card.id === 'cloud' && billing === 'annual' && <p role="note">{pricingAnnualOverageDisclosure()}</p>}
            <p data-cta={card.id === 'bundle' ? 'primary' : 'secondary'}>
              <Link href={card.cta.href}>{card.cta.label}</Link>
            </p>
          </article>
        ))}
      </section>
      <section aria-labelledby={BUNDLE_TODAY_ID}>
        <h2 id={BUNDLE_TODAY_ID}>How a bundle is made today</h2>
        <p>{BUNDLE_FULFILMENT}</p>
      </section>
      {/* Its own section under the cards, so opening it never stretches the grid. */}
      <section id={WAITLIST_ID} aria-labelledby={WAITLIST_HEADING_ID}>
        <h2 id={WAITLIST_HEADING_ID}>Join the early access list</h2>
        <p>
          {sale.open
            ? 'Cloud is in early access. Leave your details and we will email you when it opens.'
            : 'Evidence bundles and Cloud are not open yet. Leave your details and we will email you when they open.'}{' '}
          No payment details are asked for.
        </p>
        <WaitlistForm need={sale.open ? WAITLIST_NEED : BUNDLE_WAITLIST_NEED} />
      </section>
      <section aria-labelledby="faq">
        <h2 id="faq">Questions</h2>
        {pricingFaq().map((entry) => (
          <details key={entry.question}>
            <summary>{entry.question}</summary>
            <p>{entry.answer}</p>
          </details>
        ))}
      </section>
      <WaitlistOpen />
    </>
  );
}
