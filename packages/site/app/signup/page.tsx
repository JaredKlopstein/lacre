import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { BRAND } from '../../src/brand';
import { MAGIC_LINK_PATH, MAX_EMAIL_LENGTH, SIGNUP_OUTCOMES, type SignupOutcome } from '../../src/auth/email';
import { parseDestination, type Destination } from '../../src/auth/session';
import { AnnounceOutcome, KeepFields } from '../../src/form-outcome';
import { BUNDLE_OPENS_SOON, WAITLIST_HREF } from '../../src/plans';

const TITLE = 'Sign in or create an account';

const METADATA: Metadata = {
  title: TITLE,
  description: `Sign in to ${BRAND.name}, or create your account, with a sign-in link sent to your email.`,
};

type SearchParams = Record<string, string | string[] | undefined>;

/**
 * The short title, with the outcome in front after a redirect: "Check your email ·
 * Sign in or create an account", then the layout's brand. A screen reader reads
 * the title first after the page loads (persona review, Sam 1).
 */
export async function generateMetadata({ searchParams }: { searchParams: Promise<SearchParams> }): Promise<Metadata> {
  const { signup } = await searchParams;
  const outcome = SIGNUP_OUTCOMES.find((o) => o === signup);
  return outcome ? { ...METADATA, title: `${OUTCOME_TITLES[outcome]} · ${TITLE}` } : METADATA;
}

// The magic-link route redirects a form post back here with ?signup=<outcome> (and
// the ?for= it was sent with), and the callback does the same with ?signup=expired
// for a link that no longer works. "sent" reads the same whether or not the address
// already has an account.
const OUTCOME_MESSAGES: Record<SignupOutcome, string> = {
  sent: 'If that address can receive email, a sign-in link is on its way. It expires in 15 minutes.',
  invalid: 'That does not look like an email address, so nothing was sent. Check it and send it again.',
  unavailable: 'Email sign-up is not open yet, so nothing was sent.',
  failed: 'The sign-in email could not be sent. Try again shortly.',
  expired: 'This sign-in link is no longer valid. Request a new one.',
};

/** The outcome as the start of the document title, read first after the redirect. */
const OUTCOME_TITLES: Record<SignupOutcome, string> = {
  sent: 'Check your email',
  invalid: 'Error: not a valid email address',
  unavailable: 'Sign-up not open yet',
  failed: 'Error: sign-in email not sent',
  expired: 'Sign-in link expired',
};

// Errors in what was typed or in the send are alerts; the rest are status messages.
const ALERTS: readonly SignupOutcome[] = ['invalid', 'failed'];

// A signed-out redirect says where it came from with ?for=<destination key>.
const CONTEXT_LINES: Record<Destination, string> = {
  checkout: 'Sign in to continue to checkout.',
  account: 'Sign in to continue to your account.',
  welcome: 'Sign in to continue to getting started.',
};

// Outcomes where nothing was sent, so the address the visitor typed is put back.
const KEEP_EMAIL: readonly SignupOutcome[] = ['invalid', 'unavailable', 'failed'];

// Outcomes about what was typed: the email field is marked invalid and described by
// the message. The others (unavailable, failed, expired) are not the field's fault.
const FIELD_ERRORS: readonly SignupOutcome[] = ['invalid'];

const SIGNUP_FORM_ID = 'signup-form';
const SIGNUP_EMAIL_ID = 'signup-email';
const SIGNUP_OUTCOME_ID = 'signup-outcome';
const EMAIL_STORAGE_KEY = 'signup-email';

/** What the outcome says, with the way forward when sign-up cannot send. */
function outcomeMessage(outcome: SignupOutcome, dest: Destination | null): ReactNode {
  if (outcome !== 'unavailable') return OUTCOME_MESSAGES[outcome];
  // A buyer on the way to checkout gets the honest state of the bundle, not a dead end.
  if (dest === 'checkout') {
    return (
      <>
        Sign-in for checkout is not open yet, so nothing was sent and nothing was charged. {BUNDLE_OPENS_SOON}:{' '}
        <Link href={WAITLIST_HREF}>join the early access list</Link> and we will email you when they do.
      </>
    );
  }
  return (
    <>
      {OUTCOME_MESSAGES.unavailable} <Link href={WAITLIST_HREF}>Join the early access list</Link> to hear when it
      opens.
    </>
  );
}

export default async function SignupPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { signup, for: destination } = await searchParams;
  const outcome = SIGNUP_OUTCOMES.find((o) => o === signup);
  // ?for=account and the like ride along as a destination key; anything else is dropped.
  const dest = parseDestination(destination);
  const fieldError = !!outcome && FIELD_ERRORS.includes(outcome);

  return (
    <section aria-label="Sign in">
      <h1>{TITLE}</h1>
      {dest && <p>{CONTEXT_LINES[dest]}</p>}
      <p>
        Enter your email and we will send you a sign-in link. Your {BRAND.name} account is created the
        first time you use it. No password.
      </p>
      {outcome && (
        <p
          id={SIGNUP_OUTCOME_ID}
          role={ALERTS.includes(outcome) ? 'alert' : 'status'}
          tabIndex={-1}
          data-outcome={outcome}
        >
          {outcomeMessage(outcome, dest)}
        </p>
      )}
      <form id={SIGNUP_FORM_ID} method="post" action={MAGIC_LINK_PATH}>
        {dest && <input type="hidden" name="for" value={dest} />}
        <p>
          <label htmlFor={SIGNUP_EMAIL_ID}>Email</label>
          <input
            id={SIGNUP_EMAIL_ID}
            name="email"
            type="email"
            required
            maxLength={MAX_EMAIL_LENGTH}
            autoComplete="email"
            aria-invalid={fieldError || undefined}
            aria-describedby={fieldError ? SIGNUP_OUTCOME_ID : undefined}
          />
        </p>
        <p>
          <button type="submit">Send sign-in link</button>
        </p>
      </form>
      {/* The address is held in this tab for one page load and put back only after a refused or failed send. */}
      <KeepFields
        formId={SIGNUP_FORM_ID}
        fieldIds={[SIGNUP_EMAIL_ID]}
        storageKey={EMAIL_STORAGE_KEY}
        restore={!!outcome && KEEP_EMAIL.includes(outcome)}
      />
      {outcome && <AnnounceOutcome targetId={SIGNUP_OUTCOME_ID} />}
    </section>
  );
}
