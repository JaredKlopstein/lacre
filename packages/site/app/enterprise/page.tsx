import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { BRAND } from '../../src/brand';
import { CONTACT_OUTCOMES, CONTACT_PATH, FLEET_SIZES, HONEYPOT_FIELD, type ContactOutcome } from '../../src/contact';
import { AnnounceOutcome, KeepFields } from '../../src/form-outcome';

const TITLE = 'Enterprise';
const METADATA: Metadata = {
  title: TITLE,
  description: `Talk to the ${BRAND.name} team about Enterprise: retention, anchoring cadence and volume set by contract.`,
};

type SearchParams = Record<string, string | string[] | undefined>;

/** The short title, with the outcome in front after a redirect, read first after the page loads (persona review, Sam 1). */
export async function generateMetadata({ searchParams }: { searchParams: Promise<SearchParams> }): Promise<Metadata> {
  const { contact } = await searchParams;
  const outcome = CONTACT_OUTCOMES.find((o) => o === contact);
  return outcome ? { ...METADATA, title: `${OUTCOME_TITLES[outcome]} · ${TITLE}` } : METADATA;
}

// Enterprise has no listed price and is never sold through self-serve checkout,
// matching the billing routes' "contact us" answer. Keep dollar figures off this page.
const TERMS = [
  'Retention and anchoring cadence set by contract',
  'Volume beyond the Cloud fair-use cap',
  'Terms agreed with you, not listed here',
] as const;

/** Where to go when the form cannot take a message: the public repository, as a link. */
const repositoryLink = (
  <a href={BRAND.repository}>
    the {BRAND.name} GitHub repository
  </a>
);

// The contact route redirects a form post back here with ?contact=<outcome>.
const OUTCOME_MESSAGES: Record<ContactOutcome, ReactNode> = {
  sent: `Thanks. The ${BRAND.name} team has your message and will reply to the email you gave.`,
  invalid: 'Some details were missing or not valid, so nothing was sent. Check each field and send it again.',
  unavailable: (
    <>
      The contact form is unavailable right now, so nothing was sent. Try again in a few minutes, or reach the team
      through {repositoryLink}, where issues are public.
    </>
  ),
  failed: (
    <>
      Your message could not be delivered, so nothing was sent. Try again shortly, or reach the team through{' '}
      {repositoryLink}, where issues are public.
    </>
  ),
  rate_limited: 'Several messages were sent from here in a short time, so this one was not sent. Please try again in a few minutes.',
};

/** The outcome as the start of the document title, read first after the redirect. */
const OUTCOME_TITLES: Record<ContactOutcome, string> = {
  sent: 'Message sent',
  invalid: 'Error: check the marked fields',
  unavailable: 'Contact form unavailable',
  failed: 'Error: message not delivered',
  rate_limited: 'Message not sent: too many sent',
};

// The visible fields, by the key the route names in ?fields= and the id on the page.
const FIELDS = [
  { key: 'name', id: 'contact-name', label: 'Name' },
  { key: 'email', id: 'contact-email', label: 'Work email' },
  { key: 'company', id: 'contact-company', label: 'Company' },
  { key: 'fleetSize', id: 'contact-fleet', label: 'Agent fleet size' },
  { key: 'need', id: 'contact-need', label: 'What you need' },
] as const;
type FieldKey = (typeof FIELDS)[number]['key'];

const FORM_ID = 'contact-form';
const OUTCOME_ID = 'contact-outcome';
const STORAGE_KEY = 'contact-fields';

/** The keys the route named as invalid, known keys only, in form order. */
function invalidKeys(param: string | string[] | undefined): Set<FieldKey> {
  const named = new Set(typeof param === 'string' ? param.split(',') : []);
  return new Set(FIELDS.map((f) => f.key).filter((key) => named.has(key)));
}

// Kept off screen rather than display:none, which some bots skip. People never reach it.
const HONEYPOT_STYLE = { position: 'absolute', left: '-10000px', width: '1px', height: '1px', overflow: 'hidden' } as const;

export default async function EnterprisePage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { contact, fields } = await searchParams;
  const outcome = CONTACT_OUTCOMES.find((o) => o === contact);
  // Only "invalid" is about what was typed, and only the fields the route named are marked.
  const invalid = outcome === 'invalid' ? invalidKeys(fields) : new Set<FieldKey>();
  const errorProps = (key: FieldKey) =>
    invalid.has(key) ? ({ 'aria-invalid': true, 'aria-describedby': OUTCOME_ID } as const) : {};
  const message =
    outcome === 'invalid' && invalid.size > 0
      ? `Nothing was sent. Check ${invalid.size === 1 ? 'this field' : 'these fields'}: ${FIELDS.filter((f) => invalid.has(f.key))
          .map((f) => f.label)
          .join(', ')}. Then send it again.`
      : outcome && OUTCOME_MESSAGES[outcome];

  return (
    <>
      <section>
        <h1>Enterprise</h1>
        <p>
          For teams running agent fleets whose terms do not fit the Cloud plan. Enterprise is agreed
          by contract, not bought through checkout, and it has no listed price. Tell us what you
          need below. We reply within two business days.
        </p>
        <ul>
          {TERMS.map((term) => (
            <li key={term}>{term}</li>
          ))}
        </ul>
        <p>
          Verifying a bundle stays free for everyone, on every plan. See{' '}
          <Link href="/verify">Verify</Link>.
        </p>
      </section>
      <section aria-label="Contact">
        <h2>Contact the team</h2>
        {outcome && (
          <p id={OUTCOME_ID} role={outcome === 'sent' ? 'status' : 'alert'} tabIndex={-1} data-outcome={outcome}>
            {message}
          </p>
        )}
        <form id={FORM_ID} method="post" action={CONTACT_PATH}>
          <p>
            <label htmlFor="contact-name">Name</label>
            <input id="contact-name" name="name" type="text" required maxLength={200} autoComplete="name" {...errorProps('name')} />
          </p>
          <p>
            <label htmlFor="contact-email">Work email</label>
            <input
              id="contact-email"
              name="email"
              type="email"
              required
              maxLength={254}
              autoComplete="email"
              {...errorProps('email')}
            />
          </p>
          <p>
            <label htmlFor="contact-company">Company</label>
            <input
              id="contact-company"
              name="company"
              type="text"
              required
              maxLength={200}
              autoComplete="organization"
              {...errorProps('company')}
            />
          </p>
          <p>
            <label htmlFor="contact-fleet">Agent fleet size</label>
            <select id="contact-fleet" name="fleetSize" required defaultValue="" {...errorProps('fleetSize')}>
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
            <label htmlFor="contact-need">What you need</label>
            <textarea id="contact-need" name="need" required maxLength={5000} rows={6} {...errorProps('need')} />
          </p>
          <div aria-hidden="true" style={HONEYPOT_STYLE}>
            <label htmlFor="contact-website">Leave this field empty</label>
            <input id="contact-website" name={HONEYPOT_FIELD} type="text" tabIndex={-1} autoComplete="off" />
          </div>
          <p>
            <button type="submit">Send</button>
          </p>
        </form>
        {/* What was typed is held in this tab for one page load and put back after any outcome but "sent". */}
        <KeepFields
          formId={FORM_ID}
          fieldIds={FIELDS.map((f) => f.id)}
          storageKey={STORAGE_KEY}
          restore={!!outcome && outcome !== 'sent'}
        />
        {outcome && <AnnounceOutcome targetId={OUTCOME_ID} />}
      </section>
    </>
  );
}
