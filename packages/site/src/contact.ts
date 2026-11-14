/**
 * What the enterprise page's form and the contact route agree on. It lives here
 * because Next.js allows a page or route file to export only its own fields.
 */

export const CONTACT_PATH = '/api/contact';

/** The fleet-size choices the form offers. The route rejects anything else. */
export const FLEET_SIZES = ['1-10', '11-100', '101-1000', 'More than 1000'] as const;
export type FleetSize = (typeof FLEET_SIZES)[number];

/** The hidden field a person never sees and a form-filling bot often fills. */
export const HONEYPOT_FIELD = 'website';

/** After a form post the route redirects to `/enterprise?contact=<outcome>`. */
export const CONTACT_OUTCOMES = ['sent', 'invalid', 'not_configured', 'unavailable', 'failed', 'rate_limited'] as const;
export type ContactOutcome = (typeof CONTACT_OUTCOMES)[number];

/**
 * The two reasons nothing could be sent that are not about what was typed. They
 * are separate because only one of them can be fixed by waiting, and the page
 * and the waitlist both decide what to say from the code alone.
 *
 * `notConfigured`: the forward target is unset, so no message can be sent from
 * this deployment at all until the operator sets it. Retrying never helps, and a
 * visitor told to try again in a few minutes is being misled.
 *
 * `unavailable`: the rate limiter could not count the submission, so nothing was
 * forwarded. That is transient, and retrying can work.
 */
export const CONTACT_CODES = {
  notConfigured: 'CONTACT_NOT_CONFIGURED',
  unavailable: 'CONTACT_UNAVAILABLE',
} as const;
