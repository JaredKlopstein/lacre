/**
 * What /account shows about billing: the account's current subscription, and the
 * evidence bundles it has bought. Both as the Stripe webhook stored them in the
 * billing database. Read-only; the webhook is the only writer.
 *
 * Two reads because they are two things. A subscription is a plan; a bundle is a
 * purchase, and a buyer writes billing_bundle_credits and no subscription row.
 * Asking only the first is what made /account tell every bundle customer "No
 * plan recorded for this account yet" after their money had been taken. Cloud is
 * off sale, so bundles are the only thing anyone can buy.
 */
import { and, desc, eq, inArray } from 'drizzle-orm';
import { billingBundleCredits, billingCustomers, billingSubscriptions } from '@lacre/cloud/dist/billing/schema.js';
import { PLANS, type PlanId } from '@lacre/cloud/dist/pricing.js';
import type { BillingDb } from './billing-db';

/** Stripe statuses of a subscription that is still the customer's plan. Canceled and ended ones are not. */
const CURRENT_STATUSES = ['active', 'trialing', 'past_due'];

export interface AccountPlan {
  /** The plan's display name, from pricing.ts. */
  name: string;
  interval: 'month' | 'year';
  /** Stripe's status, as Stripe names it. */
  status: string;
  /** End of the current period: when it renews. */
  renewsAt: Date | null;
}

export async function accountPlan(db: BillingDb, accountId: string): Promise<AccountPlan | null> {
  const [row] = await db
    .select({
      plan: billingSubscriptions.plan,
      interval: billingSubscriptions.interval,
      status: billingSubscriptions.status,
      renewsAt: billingSubscriptions.currentPeriodEnd,
    })
    .from(billingSubscriptions)
    .innerJoin(billingCustomers, eq(billingCustomers.stripeCustomerId, billingSubscriptions.stripeCustomerId))
    .where(and(eq(billingCustomers.accountId, accountId), inArray(billingSubscriptions.status, CURRENT_STATUSES)))
    .orderBy(desc(billingSubscriptions.currentPeriodEnd))
    .limit(1);
  if (!row || !(row.plan in PLANS) || (row.interval !== 'month' && row.interval !== 'year')) return null;
  return { name: PLANS[row.plan as PlanId].name, interval: row.interval, status: row.status, renewsAt: row.renewsAt };
}

/** What the account has bought outright, as opposed to subscribed to. */
export interface AccountBundles {
  /** Bundles bought, summed over every Checkout Session Stripe has confirmed. */
  bought: number;
  /** When the most recent one was bought. */
  latestAt: Date;
}

/**
 * The evidence bundles this account has bought, or null if it has bought none.
 *
 * Counted, never balanced. Nothing records a bundle being used -- billing_bundle_exports
 * counts a Cloud subscription's monthly allowance, not these -- so this says how many were
 * bought and never how many are left. A "remaining" figure would be a number with nothing
 * behind it, which is the kind of claim this page already made once.
 */
export async function accountBundles(db: BillingDb, accountId: string): Promise<AccountBundles | null> {
  // An inner join drops a session Stripe completed without a customer: it ties to no account.
  const rows = await db
    .select({ credits: billingBundleCredits.credits, createdAt: billingBundleCredits.createdAt })
    .from(billingBundleCredits)
    .innerJoin(billingCustomers, eq(billingCustomers.stripeCustomerId, billingBundleCredits.stripeCustomerId))
    .where(eq(billingCustomers.accountId, accountId));
  if (rows.length === 0) return null;
  let bought = 0;
  let latestAt = rows[0]!.createdAt;
  for (const row of rows) {
    bought += row.credits;
    if (row.createdAt > latestAt) latestAt = row.createdAt;
  }
  return { bought, latestAt };
}

const LONG_DATE = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

/** "22 October 2027", in UTC like the stored period end. */
export function formatDate(date: Date): string {
  return LONG_DATE.format(date);
}
