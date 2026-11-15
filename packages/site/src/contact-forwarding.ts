/**
 * Whether this deployment can send a contact message or a waitlist entry at all.
 *
 * The contact route emails one submission to LEGAL.contactEmail through the
 * provider the owner configures in EMAIL_API_URL, EMAIL_API_KEY and EMAIL_FROM
 * -- the same provider that delivers sign-in links -- and keeps nothing itself.
 * While any of those three is unset, or the endpoint is not an https URL,
 * nothing is sent and nothing is stored: the route answers without sending, and
 * both forms say so. The same is true if there is no address to send to.
 *
 * The Privacy Policy reads this, because a policy that describes messages
 * reaching a team inbox is describing something that does not happen on a
 * deployment that cannot send one.
 *
 * The rule here is not a copy of the route's rule: both ask
 * emailConfigured(), and a test proves the two agree by driving the route
 * rather than by sharing a constant with it. For any configuration, the route
 * sends exactly when this says it can.
 *
 * Nothing here returns, logs or interpolates a value. The key is a secret of
 * the owner's, and emailConfigured() is the silent half of the pair for that
 * reason.
 */
import { EMAIL_SEND_ENV, emailConfigured } from './auth/email';
import { LEGAL } from './legal';

/** The variables a send needs, by name. The same three serve the sign-in email. */
export const CONTACT_SEND_ENV = EMAIL_SEND_ENV;

type Env = Record<string, string | undefined>;

/** True when a submission sent now would actually be forwarded somewhere. */
export function contactForwarding(env: Env = process.env): boolean {
  return LEGAL.contactEmail !== null && emailConfigured(env);
}
