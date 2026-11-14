import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import PrivacyPage from '../app/privacy/page.js';
import { POST } from '../app/api/contact/route.js';
import { BRAND } from '../src/brand.js';
import { CONTACT_FORWARD_ENV, contactForwarding } from '../src/contact-forwarding.js';
import { LEGAL, type LegalFacts } from '../src/legal.js';

/**
 * The Privacy Policy described a flow that does not occur.
 *
 * It said the contact form and the waitlist "send your name, work email,
 * company, fleet size and message to our team inbox, so we can reply", and that
 * we keep them for the stated retention period. In production CONTACT_FORWARD_URL
 * is unset, so nothing is forwarded to any inbox and nothing is kept: the route
 * answers without forwarding and both forms say so. A policy that is in effect
 * must not describe a disclosure that is not happening, in either direction.
 *
 * Two things are checked here, and neither is read off a copy of the wording:
 *
 *  1. contactForwarding() agrees with the route, proved by driving the route for
 *     each value rather than by sharing a constant with it.
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
  /**
   * For a given value, did the route actually forward? Driven for real, with
   * fetch and the rate limiter's database stubbed out, so the answer comes from
   * the route rather than from a second copy of its rule.
   */
  async function routeAcceptsTarget(value: string | undefined): Promise<boolean> {
    const logged: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(' ')));
    vi.stubEnv(CONTACT_FORWARD_ENV, value === undefined ? '' : value);
    await POST(
      new Request('http://site.test/api/contact', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(VALID),
      }),
    );
    // The route logs the cause of its refusal, naming the variable it blames.
    // Blaming CONTACT_FORWARD_URL is the route saying it has no usable target;
    // anything else it blames (the rate limiter's database, unset here) means
    // the value got past that check.
    return !logged.some((line) => line.includes(CONTACT_FORWARD_ENV));
  }

  const VALUES = [
    undefined,
    '   ',
    'https://forward.example.test/leads',
    'http://forward.example.test/leads',
    'ftp://forward.example.test/leads',
    'javascript:alert(1)',
    'forward.example.test/leads',
  ];

  it.each(VALUES.map((v) => [String(v), v] as const))(
    'says the same as the route for %s',
    async (_label, value) => {
      const claimed = contactForwarding(value === undefined ? {} : { [CONTACT_FORWARD_ENV]: value });
      // DATABASE_URL is unset here, so an accepted value fails at the limiter
      // instead of forwarding: both of those are "the value was accepted".
      const accepted = await routeAcceptsTarget(value);
      expect(accepted, `${value}: route accepted=${accepted}, contactForwarding=${claimed}`).toBe(claimed);
    },
  );

  it('is false for the production configuration, where the variable is unset', () => {
    expect(contactForwarding({})).toBe(false);
  });
});

describe('the Privacy Policy, where no message can be sent', () => {
  it('says nothing is sent, stored or kept, and does not describe a team inbox', () => {
    vi.stubEnv(CONTACT_FORWARD_ENV, '');
    const body = render();
    expect(body).toContain('cannot send messages at the moment');
    expect(body).toContain('Nothing you type into them is sent anywhere, stored on this website or kept by us');
    expect(body).toContain('nothing here for us to hold');
    expect(body).not.toContain('to our team inbox');
    // The retention promise goes with the flow it was about.
    expect(body).not.toMatch(/what reaches the inbox/);
  });

  it('still names the chain-file retention, which is a different thing and unaffected', () => {
    vi.stubEnv(CONTACT_FORWARD_ENV, '');
    expect(render()).toMatch(/we delete it and the bundle within \S/);
  });

  it('offers the two ways in that do work', () => {
    vi.stubEnv(CONTACT_FORWARD_ENV, '');
    const body = render();
    expect(body).toContain(LEGAL.contactEmail!);
    expect(rawRender()).toContain(`href="${BRAND.repository}"`);
  });

  it('lists no contact-forwarding processor, because there is none', () => {
    vi.stubEnv(CONTACT_FORWARD_ENV, '');
    restore = withContactProcessor('A Forwarding Service, Inc.');
    const body = render();
    expect(body).not.toContain('A Forwarding Service, Inc.');
    expect(body).not.toContain('Incomplete.');
  });
});

describe('the Privacy Policy, once a message can be sent', () => {
  const FORWARD = 'https://forward.example.test/leads';

  it('describes the flow again, and names who receives it', () => {
    vi.stubEnv(CONTACT_FORWARD_ENV, FORWARD);
    restore = withContactProcessor('A Forwarding Service, Inc.');
    const body = render();
    expect(body).toContain('send your name, work email, company, fleet size and message to our team inbox');
    expect(body).toContain(`We delete what reaches the inbox within ${LEGAL.contactRetention}`);
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
    vi.stubEnv(CONTACT_FORWARD_ENV, FORWARD);
    restore = withContactProcessor(null);
    const body = render();
    expect(body).toContain('Incomplete.');
    expect(body).toContain('passed to a service that is not yet named below');
    expect(body).toContain(LEGAL.contactEmail!);
    // And the claim it cannot support is not made.
    expect(body).not.toContain('which receives messages sent through the contact form');
  });

  it('puts the notice where the effective date is, not buried in the body', () => {
    vi.stubEnv(CONTACT_FORWARD_ENV, FORWARD);
    restore = withContactProcessor(null);
    const html = rawRender();
    const notice = html.indexOf('Incomplete.');
    expect(notice).toBeGreaterThan(-1);
    expect(notice).toBeLessThan(html.indexOf('What we collect'));
  });
});

describe('the shipped facts', () => {
  it('names a contact processor exactly when this deployment forwards messages', () => {
    // Vacuous wherever CONTACT_FORWARD_URL is unset, which is CI and production
    // today. It is here for the deployment where it is set: the page itself
    // carries the loud version of this check, which the tests above drive.
    if (contactForwarding()) expect(LEGAL.contactProcessor).not.toBeNull();
    else expect(true).toBe(true);
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
