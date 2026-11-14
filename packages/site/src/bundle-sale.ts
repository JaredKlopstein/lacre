/**
 * Whether an evidence bundle can actually be bought on this deployment.
 *
 * Buying one needs three things at once: the owner's legal facts filled in, so
 * nobody pays under draft Terms; checkout configured, so the payment step works;
 * and email sign-in configured, because checkout is for signed-in customers only.
 * While any is missing, /pricing and /checkout say "Bundles open soon" and point at
 * the early access list instead of sending a buyer into a sign-in form that cannot
 * send. Nothing here is a switch: the sale opens by itself once the owner sets the
 * facts in src/legal.ts and the variables below.
 *
 * Checkout is checked with cloud's own config loader, the one the checkout route
 * runs, so the two cannot disagree about which variables it needs. Sign-in is
 * checked by presence only, quietly: the auth helpers log a line each time they
 * find a gap, and this runs on every pricing page view. An auth value that is set
 * but malformed still fails in the route, which answers with its own honest
 * message; the link base and the Stripe configuration are checked by the same
 * functions their routes use, so for those two the gate cannot be the optimist.
 *
 * The result names which of the three is missing, for tests and the server only.
 * Pages show one generic line and never a variable name.
 */
import { loadBillingConfig } from '@lacre/cloud/dist/billing/config.js';
import { AUTH_ENV, MAGIC_LINK_FLAG_ENV, linkBase } from './auth/email';
import { BILLING_DATABASE_ENV } from './billing-db';
import { DATABASE_URL_ENV } from './auth/used-tokens';
import { LEGAL, missingFacts, type LegalFacts } from './legal';

export type SaleBlocker = 'terms' | 'checkout' | 'sign-in';

export interface BundleSale {
  readonly open: boolean;
  /** Empty exactly when `open` is true. */
  readonly blockers: readonly SaleBlocker[];
}

type Env = Record<string, string | undefined>;

const set = (env: Env, name: string) => !!env[name]?.trim();

/**
 * The checkout route's own needs: a link base, the billing database and cloud's
 * checkout config.
 *
 * 'webhook' is in the needs list although the checkout route itself never reads
 * the webhook secret. Taking a payment and recording it are one capability, and
 * this is the gate that decides whether a payment can be taken at all: without
 * it, setting the Stripe variables would open the sale with nowhere for Stripe
 * to call back, and a customer could pay while the account's record of the
 * purchase was never written. Requiring the secret here means the sale cannot
 * open before a payment can be recorded. It is a guard against a mistake that
 * is otherwise one environment variable away, not a thing checkout needs.
 */
function checkoutConfigured(env: Env): boolean {
  // Asked of linkBase, the function the checkout route itself calls, rather than
  // of the variables it reads. This used to be
  //   BRAND.domain !== null || set(env, 'SITE_BASE_URL') || set(env, 'VERCEL_URL')
  // which tested presence, not usability: a domain linkBase rejects, a
  // SITE_BASE_URL that is plain http on a public host, or a VERCEL_URL that is
  // not a host all satisfied it. The sale would then open, a buyer would reach
  // checkout, and the route would answer 500 CHECKOUT_UNAVAILABLE for want of
  // the base this gate had just said was there. The gate and the route now
  // cannot disagree, in the same way the Stripe half already goes through
  // cloud's own config loader.
  if (linkBase(env) === null || !set(env, BILLING_DATABASE_ENV)) return false;
  try {
    // The same call cloud's checkout handler makes, plus the webhook secret; it
    // throws on any gap and logs nothing.
    loadBillingConfig(env, ['stripe', 'prices', 'webhook'], { optionalPrices: ['overage_bundle'] });
    return true;
  } catch {
    return false;
  }
}

/** The magic-link route's own needs: its launch flag, every auth variable and the rate-limit database. */
function signInConfigured(env: Env): boolean {
  return env[MAGIC_LINK_FLAG_ENV] === '1' && AUTH_ENV.every((name) => set(env, name)) && set(env, DATABASE_URL_ENV);
}

export function bundleSale(env: Env = process.env, facts: LegalFacts = LEGAL): BundleSale {
  const blockers: SaleBlocker[] = [];
  if (missingFacts(facts).length > 0) blockers.push('terms');
  if (!checkoutConfigured(env)) blockers.push('checkout');
  if (!signInConfigured(env)) blockers.push('sign-in');
  return { open: blockers.length === 0, blockers };
}
