import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import PrivacyPage from '../app/privacy/page.js';
import { POST } from '../app/api/contact/route.js';
import { BRAND } from '../src/brand.js';
import { CONTACT_SEND_ENV, contactForwarding } from '../src/contact-forwarding.js';
import { LEGAL, type LegalFacts } from '../src/legal.js';

/**
 * The Privacy Policy described a flow that does not occur.
 *
 * It said the contact form and the waitlist "send your name, work email,
 * company, fleet size and message to our team inbox, so we can reply", and that
 * we keep them for the stated retention period. Until the owner configures the
 * email provider the route sends through, nothing reaches any inbox and nothing
 * is kept: the route answers without sending and both forms say so. A policy
 * that is in effect must not describe a disclosure that is not happening, in
 * either direction.
 *
 * Two things are checked here, and neither is read off a copy of the wording:
 *
 *  1. contactForwarding() agrees with the route, proved by driving the route for
 *     each configuration rather than by sharing a constant with it.
 *  2. The page says what that state actually is, and when the mechanism exists
 *     without its recipient being named, the page says that too.
 */

const render = () =>
  renderToStaticMarkup(PrivacyPage())
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ');
const rawRender = () => renderToStaticMarkup(PrivacyPage());

/** Sets LEGAL.contactProcessor for one test, and puts back what was there. */
function withContactProcessor(value: string | null): () => void {
  const facts = LEGAL as { -readonly [K in keyof LegalFacts]: LegalFacts[K] };
  const before = facts.contactProcessor;
  facts.contactProcessor = value;
  return () => {
    facts.contactProcessor = before;
  };
}

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const VALID = {
  name: 'Ada Lovelace',
  email: 'ada@example.com',
  company: 'Analytical Engines Ltd',
  fleetSize: '11-100',
  need: 'Contracted retention for receipts from our support agents.',
};

describe('contactForwarding agrees with the route it describes', () => {
  const [URL_ENV, KEY_ENV, FROM_ENV] = CONTACT_SEND_ENV;
  const HTTPS = 'https://provider.example.test/emails';
  /** A fixture, not a credential. */
  const KEY = 'fixture-not-a-real-key-0000';
  const FROM = 'site@site.test';

  /**
   * For a given configuration, did the route actually get as far as sending?
   * Driven for real, with fetch and the rate limiter's database stubbed out, so
   * the answer comes from the route rather than from a second copy of its rule.
   */
  async function routeAcceptsConfig(env: Record<string, string | undefined>): Promise<boolean> {
    const logged: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(' ')));
    for (const name of CONTACT_SEND_ENV) vi.stubEnv(name, env[name] ?? '');
    await POST(
      new Request('http://site.test/api/contact', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(VALID),
      }),
    );
    // The route logs the cause of its refusal, naming the variables it blames.
    // Blaming any of the three is the route saying it cannot send; anything
    // else it blames (the rate limiter's database, unset here) means the
    // configuration got past that check.
    return !logged.some((line) => CONTACT_SEND_ENV.some((name) => line.includes(name)));
  }

  /** Every way the three variables can be wrong, and the one way they can be right. */
  const CONFIGS: Record<string, Record<string, string | undefined>> = {
    'nothing set': {},
    'all three set': { [URL_ENV]: HTTPS, [KEY_ENV]: KEY, [FROM_ENV]: FROM },
    // The two directions the brief asks for by name: either half alone is useless.
    'the key set, the endpoint missing': { [KEY_ENV]: KEY, [FROM_ENV]: FROM },
    'the endpoint set, the key missing': { [URL_ENV]: HTTPS, [FROM_ENV]: FROM },
    'the endpoint and key set, the sender missing': { [URL_ENV]: HTTPS, [KEY_ENV]: KEY },
    'only the endpoint set': { [URL_ENV]: HTTPS },
    'only the key set': { [KEY_ENV]: KEY },
    'only the sender set': { [FROM_ENV]: FROM },
    'all three whitespace': { [URL_ENV]: '   ', [KEY_ENV]: '  ', [FROM_ENV]: ' ' },
    'the key whitespace': { [URL_ENV]: HTTPS, [KEY_ENV]: '   ', [FROM_ENV]: FROM },
    'the endpoint http, not https': { [URL_ENV]: 'http://provider.example.test/emails', [KEY_ENV]: KEY, [FROM_ENV]: FROM },
    'the endpoint ftp': { [URL_ENV]: 'ftp://provider.example.test/emails', [KEY_ENV]: KEY, [FROM_ENV]: FROM },
    'the endpoint a javascript: URL': { [URL_ENV]: 'javascript:alert(1)', [KEY_ENV]: KEY, [FROM_ENV]: FROM },
    'the endpoint not a URL at all': { [URL_ENV]: 'provider.example.test/emails', [KEY_ENV]: KEY, [FROM_ENV]: FROM },
  };

  it.each(Object.keys(CONFIGS))('says the same as the route for %s', async (label) => {
    const env = CONFIGS[label]!;
    const claimed = contactForwarding(env);
    // DATABASE_URL is unset here, so an accepted configuration fails at the
    // limiter instead of sending: both of those are "the configuration was accepted".
    const accepted = await routeAcceptsConfig(env);
    expect(accepted, `${label}: route accepted=${accepted}, contactForwarding=${claimed}`).toBe(claimed);
  });

  it('is true for exactly one of those configurations: all three set and usable', () => {
    const can = Object.keys(CONFIGS).filter((label) => contactForwarding(CONFIGS[label]!));
    expect(can).toEqual(['all three set']);
  });

  it('is false for the production configuration, where the variables are unset', () => {
    expect(contactForwarding({})).toBe(false);
  });

  it('is false with the variables set but no address to send to', () => {
    const facts = LEGAL as { -readonly [K in keyof LegalFacts]: LegalFacts[K] };
    const before = facts.contactEmail;
    facts.contactEmail = null;
    try {
      expect(contactForwarding({ [URL_ENV]: HTTPS, [KEY_ENV]: KEY, [FROM_ENV]: FROM })).toBe(false);
    } finally {
      facts.contactEmail = before;
    }
  });
});

describe('the Privacy Policy, where no message can be sent', () => {
  it('says nothing is sent, stored or kept, and does not describe a team inbox', () => {
    for (const name of CONTACT_SEND_ENV) vi.stubEnv(name, '');
    const body = render();
    expect(body).toContain('cannot send messages at the moment');
    expect(body).toContain('Nothing you type into them is sent anywhere, stored on this website or kept by us');
    expect(body).toContain('nothing here for us to hold');
    expect(body).not.toContain('to our team inbox');
    // The retention promise goes with the flow it was about.
    expect(body).not.toMatch(/We keep what reaches the inbox/);
  });

  it('still names the chain-file retention, which is a different thing and unaffected', () => {
    for (const name of CONTACT_SEND_ENV) vi.stubEnv(name, '');
    expect(render()).toMatch(/we keep the chain file and the bundle for \S/);
  });

  it('offers the two ways in that do work', () => {
    for (const name of CONTACT_SEND_ENV) vi.stubEnv(name, '');
    const body = render();
    expect(body).toContain(LEGAL.contactEmail!);
    expect(rawRender()).toContain(`href="${BRAND.repository}"`);
  });

  it('lists no contact-forwarding processor, because there is none', () => {
    for (const name of CONTACT_SEND_ENV) vi.stubEnv(name, '');
    restore = withContactProcessor('A Forwarding Service, Inc.');
    const body = render();
    expect(body).not.toContain('A Forwarding Service, Inc.');
    expect(body).not.toContain('Incomplete.');
  });
});

describe('the Privacy Policy, once a message can be sent', () => {
  /** The three variables set to a usable provider. Fixtures, not credentials. */
  const CONFIGURED = {
    EMAIL_API_URL: 'https://provider.example.test/emails',
    EMAIL_API_KEY: 'fixture-not-a-real-key-0000',
    EMAIL_FROM: 'site@site.test',
  } as const;
  const configure = () => {
    for (const [name, value] of Object.entries(CONFIGURED)) vi.stubEnv(name, value);
  };

  it('describes the flow again, and names who receives it', () => {
    configure();
    restore = withContactProcessor('A Forwarding Service, Inc.');
    const body = render();
    expect(body).toContain('send your name, work email, company, fleet size and message to our team inbox');
    expect(body).toContain(`We keep what reaches the inbox for ${LEGAL.contactRetention}`);
    expect(body).toContain('A Forwarding Service, Inc., which receives messages sent through the contact form');
    expect(body).not.toContain('Incomplete.');
  });

  /**
   * The state this change exists to make impossible to ship quietly: the
   * mechanism configured, the recipient not disclosed. It is a real third party
   * receiving people's names and work email addresses, and the processor list
   * would not mention it.
   */
  it('says on the page that it is incomplete while the recipient is not named', () => {
    configure();
    restore = withContactProcessor(null);
    const body = render();
    expect(body).toContain('Incomplete.');
    expect(body).toContain('passed to a service that is not yet named below');
    expect(body).toContain(LEGAL.contactEmail!);
    // And the claim it cannot support is not made.
    expect(body).not.toContain('which receives messages sent through the contact form');
  });

  /**
   * The contact form sends through the same provider as the sign-in link, so the
   * processor list has one company to name, not two. Naming it twice would read
   * as two separate recipients; naming it once in the old, narrower words --
   * "delivers sign-in emails" -- would understate what it sees. So the entry is
   * widened. Widening is the only direction this page may move in.
   */
  it('widens the provider entry rather than naming the same company twice', () => {
    configure();
    restore = withContactProcessor(LEGAL.emailProvider);
    const body = render();
    expect(body).toContain(
      `${LEGAL.emailProvider}, which delivers sign-in emails and carries the messages sent through the contact form and the waitlist.`,
    );
    // Once, as one processor.
    expect(body.split(LEGAL.emailProvider!).length - 1).toBe(1);
    expect(body).not.toContain('which receives messages sent through the contact form');
    expect(body).not.toContain('Incomplete.');
  });

  it('still lists a separate entry when the carrier is a different company', () => {
    configure();
    restore = withContactProcessor('A Forwarding Service, Inc.');
    const body = render();
    // The sign-in line keeps its narrower claim, which is all it can support.
    expect(body).toContain(`${LEGAL.emailProvider}, which delivers sign-in emails.`);
    expect(body).toContain('A Forwarding Service, Inc., which receives messages sent through the contact form');
  });

  /**
   * Contact messages land in the same mailbox that receives chain files, so that
   * entry understated what the inbox sees as soon as sending became possible.
   */
  it('says the mailbox now receives contact messages too', () => {
    configure();
    const body = render();
    expect(body).toContain(
      `${LEGAL.mailboxProvider}, which hosts the inbox that receives chain files for evidence bundles and the messages sent through the contact form and the waitlist.`,
    );
  });

  it('puts the notice where the effective date is, not buried in the body', () => {
    configure();
    restore = withContactProcessor(null);
    const html = rawRender();
    const notice = html.indexOf('Incomplete.');
    expect(notice).toBeGreaterThan(-1);
    expect(notice).toBeLessThan(html.indexOf('What we collect'));
  });
});

describe('the shipped facts', () => {
  it('names a contact processor exactly when this deployment forwards messages', () => {
    // Vacuous wherever the EMAIL_API_* variables are unset, which is CI today.
    // It is here for the deployment where they are set: the page itself
    // carries the loud version of this check, which the tests above drive.
    if (contactForwarding()) expect(LEGAL.contactProcessor).not.toBeNull();
    else expect(true).toBe(true);
  });

  it('names the provider that carries contact messages as the one that sends email', () => {
    // The route sends through the sign-in provider, so these two are one company.
    // If a future change points contact messages elsewhere, this fails and the
    // page's processor list has to grow an entry for whoever that is.
    expect(LEGAL.contactProcessor).toBe(LEGAL.emailProvider);
    expect(LEGAL.contactProcessor).not.toBeNull();
  });

  it('keeps contactProcessor out of the facts the documents cannot take effect without', async () => {
    // Required and null would put a bracketed placeholder on a page that is in
    // effect, and would read as a draft document. Optional and null is honest:
    // there is nobody to name until the owner points the variable somewhere.
    const { REQUIRED_FACTS, missingFacts } = await import('../src/legal.js');
    expect([...REQUIRED_FACTS]).not.toContain('contactProcessor');
    expect(missingFacts(LEGAL)).toEqual([]);
  });
});
