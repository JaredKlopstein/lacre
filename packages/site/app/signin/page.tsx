import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { cache } from 'react';
import { BRAND } from '../../src/brand';
import { SIGNUP_PATH } from '../../src/auth/email';
import { checkLinkToken } from '../../src/auth/confirm';
import { CALLBACK_PATH } from '../../src/auth/session';
import { AnnounceOutcome } from '../../src/form-outcome';

const OUTCOME_ID = 'signin-outcome';
const TITLE = 'Sign in';

// The page URL carries the sign-in token: send no Referer anywhere, and keep it out of search.
const METADATA: Metadata = {
  title: TITLE,
  description: `Confirm your ${BRAND.name} sign-in.`,
  referrer: 'no-referrer',
  robots: { index: false, follow: false },
};

type SearchParams = Record<string, string | string[] | undefined>;

// One check per request, shared by the title and the page. It never writes.
const check = cache((link: string) => checkLinkToken(link));
const linkOf = (token: string | string[] | undefined) => (typeof token === 'string' ? token : null);

/** The title says when the link could not be checked, read first after the page loads (persona review, Sam 1). */
export async function generateMetadata({ searchParams }: { searchParams: Promise<SearchParams> }): Promise<Metadata> {
  const link = linkOf((await searchParams).token);
  if (link !== null && (await check(link)).status === 'unavailable') {
    return { ...METADATA, title: `Sign-in link not checked · ${TITLE}` };
  }
  return METADATA;
}

// The emailed link lands here. Opening it only checks the link; nothing is used up
// and no one is signed in until the button below is pressed.
export default async function SigninPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const link = linkOf((await searchParams).token);
  // A direct visit has no link to check. The signup form, without consulting auth config or the database.
  if (link === null) redirect(SIGNUP_PATH);

  const result = await check(link);

  if (result.status === 'unavailable') {
    return (
      <section aria-label="Sign in">
        <h1>Sign in</h1>
        <p id={OUTCOME_ID} role="status" tabIndex={-1}>
          We couldn't check your sign-in link just now, so no one was signed in and the link hasn't been used. Try it
          again in a few minutes, or <a href={SIGNUP_PATH}>request a new link</a>.
        </p>
        <AnnounceOutcome targetId={OUTCOME_ID} />
      </section>
    );
  }
  if (result.status === 'invalid') redirect(`${SIGNUP_PATH}?signup=expired`);

  return (
    <section aria-label="Sign in">
      <h1>Sign in</h1>
      <p>
        Sign in to {BRAND.name} as <strong>{result.email}</strong>.
      </p>
      <form method="post" action={CALLBACK_PATH}>
        <input type="hidden" name="token" value={link} />
        <button type="submit">Sign in</button>
      </form>
      <p>This link works once. If you did not ask to sign in, close this page; nothing happens until you press the button.</p>
    </section>
  );
}
