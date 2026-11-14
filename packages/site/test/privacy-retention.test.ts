import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import PrivacyPage from '../app/privacy/page.js';
import { CONTACT_FORWARD_ENV } from '../src/contact-forwarding.js';
import { LEGAL, REQUIRED_FACTS, type LegalFacts } from '../src/legal.js';

/**
 * Which retention periods the product actually enforces, and which it keeps by
 * hand.
 *
 * contactRetention and bundleRetention are both "90 days". Nothing enforces
 * either: there is no cron, no TTL and no scheduled job anywhere in the
 * repository, and there could not be, because neither kind of data is in a
 * database Lacre owns. A chain file arrives by email and lives in the mailbox
 * named in the processor list; a contact message is forwarded straight out and
 * stored nowhere here. The only expiry any code enforces is the 15-minute
 * rate-limit window.
 *
 * So the periods stay and the sentences around them stop implying a mechanism
 * that does not exist. The test checks that every stated period is accounted
 * for -- the list of periods comes from LEGAL, not from this file -- and that
 * the one enforced expiry is still described as enforced.
 */

const render = () =>
  renderToStaticMarkup(PrivacyPage())
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ');

/** The retention facts the policy states, read from the facts themselves. */
const RETENTION_FACTS = (REQUIRED_FACTS as readonly (keyof LegalFacts)[]).filter((k) => /Retention$/.test(String(k)));

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('the retention periods the policy states', () => {
  it('are the ones this test knows about, so a new one cannot slip past it', () => {
    expect([...RETENTION_FACTS].sort()).toEqual(['bundleRetention', 'contactRetention']);
    for (const key of RETENTION_FACTS) expect(LEGAL[key], String(key)).not.toBeNull();
  });

  it('each appear with the words that say nobody automatic is keeping them', () => {
    // Both clauses are reachable only when contact forwarding is on, so the
    // configured deployment is the one that states both periods.
    vi.stubEnv(CONTACT_FORWARD_ENV, 'https://forward.example.test/leads');
    const body = render();
    for (const key of RETENTION_FACTS) {
      const period = String(LEGAL[key]);
      const at = body.indexOf(period);
      expect(at, `${String(key)} (${period}) is not on the page`).toBeGreaterThan(-1);
      // The sentence the period sits in must not promise it keeps itself.
      const around = body.slice(Math.max(0, at - 260), at + 260);
      expect(around, `${String(key)}: ${around}`).toMatch(/we delete|rather than an automatic expiry|no automatic expiry/);
    }
  });

  it('say it once, plainly, where a reader decides whether to trust them', () => {
    vi.stubEnv(CONTACT_FORWARD_ENV, 'https://forward.example.test/leads');
    const body = render();
    expect(body).toContain('a commitment we keep by hand');
    expect(body).toContain('a period no system enforces is worth exactly what the people behind it are worth');
  });

  it('no longer say "we keep them for" a period, which read as a system guarantee', () => {
    vi.stubEnv(CONTACT_FORWARD_ENV, 'https://forward.example.test/leads');
    const body = render();
    for (const key of RETENTION_FACTS) {
      expect(body).not.toContain(`we keep them for ${LEGAL[key]}`);
      expect(body).not.toContain(`We keep what reaches the inbox for ${LEGAL[key]}`);
    }
    expect(body).not.toMatch(/we keep the chain file and the bundle for/);
  });

  it('offers deletion sooner on request, since that is the only control a reader has', () => {
    vi.stubEnv(CONTACT_FORWARD_ENV, '');
    const body = render();
    expect(body).toContain('if you want yours gone sooner, ask and we will');
    expect(body).toContain(String(LEGAL.contactEmail));
  });
});

describe('the one expiry that is enforced', () => {
  it('is still described as enforced, and says what enforces it', () => {
    const body = render();
    expect(body).toContain('expire after 15 minutes');
    expect(body).toContain('enforced by the code that reads them, not by us remembering');
  });

  it('is the only period the repository has a mechanism for', () => {
    // If a purge job ever appears, this is the test that should be rewritten
    // rather than the sentence quietly re-promising automation.
    expect(RETENTION_FACTS.length).toBe(2);
  });
});
