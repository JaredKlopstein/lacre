/**
 * Enterprise contact: a Vercel function that emails one submission to
 * LEGAL.contactEmail through the provider the owner configures in EMAIL_API_URL,
 * EMAIL_API_KEY and EMAIL_FROM -- the same provider and the same three variables
 * that deliver the sign-in link. No provider SDK; one fetch, in src/auth/email.ts.
 *
 * Enterprise has no price and is never sold through checkout, so this is the only
 * way in. It accepts the enterprise page's native form post
 * (application/x-www-form-urlencoded, answered with a 303 back to the page) and
 * JSON (answered with JSON, every error carrying its own fix).
 *
 * The provider key is a secret of the owner's: it is never logged, never
 * returned, and never interpolated into an error. fetch's own error messages can
 * contain the endpoint, so failures are logged by error name only, and the
 * configuration is reported by variable name only.
 *
 * Each valid submission counts against a per-IP limit kept in the site database
 * (DATABASE_URL) before it is sent; over the limit the answer is 429 and nothing
 * is sent. The limit fails closed: without DATABASE_URL, or when the count fails,
 * nothing is sent and the answer is a generic retryable 503 whose cause goes only
 * to the log, under the request id the response carries.
 */
import { type EmailConfig, type EmailMessage, emailConfig, sendEmail } from '../../../src/auth/email';
import { allowContact, clientIp } from '../../../src/auth/rate-limit';
// The site's auth database (DATABASE_URL), where the rate limit is kept.
import { DATABASE_URL_ENV, usedTokenDb } from '../../../src/auth/used-tokens';
import { BRAND } from '../../../src/brand';
import { CONTACT_CODES, FLEET_SIZES, HONEYPOT_FIELD, type ContactOutcome, type FleetSize } from '../../../src/contact';
// The address every submission is emailed to, and the facts the policy states.
import { LEGAL } from '../../../src/legal';

const MAX_BODY_BYTES = 16 * 1024;
/** Long enough to carry the company and the fleet size, short enough for an inbox list. */
const MAX_SUBJECT_FIELD = 120;
const LIMITS = { name: 200, email: 254, company: 200, need: 5000 } as const;
// Format only: one @, no spaces, a dotted domain ending in a 2+ letter TLD.
const EMAIL = /^[^\s@<>()[\]",;:]+@[^\s@<>()[\]",;:]+\.[A-Za-z]{2,}$/;
const NOTHING_SENT = 'Nothing was sent.';
/** The submission's keys, in the order the form shows them. */
const CONTACT_FIELDS = ['name', 'email', 'company', 'fleetSize', 'need'] as const;
const FIX_FIELDS =
  `Send name, email (a work address), company, fleetSize (one of ${FLEET_SIZES.join(', ')}) and need.`;

interface ContactSubmission {
  name: string;
  email: string;
  company: string;
  fleetSize: FleetSize;
  need: string;
}

interface ErrorBody {
  code: string;
  message: string;
  retryable: boolean;
  fix?: { note: string };
}

export async function POST(request: Request): Promise<Response> {
  const form = isForm(request);
  // An invalid form post also names the fields that failed (fixed keys only), so the
  // page marks just those: /enterprise?contact=invalid&fields=email,need.
  const reply = (status: number, outcome: ContactOutcome, body: object, bad: readonly string[] = []) =>
    form
      ? redirect(`/enterprise?contact=${outcome}${bad.length ? `&fields=${bad.join(',')}` : ''}`)
      : json(status, body);
  const fail = (status: number, outcome: ContactOutcome, error: ErrorBody, bad: readonly string[] = []) =>
    reply(status, outcome, { error }, bad);

  const target = sendTarget();
  if ('cause' in target) {
    // The answer is generic: the cause, which names the variables, goes only to
    // the log, under the request id the response carries.
    const requestId = crypto.randomUUID();
    console.error(`contact: request ${requestId}: ${target.cause}`);
    const headers = { 'x-request-id': requestId };
    // A different outcome from the retryable one below, because this cannot be
    // fixed by waiting: until the operator configures the email provider, no
    // message sent from here reaches anyone. The page says so instead of saying
    // "try again in a few minutes", which was never going to work.
    if (form) return redirect('/enterprise?contact=not_configured', headers);
    const error: ErrorBody = {
      code: CONTACT_CODES.notConfigured,
      message: `This site cannot take messages yet. ${NOTHING_SENT}`,
      retryable: false,
      fix: {
        note: `Reach the ${BRAND.name} team through ${BRAND.repository}. Quote request id ${requestId}.`,
      },
    };
    return json(503, { error, requestId }, headers);
  }

  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) {
    return fail(413, 'invalid', {
      code: 'BODY_TOO_LARGE',
      message: `Request body exceeds ${MAX_BODY_BYTES} bytes. ${NOTHING_SENT}`,
      retryable: false,
      fix: { note: `Keep "need" under ${LIMITS.need} characters.` },
    }, ['need']);
  }
  const fields = parse(request, raw);
  if (!fields) {
    return fail(400, 'invalid', {
      code: 'INVALID_INPUT',
      message: `Body must be a JSON object or a URL-encoded form. ${NOTHING_SENT}`,
      retryable: false,
      fix: { note: FIX_FIELDS },
    });
  }

  // Answer a filled honeypot exactly as a success, so a bot learns nothing.
  if (fields[HONEYPOT_FIELD]) return reply(200, 'sent', { ok: true, message: SENT });

  const checked = validate(fields);
  if (typeof checked === 'string') {
    return fail(400, 'invalid', {
      code: 'INVALID_INPUT',
      message: `${checked} ${NOTHING_SENT}`,
      retryable: false,
      fix: { note: FIX_FIELDS },
    }, invalidFields(fields));
  }

  const db = usedTokenDb();
  if (!db) return limiterDown(form, `${DATABASE_URL_ENV} is not set; the contact rate limit is kept there`);
  let allowed: boolean;
  try {
    allowed = await allowContact(db, clientIp(request.headers));
  } catch (err) {
    return limiterDown(form, `could not count the submission against its rate limit (${errorCode(err) ?? 'no error code'})`);
  }
  if (!allowed) {
    return fail(429, 'rate_limited', {
      code: 'RATE_LIMITED',
      message: `Too many messages from here in a short time. ${NOTHING_SENT}`,
      retryable: true,
      fix: { note: 'Please try again in a few minutes.' },
    });
  }

  const sent = await sendEmail(
    target.email,
    contactMessage(target.to, checked, new Date().toISOString()),
    'contact',
  );
  if (!sent) return sendFailed(fail);
  return reply(200, 'sent', { ok: true, message: SENT });
}

const SENT = `Thanks. The ${BRAND.name} team has your message and will reply to the email you gave.`;

/**
 * The provider would not take the message. `CONTACT_FORWARD_FAILED` keeps its
 * name: the waitlist branches on that code, and renaming it would change a
 * published contract for nothing.
 */
function sendFailed(fail: (status: number, outcome: ContactOutcome, error: ErrorBody) => Response) {
  return fail(502, 'failed', {
    code: 'CONTACT_FORWARD_FAILED',
    message: `Your message could not be delivered. ${NOTHING_SENT}`,
    retryable: true,
    fix: { note: 'Retry shortly. If it keeps failing, the operator can find the reason in the server log.' },
  });
}

/**
 * The rate limiter cannot count: send nothing and answer a generic, retryable
 * 503. The cause, which may name a variable, goes only to the log.
 */
function limiterDown(form: boolean, cause: string): Response {
  const requestId = crypto.randomUUID();
  console.error(`contact: request ${requestId}: ${cause}`);
  const headers = { 'x-request-id': requestId };
  if (form) return redirect('/enterprise?contact=unavailable', headers);
  const error: ErrorBody = {
    code: CONTACT_CODES.unavailable,
    message: `We couldn't take your message right now. Please try again in a few minutes. ${NOTHING_SENT}`,
    retryable: true,
    fix: { note: `If it keeps failing, reach the ${BRAND.name} team through ${BRAND.repository}. Quote request id ${requestId}.` },
  };
  return json(503, { error, requestId }, headers);
}

/** The Postgres SQLSTATE of a failed query, if any. drizzle wraps the driver's error in `cause`. */
function errorCode(err: unknown): string | null {
  for (let e: unknown = err, depth = 0; e && typeof e === 'object' && depth < 3; e = (e as { cause?: unknown }).cause, depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
  }
  return null;
}

/**
 * The provider configuration and the address to send to, or the cause nothing
 * can be sent. The cause names variables and the missing fact, never a value.
 */
function sendTarget(): { email: EmailConfig; to: string } | { cause: string } {
  const config = emailConfig('contact');
  if ('missing' in config) {
    return { cause: `the email provider is not configured; missing ${config.missing.join(', ')}` };
  }
  // Typed `string | null`: a deployment with no published contact address has
  // nowhere to send a submission, which is the same dead end as an unset
  // variable and gets the same not-retryable answer.
  const to = LEGAL.contactEmail;
  if (!to) return { cause: 'there is no contact address to send to (LEGAL.contactEmail is null)' };
  return { email: config.email, to };
}

/**
 * The message that lands in the team inbox: the five fields the form collects,
 * in the order it shows them, and when it was submitted.
 *
 * The subject has to be findable in a mailbox list, so it carries the company
 * and the fleet size -- both of them typed by a stranger. They go through
 * subjectSafe() first: a header built from a value holding a newline is how a
 * sender injects headers of its own.
 */
function contactMessage(to: string, submission: ContactSubmission, submittedAt: string): EmailMessage {
  const company = subjectSafe(submission.company);
  return {
    to,
    subject: `${BRAND.name} Enterprise enquiry: ${company} (${submission.fleetSize})`,
    text: [
      `Name: ${submission.name}`,
      `Email: ${submission.email}`,
      `Company: ${submission.company}`,
      `Fleet size: ${submission.fleetSize}`,
      `Submitted: ${submittedAt}`,
      '',
      'Message:',
      submission.need,
      '',
      `Reply to ${submission.email}.`,
      '',
    ].join('\n'),
  };
}

/** One line, no control characters, short enough for a subject. */
function subjectSafe(value: string): string {
  const flat = value.replace(/[\p{Cc}\p{Cf}\s]+/gu, ' ').trim();
  return flat.length > MAX_SUBJECT_FIELD ? `${flat.slice(0, MAX_SUBJECT_FIELD - 1)}\u2026` : flat;
}

function isForm(request: Request): boolean {
  return (request.headers.get('content-type') ?? '').startsWith('application/x-www-form-urlencoded');
}

function parse(request: Request, raw: string): Record<string, string> | null {
  if (isForm(request)) return Object.fromEntries(new URLSearchParams(raw));
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(body)) {
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}

/** Every field validate() would refuse, by key, in form order. */
function invalidFields(fields: Record<string, string>): string[] {
  const value = (key: string) => (fields[key] ?? '').trim();
  return CONTACT_FIELDS.filter((key) => {
    const v = value(key);
    if (!v) return true;
    if (key in LIMITS && v.length > LIMITS[key as keyof typeof LIMITS]) return true;
    if (key === 'email') return !EMAIL.test(v);
    if (key === 'fleetSize') return !(FLEET_SIZES as readonly string[]).includes(v);
    return false;
  });
}

/** The cleaned submission, or a sentence naming what is wrong. */
function validate(fields: Record<string, string>): ContactSubmission | string {
  const value = (key: string) => (fields[key] ?? '').trim();
  const missing = CONTACT_FIELDS.filter((k) => !value(k));
  if (missing.length > 0) return `Missing required field${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}.`;

  for (const [key, max] of Object.entries(LIMITS)) {
    if (value(key).length > max) return `${key} is longer than ${max} characters.`;
  }
  const email = value('email');
  if (!EMAIL.test(email)) return 'email is not a valid email address.';
  const fleetSize = value('fleetSize');
  if (!(FLEET_SIZES as readonly string[]).includes(fleetSize)) {
    return `fleetSize must be one of: ${FLEET_SIZES.join(', ')}.`;
  }
  return {
    name: value('name'),
    email,
    company: value('company'),
    fleetSize: fleetSize as FleetSize,
    need: value('need'),
  };
}

function redirect(location: string, extra: Record<string, string> = {}): Response {
  return new Response(null, { status: 303, headers: { ...extra, location } });
}

function json(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { ...extra, 'content-type': 'application/json; charset=utf-8' },
  });
}
