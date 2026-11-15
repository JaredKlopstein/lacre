/**
 * Whether this deployment can send a contact message or a waitlist entry at all.
 *
 * The contact route forwards one submission to the URL the owner sets in
 * CONTACT_FORWARD_URL and keeps nothing itself. While that variable is unset, or
 * set to something that is not an http(s) URL, nothing is sent and nothing is
 * stored: the route answers without forwarding, and both forms say so.
 *
 * The Privacy Policy reads this, because a policy that describes messages
 * reaching a team inbox is describing something that does not happen on a
 * deployment that cannot send one. Production is such a deployment today.
 *
 * The rule here is deliberately the route's rule -- present, and an http(s) URL
 * -- and a test proves the two agree by driving the route rather than by sharing
 * a constant with it: for any value, the route forwards exactly when this says
 * it can.
 *
 * Nothing here returns, logs or interpolates the value. It is a secret of the
 * owner's.
 */

export const CONTACT_FORWARD_ENV = 'CONTACT_FORWARD_URL';

type Env = Record<string, string | undefined>;

/** True when a submission sent now would actually be forwarded somewhere. */
export function contactForwarding(env: Env = process.env): boolean {
  const value = env[CONTACT_FORWARD_ENV]?.trim();
  if (!value) return false;
  return URL.canParse(value) && /^https?:$/.test(new URL(value).protocol);
}
