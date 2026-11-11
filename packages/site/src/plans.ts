/**
 * The pricing page's cards, built from cloud's pricing module.
 *
 * Every number on the page comes from PLANS and the bundle prices there; none is
 * typed into the site, so a price change in cloud is the only edit a price needs.
 * The import names the compiled module rather than the package root: pricing has
 * no imports of its own, so the page does not pull in the rest of cloud.
 */
import {
  FREE_FIRST_BUNDLES,
  NINETY_DAY_PACKAGE,
  OVERAGE_BUNDLE_PRICE_USD,
  PAYG_BUNDLE_PRICE_USD,
  PLANS,
  type Plan,
} from '@lacre/cloud/dist/pricing.js';
import { BRAND } from './brand';
import { LEGAL } from './legal';

const usd = (amount: number) => `$${amount}`;

/** For pages that describe the offers in words (the Terms): counts only, never a price. */
export { FREE_FIRST_BUNDLES, NINETY_DAY_PACKAGE };

export type Billing = 'monthly' | 'annual';
export const BILLINGS = ['monthly', 'annual'] as const satisfies readonly Billing[];

/** The query parameter the page's toggle sets: `/pricing?billing=annual`. */
export const BILLING_PARAM = 'billing';

/**
 * Plans checkout refuses and the pricing page shows as Early access. Cloud stays
 * off sale until the hosted collector and continuous anchoring are live: a buyer
 * would otherwise pay for a service they cannot use yet.
 */
export const OFF_SALE_PLANS: ReadonlySet<string> = new Set(['cloud']);

export const EARLY_ACCESS_LABEL = 'Early access';

/** The getting-started guide, on GitHub until the site has its own docs. */
export const GETTING_STARTED_URL = `${BRAND.repository}/blob/main/docs/getting-started.md`;

/** What an evidence bundle contains, in one phrase used everywhere the format is named. */
export const BUNDLE_FORMAT = 'JSON, with a human-readable PDF and HTML report';

/** Business days from receiving a buyer's chain file to sending the anchored bundle back. */
export const BUNDLE_DELIVERY_BUSINESS_DAYS = 2;

/** The id of the pricing section that says how a bundle is made today. */
export const BUNDLE_TODAY_ID = 'bundle-today';

/** The repository's last path segment, which core names its home directory and store after. */
export const REPO_DIR = BRAND.repository.slice(BRAND.repository.lastIndexOf('/') + 1);

/**
 * The chain file a bundle buyer sends: core's store database, which holds the
 * receipts and the agents' public keys. The signing key is the file next to it
 * and is never sent (core's config.ts names both).
 */
export const CHAIN_FILE = `${REPO_DIR}.db`;
export const SIGNING_KEY_FILE = 'agent.key.json';

/** The bundle while it cannot be bought here yet (src/bundle-sale.ts decides). */
export const BUNDLE_OPENS_SOON = 'Bundles open soon';
export const BUNDLE_CLOSED_LINE = 'Checkout is not open yet, so nothing can be bought or charged here today.';

/**
 * How a bundle is made today, while there is no self-serve path: the buyer sends
 * their chain file, which holds receipts and public keys but never a signing key,
 * and gets the anchored bundle back by email.
 */
export const BUNDLE_FULFILMENT =
  `After checkout we email you to ask for your chain file, ${CHAIN_FILE}. It holds your receipts and your agents’ public keys; ` +
  'your signing key stays with you and we never ask for it. We timestamp the head of that chain with a public ' +
  `RFC 3161 authority and email the bundle back within ${BUNDLE_DELIVERY_BUSINESS_DAYS} business days of receiving the file: ` +
  `${BUNDLE_FORMAT}. The timestamp proves the chain existed when we anchored it, not earlier.`;

/** Cloud's planned anchoring interval, from PLANS, for copy that describes it. */
export const CLOUD_MAX_ANCHOR_MINUTES: number = (() => {
  const minutes = PLANS.cloud.maxAnchorIntervalMinutes;
  if (minutes === null) throw new Error('PLANS.cloud.maxAnchorIntervalMinutes is null; the Cloud copy needs it.');
  return minutes;
})();

/** Where an off-sale card's button goes: the waitlist form on the pricing page. */
export const WAITLIST_HREF = '/pricing#waitlist';

export interface CallToAction {
  readonly label: string;
  readonly href: string;
}

export type CardId = 'core' | 'bundle' | 'package' | 'cloud' | 'enterprise';

export interface PriceCard {
  readonly id: CardId;
  readonly title: string;
  readonly price: string;
  /** A line under the price, such as the annual Cloud saving. */
  readonly priceNote?: string;
  readonly terms: readonly string[];
  /** Off-sale cards: their terms are planned features, and they have no checkout. */
  readonly offSale?: boolean;
  /** The bundle while it cannot be bought here yet: it says so and points at the waitlist. */
  readonly opensSoon?: boolean;
  /** A short pill on the card. Only the bundle, the offer meant to be on sale, carries one. */
  readonly badge?: string;
  /** The card's one button. Off-sale cards always get the waitlist, never checkout. */
  readonly cta: CallToAction;
}

const ON_SALE_CTAS: Record<Exclude<CardId, 'package'>, CallToAction> = {
  core: { label: 'Start free', href: GETTING_STARTED_URL },
  bundle: { label: 'Buy a bundle', href: '/checkout' },
  cloud: { label: 'Buy Cloud', href: '/checkout' },
  enterprise: { label: 'Contact the team', href: '/enterprise' },
};

const WAITLIST_CTA: CallToAction = { label: 'Join the waitlist', href: WAITLIST_HREF };
const BUNDLE_SOON_CTA: CallToAction = { label: 'Tell me when bundles open', href: WAITLIST_HREF };

/** A card's button, from its off-sale flag first and its id second. */
export function cardCta(id: Exclude<CardId, 'package'>, offSale: boolean): CallToAction {
  return offSale ? WAITLIST_CTA : ON_SALE_CTAS[id];
}

/** The evidence package's button label. Its href is the owner's Stripe Payment Link (src/package-sale.ts). */
export const PACKAGE_CTA_LABEL = `Buy the ${NINETY_DAY_PACKAGE.days}-day package`;

function withCta(card: Omit<PriceCard, 'cta'>, packageHref: string | null): PriceCard {
  if (card.id === 'package') return { ...card, cta: { label: PACKAGE_CTA_LABEL, href: packageHref ?? WAITLIST_HREF } };
  if (card.opensSoon) return { ...card, cta: BUNDLE_SOON_CTA };
  return { ...card, cta: cardCta(card.id, card.offSale === true) };
}

export interface CardOptions {
  /** Whether a bundle can be bought here now (src/bundle-sale.ts). Closed unless said otherwise. */
  readonly bundleOpen?: boolean;
  /**
   * The evidence package's Payment Link when it is offered (src/package-sale.ts).
   * Its card is included only when this is set.
   */
  readonly packageHref?: string | null;
}

/** The free first bundle, shown under the bundle price wherever the price is. */
export const FIRST_BUNDLE_FREE: string | null = FREE_FIRST_BUNDLES > 0 ? 'First bundle free' : null;

/**
 * How to get the free first bundle: by asking, not through checkout, which always
 * charges. It names the contact address once the owner has set one.
 */
export function firstBundleClaim(contactEmail: string | null = LEGAL.contactEmail): string {
  const where = contactEmail ? `write to ${contactEmail}` : 'ask through the contact form';
  return (
    `Your first bundle is free: ${where} instead of checking out, and we make it by hand. ` +
    `After that, ${usd(PAYG_BUNDLE_PRICE_USD)} each`
  );
}

/**
 * The bundle card's terms: what a buyer needs first, what a bundle covers, what
 * they send, what they get back and when.
 */
export function bundleTerms(): string[] {
  return [
    'Pay as you go, no subscription',
    ...(FREE_FIRST_BUNDLES > 0 ? [firstBundleClaim()] : []),
    `You need ${BRAND.name} Core running from source and recording your agent’s receipts first`,
    'Covers the receipts already recorded when the bundle is made, and is timestamped then',
    // The term's first use on /pricing and /checkout, so it says what the file is.
    `You send your chain file, ${CHAIN_FILE}: the database Core keeps your receipts and agents’ public keys in. ` +
      `Never your signing key (${SIGNING_KEY_FILE})`,
    'You get back your chain head timestamped by a public RFC 3161 authority, in an archive an auditor verifies offline',
    BUNDLE_FORMAT,
    `Made by hand today: emailed within ${BUNDLE_DELIVERY_BUSINESS_DAYS} business days of receiving your chain file`,
    'The timestamp proves the chain existed when it was anchored, not earlier',
  ];
}

/** 1000000 reads as "1M"; anything that is not whole millions is written out. */
function count(n: number): string {
  const million = 1_000_000;
  return n % million === 0 ? `${n / million}M` : n.toLocaleString('en-US');
}

/** A value the Cloud card cannot render without. Fails the render, not silently. */
function required<T>(value: T | null, field: keyof Plan): T {
  if (value === null) throw new Error(`PLANS.cloud.${field} is null; the Cloud pricing card needs it.`);
  return value;
}

function cloudPrice(plan: Plan, billing: Billing): string {
  return billing === 'annual'
    ? `${usd(required(plan.annualUsd, 'annualUsd'))}/yr`
    : `${usd(required(plan.monthlyUsd, 'monthlyUsd'))}/mo`;
}

/** The Cloud plan's terms, in the order the Pages site lists them. */
export function cloudTerms(plan: Plan = PLANS.cloud): string[] {
  return [
    `Continuous anchoring, batched, at most ${required(plan.maxAnchorIntervalMinutes, 'maxAnchorIntervalMinutes')} minutes apart`,
    `${plan.includedBundlesPerMonth} bundles/month, no rollover`,
    `${usd(OVERAGE_BUNDLE_PRICE_USD)} per extra bundle`,
    `${required(plan.includedAgentIdentities, 'includedAgentIdentities')} agent identities included`,
    `${usd(required(plan.perExtraIdentityUsd, 'perExtraIdentityUsd'))}/mo per extra identity`,
    `${required(plan.retentionDays, 'retentionDays')}-day retention`,
    `${count(required(plan.fairUseReceiptsPerMonth, 'fairUseReceiptsPerMonth'))} receipts/month fair-use cap (not billed)`,
  ];
}

/**
 * The sentence the annual Cloud checkout shows before the customer pays: annual
 * overage bills monthly to the saved card.
 */
export function annualOverageDisclosure(plan: Plan = PLANS.cloud): string {
  return (
    `Evidence bundles over the ${plan.includedBundlesPerMonth} included each month are billed ` +
    `monthly, at ${usd(OVERAGE_BUNDLE_PRICE_USD)} per bundle, to the card saved at this checkout.`
  );
}

/**
 * The pricing page's wording of the same terms, shown under the annual toggle.
 * There is no checkout on that page, so it names the card, not "this checkout".
 */
export function pricingAnnualOverageDisclosure(plan: Plan = PLANS.cloud): string {
  // Future tense while Cloud is off sale: nobody can be billed for it yet.
  if (OFF_SALE_PLANS.has(plan.id)) {
    return (
      `When Cloud is available, evidence bundles over the ${plan.includedBundlesPerMonth} included each month ` +
      `will be charged monthly at ${usd(OVERAGE_BUNDLE_PRICE_USD)} per bundle.`
    );
  }
  return (
    `Evidence bundles over the ${plan.includedBundlesPerMonth} included each month are charged ` +
    `monthly, at ${usd(OVERAGE_BUNDLE_PRICE_USD)} per bundle, billed to your card.`
  );
}

/**
 * Months an annual Cloud plan saves against twelve monthly payments:
 * (12 × monthly − annual) / monthly, from PLANS rather than typed in.
 */
export function annualSavingsMonths(plan: Plan = PLANS.cloud): number {
  const monthly = required(plan.monthlyUsd, 'monthlyUsd');
  const months = (12 * monthly - required(plan.annualUsd, 'annualUsd')) / monthly;
  return Number(months.toFixed(1));
}

/** Shown under the annual Cloud price: "2 months free against 12 monthly payments". */
export function annualSavingsLine(plan: Plan = PLANS.cloud): string {
  const months = annualSavingsMonths(plan);
  return `${months} ${months === 1 ? 'month' : 'months'} free against 12 monthly payments`;
}

/** What an evidence bundle is, in one line, for the pricing page. */
export const BUNDLE_DEFINITION =
  'An evidence bundle is a signed, timestamped export of a chain range that an auditor verifies offline.';

/**
 * The Core card's terms: the free plan's features without the CLI name, which
 * PLANS carries in parentheses after a feature. The bins are named after the
 * brand, so a parenthetical starting with it stays off the card.
 */
export function coreTerms(plan: Plan = PLANS.free): string[] {
  const prefix = BRAND.name.toLowerCase();
  return plan.features.map((feature) =>
    feature.replace(/\s*\(([^)]*)\)/g, (match, inner: string) =>
      inner.toLowerCase().startsWith(prefix) ? '' : match,
    ),
  );
}

export interface FaqEntry {
  readonly question: string;
  readonly answer: string;
}

/** The pricing page's questions, answered in terms the cards already use. */
export function pricingFaq(plan: Plan = PLANS.cloud): FaqEntry[] {
  return [
    {
      question: 'What is a receipt?',
      answer:
        'A record of one action an agent took, hash-chained to the receipts before it so a later change shows. ' +
        'Writing receipts and verifying them is free on every plan.',
    },
    {
      question: 'What is an evidence bundle?',
      answer: `${BUNDLE_DEFINITION} Your chain head is timestamped by a public RFC 3161 authority.`,
    },
    {
      question: 'What does the receipts/month fair-use cap mean?',
      answer:
        `Cloud lists a ${count(required(plan.fairUseReceiptsPerMonth, 'fairUseReceiptsPerMonth'))} receipts/month ` +
        'fair-use cap. It is not billed: receipts are not charged for. Volume beyond the Cloud fair-use cap is an Enterprise term.',
    },
    {
      question: 'Do I need a subscription to buy an evidence bundle?',
      answer:
        `No. The evidence bundle is pay as you go, no subscription, at ${usd(PAYG_BUNDLE_PRICE_USD)} each` +
        (FREE_FIRST_BUNDLES > 0 ? ', and your first bundle is free.' : '.'),
    },
  ];
}

/** The evidence package's terms, from NINETY_DAY_PACKAGE: what the buyer gets and what they send. */
export function packageTerms(): string[] {
  const { days, weeklyAnchors } = NINETY_DAY_PACKAGE;
  return [
    `Your chain anchored once a week for ${days} days: ${weeklyAnchors} anchors, each timestamped by a public RFC 3161 authority`,
    `${BRAND.name} keeps every anchor it makes for you, so a third party holds your anchor history`,
    'A call with your auditor or reviewer, walking through verifying the evidence offline',
    `You send your chain file, ${CHAIN_FILE}, for each anchor. Never your signing key (${SIGNING_KEY_FILE})`,
    'One payment through Stripe, no subscription. Made by hand',
  ];
}

export function priceCards(billing: Billing, { bundleOpen = false, packageHref = null }: CardOptions = {}): PriceCard[] {
  const { free, cloud, enterprise } = PLANS;
  const cards: Omit<PriceCard, 'cta'>[] = [
    {
      id: 'core',
      // PLANS.free.name carries the product name, which the site takes from BRAND.
      title: `${BRAND.name} Core`,
      price: free.monthlyUsd === 0 ? 'Free' : `${usd(required(free.monthlyUsd, 'monthlyUsd'))}/mo`,
      terms: coreTerms(free),
    },
    {
      id: 'bundle',
      title: 'Evidence bundle',
      price: `${usd(PAYG_BUNDLE_PRICE_USD)} each`,
      ...(FIRST_BUNDLE_FREE ? { priceNote: FIRST_BUNDLE_FREE } : {}),
      terms: bundleTerms(),
      badge: bundleOpen ? 'Available now' : 'Opens soon',
      ...(bundleOpen ? {} : { opensSoon: true }),
    },
    // Shown only while the Terms are in effect and the owner's Payment Link is set.
    ...(packageHref
      ? [
          {
            id: 'package' as const,
            title: `${NINETY_DAY_PACKAGE.days}-day evidence package`,
            price: usd(NINETY_DAY_PACKAGE.priceUsd),
            priceNote: `for ${NINETY_DAY_PACKAGE.days} days`,
            terms: packageTerms(),
          },
        ]
      : []),
    {
      id: 'cloud',
      title: cloud.name,
      price: cloudPrice(cloud, billing),
      ...(billing === 'annual' ? { priceNote: annualSavingsLine(cloud) } : {}),
      terms: cloudTerms(cloud),
      offSale: OFF_SALE_PLANS.has(cloud.id),
    },
    {
      id: 'enterprise',
      title: enterprise.name,
      // Enterprise is never priced, matching the checkout routes' "contact us".
      price: 'Contact us',
      terms: [
        'Retention and anchoring cadence set by contract',
        'Volume beyond the Cloud fair-use cap',
        'Terms agreed with you, not listed here',
      ],
    },
  ];
  return cards.map((card) => withCta(card, packageHref));
}
