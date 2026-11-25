/**
 * The provider that sends this site's email: the configuration it needs, the one
 * fetch that sends a message, and the magic-link email built on top of both. No
 * provider SDK; the owner points EMAIL_API_URL at their provider's HTTP send
 * endpoint.
 *
 * Two surfaces send through it -- the sign-in link and the Enterprise contact
 * form -- so the configuration and the send live here once and each caller
 * passes its own log prefix. There is one provider and one set of variables; a
 * second copy of either rule is how the two would drift apart.
 *
 * Nothing here logs a secret, a token, an address or a message body. Failures are
 * logged by HTTP status or error name only, because fetch's own error messages can
 * carry the URL.
 */
import { BRAND } from '../brand';
import { CONFIRM_PATH, LINK_TTL_SECONDS, SESSION_SECRET_ENV, sessionSecret } from './session';

export const MAGIC_LINK_PATH = '/api/auth/magic-link';
export const SIGNUP_PATH = '/signup';
/** Launch guard. Sending stays off until send rate limiting turns it on with `=1`. */
export const MAGIC_LINK_FLAG_ENV = 'MAGIC_LINK_ENABLED';
export const EMAIL_ENV = { url: 'EMAIL_API_URL', key: 'EMAIL_API_KEY', from: 'EMAIL_FROM' } as const;
/** Every variable a send needs, by name. The same three serve both senders. */
export const EMAIL_SEND_ENV = [EMAIL_ENV.url, EMAIL_ENV.key, EMAIL_ENV.from] as const;
/** Every variable both auth routes need, by name. */
export const AUTH_ENV = [SESSION_SECRET_ENV, ...EMAIL_SEND_ENV] as const;

/** After a form post or a link click the routes redirect to `/signup?signup=<outcome>`. */
export const SIGNUP_OUTCOMES = ['sent', 'invalid', 'unavailable', 'failed', 'expired'] as const;
export type SignupOutcome = (typeof SIGNUP_OUTCOMES)[number];

export const MAX_EMAIL_LENGTH = 254;
// Format only: one @, no spaces, a dotted domain ending in a 2+ letter TLD.
const EMAIL = /^[^\s@<>()[\]",;:]+@[^\s@<>()[\]",;:]+\.[A-Za-z]{2,}$/;
const HOST = /^[A-Za-z0-9.-]+(:\d+)?$/;
const SEND_TIMEOUT_MS = 10_000;

type Env = Record<string, string | undefined>;

/** The provider's endpoint, its key and the address it sends from. */
export interface EmailConfig {
  url: string;
  key: string;
  from: string;
}

export interface AuthConfig {
  secret: string;
  email: EmailConfig;
}

/** One message to send. The provider takes plain text; nothing here builds HTML. */
export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

/** Which surface a log line belongs to. Each sender owns its own prefix. */
export type SendLabel = 'auth' | 'contact';

export interface MagicLinkEmail {
  subject: string;
  text: string;
}

export function magicLinkEnabled(): boolean {
  return process.env[MAGIC_LINK_FLAG_ENV] === '1';
}

/**
 * The provider configuration, or the names of the variables that are unset.
 * Logs names only: the key and the endpoint never appear in a log line.
 *
 * `label` is the caller's prefix, so a contact-form misconfiguration is not
 * reported as an auth one.
 */
export function emailConfig(label: SendLabel, env: Env = process.env): { email: EmailConfig } | { missing: readonly string[] } {
  const read = readEmailEnv(env);
  if ('email' in read) return read;
  if (read.badUrl) console.error(`${label}: ${EMAIL_ENV.url} is set but is not an https URL`);
  return { missing: read.missing };
}

/**
 * True when the three variables would give a usable provider. Logs nothing and
 * returns nothing from them, so a caller that only needs to know whether sending
 * is possible -- the Privacy Policy, by way of contactForwarding() -- can ask
 * without touching a value or writing a second copy of the rule.
 */
export function emailConfigured(env: Env = process.env): boolean {
  return 'email' in readEmailEnv(env);
}

/** Everything the auth routes need, or null when any of it is unset. Logs names only. */
export function authConfig(): AuthConfig | null {
  const secret = sessionSecret();
  const email = emailConfig('auth');
  if (!secret || 'missing' in email) {
    const missing = [secret ? null : SESSION_SECRET_ENV, ...('missing' in email ? email.missing : [])].filter(
      (name) => name !== null,
    );
    console.error(`auth: not configured; missing ${missing.join(', ')}`);
    return null;
  }
  return { secret, email: email.email };
}

export function isEmailAddress(email: string): boolean {
  return email.length <= MAX_EMAIL_LENGTH && EMAIL.test(email);
}

/**
 * The origin every link points at: BRAND.domain, then SITE_BASE_URL, then https plus
 * VERCEL_URL. Null when none is usable. The request's Host header is never consulted.
 *
 * `env` is a parameter so that a caller deciding whether links can be built -- the
 * bundle sale gate -- asks this function instead of testing the same variables
 * itself. "A value is present" and "a usable origin comes out of it" are different
 * questions, and only this function answers the second one.
 */
export function linkBase(env: Record<string, string | undefined> = process.env): string | null {
  if (BRAND.domain) return hostOrigin(BRAND.domain);
  const site = env.SITE_BASE_URL?.trim();
  if (site) {
    if (!URL.canParse(site)) return null;
    const url = new URL(site);
    const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    return url.protocol === 'https:' || (url.protocol === 'http:' && local) ? url.origin : null;
  }
  const vercel = env.VERCEL_URL?.trim();
  return vercel ? hostOrigin(vercel) : null;
}

/**
 * The base, the fixed confirm-page path and the token. Nothing else goes in the
 * link. Opening it only shows a "Sign in" button, so a mail scanner that fetches
 * every link cannot use it up.
 */
export function magicLink(base: string, token: string): string {
  const url = new URL(CONFIRM_PATH, base);
  url.searchParams.set('token', token);
  return url.toString();
}

/** Plain text only: the link, its expiry and the ignore line. No HTML, so no images. */
export function magicLinkEmail(link: string): MagicLinkEmail {
  return {
    subject: `Your ${BRAND.name} sign-in link`,
    text: [
      link,
      '',
      `This link expires in ${LINK_TTL_SECONDS / 60} minutes.`,
      '',
      "If you didn't ask for this, ignore this email.",
      '',
    ].join('\n'),
  };
}

/**
 * One message through the configured provider. True when it accepted it.
 *
 * `res.ok` rather than a particular status code: the provider documents which
 * statuses mean success no more clearly than that, so anything 2xx counts.
 */
export async function sendEmail(email: EmailConfig, message: EmailMessage, label: SendLabel): Promise<boolean> {
  try {
    const res = await fetch(email.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${email.key}` },
      body: JSON.stringify({ from: email.from, to: message.to, subject: message.subject, text: message.text }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error(`${label}: email provider rejected the send with HTTP ${res.status}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`${label}: email send failed (${err instanceof Error ? err.name : 'unknown error'})`);
    return false;
  }
}

/** Sends the sign-in link through the configured provider. True when it accepted it. */
export async function sendMagicLinkEmail(config: AuthConfig, to: string, link: string): Promise<boolean> {
  return sendEmail(config.email, { to, ...magicLinkEmail(link) }, 'auth');
}

/**
 * The three variables, read and checked, with nothing logged. `badUrl` says the
 * endpoint is set but unusable, which the logging caller reports and the silent
 * predicate ignores: either way it counts as unset.
 */
function readEmailEnv(env: Env): { email: EmailConfig } | { missing: readonly string[]; badUrl: boolean } {
  const raw = env[EMAIL_ENV.url]?.trim();
  const badUrl = Boolean(raw) && (!URL.canParse(raw!) || new URL(raw!).protocol !== 'https:');
  const url = badUrl ? undefined : raw;
  const key = env[EMAIL_ENV.key]?.trim();
  const from = env[EMAIL_ENV.from]?.trim();
  if (!url || !key || !from) {
    const names: (string | null)[] = [url ? null : EMAIL_ENV.url, key ? null : EMAIL_ENV.key, from ? null : EMAIL_ENV.from];
    return { missing: names.filter((name): name is string => name !== null), badUrl };
  }
  return { email: { url, key, from } };
}

function hostOrigin(host: string): string | null {
  return HOST.test(host) && URL.canParse(`https://${host}`) ? new URL(`https://${host}`).origin : null;
}
