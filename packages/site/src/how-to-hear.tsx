import { BRAND } from './brand';
import { LEGAL } from './legal';

/**
 * How to hear about something, on a deployment that cannot take your details.
 *
 * The waitlist and the Enterprise form both post to the contact route, which
 * sends nothing while the EMAIL_* variables are unset. The pages then offer an
 * address instead -- but an address is itself an owner-supplied fact, and
 * `contactForwarding()` is false in two different situations:
 *
 *   1. the EMAIL_* variables are unset, and there IS a contact address;
 *   2. there is no contact address at all, set or not.
 *
 * Case 2 is not hypothetical: it is the state the legal facts start in, and the
 * state checkout.test.ts drives when it clears them to test the draft-Terms
 * path. Interpolating `LEGAL.contactEmail` without checking publishes the
 * string "mailto:null" to a visitor. So the address is offered only when there
 * is one, and the repository is the fallback that is always true.
 */
export function HowToHear({ subject, purpose = 'hear' }: { subject: string; purpose?: 'hear' | 'reach' }) {
  const repository = <a href={BRAND.repository}>GitHub repository</a>;

  // Watching a repository is a way to hear about something and not a way to
  // reach anyone, so the two senses do not share a sentence.
  if (LEGAL.contactEmail === null) {
    return purpose === 'hear' ? (
      <>
        {'watch the '}
        {repository}
      </>
    ) : (
      <>
        {'open an issue on the '}
        {repository}
      </>
    );
  }

  return (
    <>
      {'email '}
      <a href={`mailto:${LEGAL.contactEmail}`}>{LEGAL.contactEmail}</a>
      {` with "${subject}" in the subject`}
      {purpose === 'hear' ? <>{', or watch the '}{repository}</> : null}
    </>
  );
}
