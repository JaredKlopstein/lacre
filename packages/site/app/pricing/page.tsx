import type { Metadata } from 'next';
import Link from 'next/link';
import { BRAND } from '../../src/brand';
import { bundleSale } from '../../src/bundle-sale';
import { contactForwarding } from '../../src/contact-forwarding';
import { LEGAL } from '../../src/legal';
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
  alternates: { canonical: '/pricing' },
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

type PriceCard = ReturnType<typeof priceCards>[number];

/**
 * A card nothing can be bought from today: the evidence bundle before checkout
 * opens, or a plan that is off sale. Both read the gate rather than a constant, so
 * the pricing page stops hedging on its own the day the sale opens.
 */
const notOnSale = (card: PriceCard) => Boolean(card.opensSoon || card.offSale);

/** Why this card cannot be bought from, in the card's own terms. */
function PlanStatus({ card }: { card: PriceCard }) {
  if (card.opensSoon) {
    return (
      <p data-status="opens-soon">
        <strong>{BUNDLE_OPENS_SOON}</strong>: {BUNDLE_CLOSED_LINE}
      </p>
    );
  }
  if (card.offSale) {
    return (
      <p data-status="early-access">
        <strong>{EARLY_ACCESS_LABEL}</strong>: not on sale yet. The hosted collector and continuous anchoring
        are still being built.
      </p>
    );
  }
  return null;
}
const WAITLIST_HEADING_ID = 'waitlist-heading';

type SearchParams = Record<string, string | string[] | undefined>;

export default async function PricingPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const billing: Billing = params[BILLING_PARAM] === 'annual' ? 'annual' : 'monthly';
  // A cancelled Stripe checkout returns here with ?checkout=cancelled.
  const cancelled = params.checkout === 'cancelled';
  // Read on each request, so the bundle opens by itself once checkout, sign-in and the Terms are ready.
  const sale = bundleSale();
  // Whether a waitlist entry sent now would reach anyone. The form posts to the
  // contact route, so this is the same question /privacy asks.
  const forwarding = contactForwarding();
  const bundleHow = sale.open ? 'how a bundle is made today' : 'how a bundle will be made';

  return (
    <>
      <section>
        <h1>Pricing</h1>
        {cancelled && <p role="status">Checkout cancelled, nothing was charged.</p>}
        <p>
          Writing receipts and verifying them stays free on every plan. You pay for evidence a third
          party can check: anchored evidence bundles (<a href={`#${BUNDLE_TODAY_ID}`}>{bundleHow}</a>),
          and later Cloud to run the collector and anchoring for you.
        </p>
        <p data-definition="evidence-bundle">{BUNDLE_DEFINITION}</p>
      </section>
      <section aria-label="Plans">
        {priceCards(billing, { bundleOpen: sale.open }).map((card) => (
          <article key={card.id} data-tier={card.id}>
            <h2>{card.title}</h2>
            {/*
              #258: while nothing on this card can be bought, the status comes before
              the figure and the figure says it is planned. Read the other way round, a
              card led with its monthly figure reads as a price you can pay today, and the correction
              arrives after the reader has already formed that impression. The order
              follows the gate, so both revert by themselves when the sale opens.
            */}
            {notOnSale(card) && <PlanStatus card={card} />}
            <p>{notOnSale(card) ? `Planned: ${card.price}` : card.price}</p>
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
            {card.offSale && <h3>Planned, not available yet</h3>}
            <ul>
              {card.terms.map((term) => (
                <li key={term}>{term}</li>
              ))}
            </ul>
            {card.id === 'cloud' && billing === 'annual' && <p role="note">{pricingAnnualOverageDisclosure()}</p>}
            <p data-cta={card.id === 'bundle' ? 'primary' : 'secondary'}>
              {/* Every card left goes to a route on this site. The package, which paid on
                  Stripe's own page and so needed a plain <a>, was withdrawn in #235 and is
                  no longer a CardId, which made that branch unreachable. */}
              <Link href={card.cta.href}>{card.cta.label}</Link>
            </p>
          </article>
        ))}
      </section>
      <section aria-labelledby={BUNDLE_TODAY_ID}>
        <h2 id={BUNDLE_TODAY_ID}>{bundleHow.charAt(0).toUpperCase() + bundleHow.slice(1)}</h2>
        <p>{BUNDLE_FULFILMENT}</p>
      </section>
      {/* Its own section under the cards, so opening it never stretches the grid. */}
      <section id={WAITLIST_ID} aria-labelledby={WAITLIST_HEADING_ID}>
        <h2 id={WAITLIST_HEADING_ID}>Join the early access list</h2>
        {/*
          An entry is emailed through the contact route and stored nowhere, so while
          this deployment cannot send, "we will email you when they open" is a promise
          with nothing behind it: the route answers not_configured and the entry is
          lost. The page says so instead, and the button is disabled rather than
          inviting an entry that goes nowhere. Once the EMAIL_* variables are set the
          promise becomes true and the page makes it again, with no edit here.
        */}
        {forwarding ? (
          <p>
            {sale.open
              ? 'Cloud is in early access. Leave your details and we will email you when it opens.'
              : 'Evidence bundles and Cloud are not open yet. Leave your details and we will email you when they open.'}{' '}
            No payment details are asked for.
          </p>
        ) : (
          <p>
            {`The waitlist isn't taking sign-ups yet. To hear when bundles and Cloud open, email `}
            <a href={`mailto:${LEGAL.contactEmail}`}>{LEGAL.contactEmail}</a>
            {` with "Waitlist" in the subject, or watch the `}
            <a href={BRAND.repository}>GitHub repository</a>.
          </p>
        )}
        <WaitlistForm need={sale.open ? WAITLIST_NEED : BUNDLE_WAITLIST_NEED} closed={!forwarding} />
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
