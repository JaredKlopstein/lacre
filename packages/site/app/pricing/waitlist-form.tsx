'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { BRAND } from '../../src/brand';
import { CONTACT_PATH, FLEET_SIZES } from '../../src/contact';

/**
 * The early-access waitlist. It posts JSON to the existing contact route with
 * that route's own keys, so a waitlist entry arrives as a contact message whose
 * need says what it is. No payment details are asked for, and no honeypot is
 * rendered: the route's honeypot is for its native form post.
 *
 * The result is announced from live regions that are always in the page, next to
 * the button, and scrolled into view. The button is never disabled once the page
 * is interactive, so focus stays on it while a send is in flight; a second submit
 * is ignored instead.
 */

export const WAITLIST_NEED = 'Cloud early access waitlist';
/** The need prefilled while bundles cannot be bought here yet, so one list covers both. */
export const BUNDLE_WAITLIST_NEED = 'Evidence bundle and Cloud early access waitlist';
export const WAITLIST_FORM_LABEL = 'Early access waitlist';

/** The keys the contact route reads. The form sends exactly these. */
export const WAITLIST_FIELDS = ['name', 'email', 'company', 'fleetSize', 'need'] as const;
export type WaitlistField = (typeof WAITLIST_FIELDS)[number];

/** The contact route's own length limits; a longer value is refused there. */
export const WAITLIST_MAX_LENGTH = { name: 200, email: 254, company: 200, need: 5000 } as const;

const FIELD_IDS: Record<WaitlistField, string> = {
  name: 'waitlist-name',
  email: 'waitlist-email',
  company: 'waitlist-company',
  fleetSize: 'waitlist-fleet',
  need: 'waitlist-need',
};
const FIELD_LABELS: Record<WaitlistField, string> = {
  name: 'Name',
  email: 'Work email',
  company: 'Company',
  fleetSize: 'Agent fleet size',
  need: 'What you need',
};

/** The two result regions. Each is always rendered, empty until there is something to say. */
export const WAITLIST_STATUS_ID = 'waitlist-status';
export const WAITLIST_ALERT_ID = 'waitlist-alert';

// The contact route's format check for an email: one @, no spaces, a dotted domain ending in a 2+ letter TLD.
const EMAIL = /^[^\s@<>()[\]",;:]+@[^\s@<>()[\]",;:]+\.[A-Za-z]{2,}$/;

export type WaitlistResult = 'sent' | 'invalid' | 'too_large' | 'rate_limited' | 'failed' | 'unavailable' | 'error';

const RESULT_MESSAGES: Record<WaitlistResult, string> = {
  sent: "Thanks. You're on the early access list, and we'll email you when it opens.",
  invalid: 'Some details were missing or not valid, so nothing was sent. Check each field and send it again.',
  too_large: 'That message is too long, so nothing was sent. Shorten it and send it again.',
  rate_limited: 'Several messages were sent from here in a short time, so this one was not sent. Please try again in a few minutes.',
  failed: 'Your request could not be delivered, so nothing was sent. Try again shortly.',
  unavailable: 'The waitlist is unavailable right now, so nothing was sent. Try again in a few minutes.',
  error: 'Something went wrong, so nothing may have been sent. Try again shortly.',
};

/** Results where nothing reached the team for a reason that is not what was typed: another way in is offered. */
export const WAITLIST_FALLBACK_RESULTS: readonly WaitlistResult[] = ['failed', 'unavailable', 'error'];

/** The JSON body for the contact route: exactly WAITLIST_FIELDS, each a string. */
export function waitlistBody(values: { get(key: string): unknown }): Record<WaitlistField, string> {
  const body = {} as Record<WaitlistField, string>;
  for (const key of WAITLIST_FIELDS) {
    const value = values.get(key);
    body[key] = typeof value === 'string' ? value : '';
  }
  return body;
}

/** What the contact route's answer means, from its status and error code only. */
export function waitlistResult(status: number, code: unknown): WaitlistResult {
  if (status === 200) return 'sent';
  if (status === 400 && code === 'INVALID_INPUT') return 'invalid';
  if (status === 413) return 'too_large';
  if (status === 429) return 'rate_limited';
  if (status === 502) return 'failed';
  if (status === 503) return 'unavailable';
  return 'error';
}

/**
 * The fields the contact route would refuse, checked the way it checks them:
 * required after trimming, within its length caps, an email in its format and a
 * fleet size it offers. The route's answer does not name a field, so this does.
 */
export function invalidWaitlistFields(body: Record<WaitlistField, string>): WaitlistField[] {
  return WAITLIST_FIELDS.filter((key) => {
    const value = body[key].trim();
    if (!value) return true;
    if (key !== 'fleetSize' && value.length > WAITLIST_MAX_LENGTH[key]) return true;
    if (key === 'email') return !EMAIL.test(value);
    if (key === 'fleetSize') return !(FLEET_SIZES as readonly string[]).includes(value);
    return false;
  });
}

/** The invalid-result sentence, naming the fields by their labels when they are known. */
export function invalidMessage(fields: readonly WaitlistField[]): string {
  if (fields.length === 0) return RESULT_MESSAGES.invalid;
  const names = fields.map((f) => FIELD_LABELS[f]).join(', ');
  return `Nothing was sent. Check ${fields.length === 1 ? 'this field' : 'these fields'}: ${names}. Then send it again.`;
}

interface Shown {
  readonly result: WaitlistResult;
  readonly fields: readonly WaitlistField[];
}

export function WaitlistForm({ need = WAITLIST_NEED }: { need?: string }) {
  // Submitting is only possible once hydrated, so the form never falls back to
  // a native submission that would put the fields in the page URL.
  const [ready, setReady] = useState(false);
  const [sending, setSending] = useState(false);
  const [shown, setShown] = useState<Shown | null>(null);
  const inFlight = useRef(false);
  const resultsRef = useRef<HTMLDivElement>(null);
  useEffect(() => setReady(true), []);
  useEffect(() => {
    if (shown) resultsRef.current?.scrollIntoView({ block: 'nearest' });
  }, [shown]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current) return;
    inFlight.current = true;
    const form = event.currentTarget;
    const body = waitlistBody(new FormData(form));
    setSending(true);
    setShown(null);
    let result: WaitlistResult;
    try {
      const res = await fetch(CONTACT_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const answer: unknown = await res.json().catch(() => null);
      const code = (answer as { error?: { code?: unknown } } | null)?.error?.code;
      result = waitlistResult(res.status, code);
    } catch {
      result = 'error';
    }
    setShown({ result, fields: result === 'invalid' ? invalidWaitlistFields(body) : [] });
    setSending(false);
    inFlight.current = false;
    if (result === 'sent') form.reset();
  }

  const invalid = new Set(shown?.fields ?? []);
  const fieldProps = (key: WaitlistField) =>
    invalid.has(key) ? ({ 'aria-invalid': true, 'aria-describedby': WAITLIST_ALERT_ID } as const) : {};
  const error = shown && shown.result !== 'sent' ? shown : null;

  return (
    <form aria-label={WAITLIST_FORM_LABEL} onSubmit={submit}>
      <p>
        <label htmlFor={FIELD_IDS.name}>{FIELD_LABELS.name}</label>
        <input
          id={FIELD_IDS.name}
          name="name"
          type="text"
          required
          maxLength={WAITLIST_MAX_LENGTH.name}
          autoComplete="name"
          {...fieldProps('name')}
        />
      </p>
      <p>
        <label htmlFor={FIELD_IDS.email}>{FIELD_LABELS.email}</label>
        <input
          id={FIELD_IDS.email}
          name="email"
          type="email"
          required
          maxLength={WAITLIST_MAX_LENGTH.email}
          autoComplete="email"
          {...fieldProps('email')}
        />
      </p>
      <p>
        <label htmlFor={FIELD_IDS.company}>{FIELD_LABELS.company}</label>
        <input
          id={FIELD_IDS.company}
          name="company"
          type="text"
          required
          maxLength={WAITLIST_MAX_LENGTH.company}
          autoComplete="organization"
          {...fieldProps('company')}
        />
      </p>
      <p>
        <label htmlFor={FIELD_IDS.fleetSize}>{FIELD_LABELS.fleetSize}</label>
        <select id={FIELD_IDS.fleetSize} name="fleetSize" required defaultValue="" {...fieldProps('fleetSize')}>
          <option value="" disabled>
            Choose one
          </option>
          {FLEET_SIZES.map((size) => (
            <option key={size} value={size}>
              {size} agents
            </option>
          ))}
        </select>
      </p>
      <p>
        <label htmlFor={FIELD_IDS.need}>{FIELD_LABELS.need}</label>
        <textarea
          id={FIELD_IDS.need}
          name="need"
          required
          maxLength={WAITLIST_MAX_LENGTH.need}
          rows={3}
          defaultValue={need}
          {...fieldProps('need')}
        />
      </p>
      <p>
        <button type="submit" disabled={!ready} aria-disabled={sending || undefined}>
          {sending ? 'Sending…' : 'Join the list'}
        </button>
      </p>
      <div ref={resultsRef}>
        <p id={WAITLIST_STATUS_ID} role="status" data-result={shown?.result === 'sent' ? 'sent' : undefined}>
          {shown?.result === 'sent' ? RESULT_MESSAGES.sent : null}
        </p>
        <p id={WAITLIST_ALERT_ID} role="alert" data-result={error?.result}>
          {error && (error.result === 'invalid' ? invalidMessage(error.fields) : RESULT_MESSAGES[error.result])}
          {error && WAITLIST_FALLBACK_RESULTS.includes(error.result) && (
            <>
              {' '}
              You can also reach the team through the{' '}
              <a href={BRAND.repository}>project’s GitHub repository</a>, where issues are public.
            </>
          )}
        </p>
      </div>
    </form>
  );
}
