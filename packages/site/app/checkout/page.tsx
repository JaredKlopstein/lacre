import type { Metadata } from 'next';
import Link from 'next/link';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { BRAND } from '../../src/brand';
import { SIGNUP_PATH } from '../../src/auth/email';
import { AccountBar } from '../../src/account-bar';
import { PRIVACY_PATH, TERMS_PATH } from '../../src/legal';
import { CHECKOUT_API_PATH, CHECKOUT_OUTCOMES, signedInFromCookie, type CheckoutOutcome } from '../../src/checkout';
import { bundleSale } from '../../src/bundle-sale';
import {
  BUNDLE_CLOSED_LINE,
  BUNDLE_FULFILMENT,
  BUNDLE_OPENS_SOON,
  BUNDLE_TODAY_ID,
  EARLY_ACCESS_LABEL,
  GETTING_STARTED_URL,
  WAITLIST_HREF,
  annualOverageDisclosure,
  priceCards,
} from '../../src/plans';

export const metadata: Metadata = {
  title: 'Checkout',
  description: `Buy the ${BRAND.name} Cloud plan or a single evidence bundle.`,
};

// The checkout route redirects a failed form post back here with ?checkout=<outcome>.
const OUTCOME_MESSAGES: Record<CheckoutOutcome, string> = {
  invalid: 'That choice could not be checked out. Nothing was charged. Pick one of the options below.',
  subscribed: 'This account already has a Cloud subscription. Nothing was charged. Change or cancel it from',
  unavailable: 'Checkout is not open yet. Nothing was charged.',
  failed: 'Checkout could not be started. Nothing was charged. Try again shortly.',
};

type SearchParams = Record<string, string | string[] | undefined>;

// Every price below comes from src/plans.ts, which reads cloud's pricing module.
// Type no price into this file.
// The options are only rendered while the bundle is on sale (see below).
const card = (billing: 'monthly' | 'annual', id: 'bundle' | 'cloud') =>
  priceCards(billing, { bundleOpen: true }).find((c) => c.id === id)!;

// Each option's terms come from the same price cards as the pricing page, read on
// each render so an off-sale flag is current. An off-sale plan is shown as early
// access with its planned terms and the waitlist, never a payment button: the
// checkout route refuses it anyway. The bundle, the one thing on sale, comes first.
const options = () =>
  [
    { id: 'bundle', title: card('monthly', 'bundle').title, card: card('monthly', 'bundle'), fields: { kind: 'payg_bundle' } },
    { id: 'cloud-monthly', title: 'Cloud, monthly', card: card('monthly', 'cloud'), fields: { plan: 'cloud', interval: 'month' } },
    { id: 'cloud-annual', title: 'Cloud, annual', card: card('annual', 'cloud'), fields: { plan: 'cloud', interval: 'year' } },
  ] as const;

/**
 * Checkout while a bundle cannot be bought here: the Terms are still a draft, or
 * payment or sign-in is not set up. It says so and offers the way forward, rather
 * than sending the visitor to a sign-in form that cannot send. No account needed.
 */
function OpensSoon() {
  return (
    <section data-sale="closed">
      <h1>Checkout</h1>
      <h2>{BUNDLE_OPENS_SOON}</h2>
      <p>{BUNDLE_CLOSED_LINE}</p>
      <p>
        <Link href={WAITLIST_HREF}>Join the early access list</Link> and we will email you when bundles open. No
        payment details are asked for.
      </p>
      <p>
        Recording and verifying receipts is free and works now, and a bundle covers only receipts already recorded:{' '}
        <a href={GETTING_STARTED_URL}>start recording with {BRAND.name} Core</a>. Read{' '}
        <Link href={`/pricing#${BUNDLE_TODAY_ID}`}>how a bundle is made today</Link>.
      </p>
    </section>
  );
}

export default async function CheckoutPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  // Reading the request first keeps this page dynamic, so the sale below is read on each
  // request and checkout opens by itself once checkout, sign-in and the Terms are ready.
  const cookie = (await headers()).get('cookie');
  if (!bundleSale().open) return <OpensSoon />;

  const account = await signedInFromCookie(cookie);
  if (!account) redirect(`${SIGNUP_PATH}?for=checkout`);

  const { checkout } = await searchParams;
  const outcome = CHECKOUT_OUTCOMES.find((o) => o === checkout);

  return (
    <>
      <AccountBar account={account} />
      <section>
        <h1>Checkout</h1>
        <p>
          Choose what to buy. Payment is handled by Stripe, and your purchase is linked to the account you
          are signed in with.
        </p>
        <p>
          Purchases are covered by the <Link href={TERMS_PATH}>Terms</Link>, including refunds and cancellation.
          The <Link href={PRIVACY_PATH}>Privacy Policy</Link> explains what data is kept.
        </p>
        {outcome && (
          <p role="status">
            {OUTCOME_MESSAGES[outcome]}
            {outcome === 'subscribed' && (
              <>
                {' '}
                <Link href="/account">your account</Link>.
              </>
            )}
          </p>
        )}
      </section>
      <section aria-label="Options">
        {options().map((option) => (
          <article key={option.id} data-option={option.id}>
            <h2>{option.title}</h2>
            <p>{option.card.price}</p>
            {option.card.offSale && (
              <p>
                <strong>{EARLY_ACCESS_LABEL}</strong>: not on sale yet. Planned, not available yet:
              </p>
            )}
            <ul>
              {option.card.terms.map((term) => (
                <li key={term}>{term}</li>
              ))}
            </ul>
            {option.card.offSale ? (
              <p>
                <Link href={WAITLIST_HREF}>Join the waitlist</Link>
              </p>
            ) : (
              <>
                {option.id === 'cloud-annual' && <p role="note">{annualOverageDisclosure()}</p>}
                {/* Say how the bundle is delivered before anyone pays for it. */}
                {option.id === 'bundle' && (
                  <p data-fulfilment>
                    <strong>How it is delivered:</strong> {BUNDLE_FULFILMENT}{' '}
                    <Link href={`/pricing#${BUNDLE_TODAY_ID}`}>More on how a bundle is made</Link>.
                  </p>
                )}
                <form method="post" action={CHECKOUT_API_PATH}>
                  {Object.entries(option.fields).map(([name, value]) => (
                    <input key={name} type="hidden" name={name} value={value} />
                  ))}
                  <button type="submit">Continue to payment</button>
                </form>
              </>
            )}
          </article>
        ))}
        <article data-option="enterprise">
          <h2>Enterprise</h2>
          <p>
            Enterprise is billed by contract, not through checkout. <Link href="/enterprise">Contact the team</Link>.
          </p>
        </article>
      </section>
    </>
  );
}
