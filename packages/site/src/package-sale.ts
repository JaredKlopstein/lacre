/**
 * Whether the evidence package (NINETY_DAY_PACKAGE in cloud's pricing) is offered on this deployment.
 *
 * It is sold through a Stripe Payment Link the owner creates, so it needs two
 * things: the Terms in effect (every legal fact supplied, the same Terms gate the
 * bundle uses in src/bundle-sale.ts), and the link itself in
 * NINETY_DAY_PACKAGE_PAYMENT_LINK. It needs neither checkout nor sign-in: Stripe
 * hosts the payment page. While either is missing the card is not shown at all.
 *
 * Only a Stripe Payment Link (https://buy.stripe.com/…) is accepted, so a typo or a
 * stray value never becomes a payment button that goes somewhere else.
 */
import { LEGAL, missingFacts, type LegalFacts } from './legal';

export const PACKAGE_LINK_ENV = 'NINETY_DAY_PACKAGE_PAYMENT_LINK';

export type PackageBlocker = 'terms' | 'link';

export interface PackageSale {
  readonly open: boolean;
  /** The Payment Link, exactly when `open` is true. */
  readonly href: string | null;
  /** Empty exactly when `open` is true. */
  readonly blockers: readonly PackageBlocker[];
}

const STRIPE_PAYMENT_LINK = /^https:\/\/buy\.stripe\.com\/[A-Za-z0-9_-]+$/;

/** The link, trimmed, when it is a Stripe Payment Link; otherwise null. */
export function paymentLink(value: string | undefined): string | null {
  const link = value?.trim() ?? '';
  return STRIPE_PAYMENT_LINK.test(link) ? link : null;
}

export function packageSale(
  env: Record<string, string | undefined> = process.env,
  facts: LegalFacts = LEGAL,
): PackageSale {
  const blockers: PackageBlocker[] = [];
  if (missingFacts(facts).length > 0) blockers.push('terms');
  const href = paymentLink(env[PACKAGE_LINK_ENV]);
  if (href === null) blockers.push('link');
  return blockers.length === 0 ? { open: true, href, blockers } : { open: false, href: null, blockers };
}
