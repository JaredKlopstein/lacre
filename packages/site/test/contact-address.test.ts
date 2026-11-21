import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import EnterprisePage from '../app/enterprise/page.js';
import PricingPage from '../app/pricing/page.js';
import { LEGAL } from '../src/legal.js';
import { contactForwarding } from '../src/contact-forwarding.js';
import { EMAIL_ENV } from '../src/auth/email.js';

/**
 * The public contact address, and the two things that move with it.
 *
 * 1. One address, read from LEGAL. A second hard-coded copy on a page is how a
 *    site ends up showing two different addresses after one of them changes.
 * 2. The mailbox provider the Privacy Policy names. The address's domain decides
 *    which company hosts the inbox, so changing the address can silently make
 *    that disclosure false. MAILBOX_HOSTS below is the link between the two.
 * 3. What the waitlist and Enterprise forms promise. Both post to the contact
 *    route, which sends nothing while the EMAIL_* variables are unset, so the
 *    copy has to follow contactForwarding() rather than assert either state.
 */

const REPO = join(import.meta.dirname, '..', '..', '..');

/**
 * Who hosts the mailbox for each domain the project has used as a contact
 * address, from that domain's MX record, checked 2026-11-20:
 *
 *   lacre.dev            1 smtp.google.com.
 *   ascellastudios.com   1 smtp.google.com.
 *   frontierforge.tech   0 frontierforge-tech.mail.protection.outlook.com.
 *
 * LEGAL.mailboxProvider is what /privacy names as the company holding the inbox
 * that receives chain files and contact messages. Point the contact address at a
 * domain on a different provider without updating that fact and the Privacy
 * Policy names the wrong processor; this test is what stops that shipping.
 */
const MAILBOX_HOSTS: Readonly<Record<string, string>> = {
  'lacre.dev': 'Google Workspace (Gmail)',
  'ascellastudios.com': 'Google Workspace (Gmail)',
  'frontierforge.tech': 'Microsoft 365 (Exchange Online)',
};

describe('the published contact address', () => {
  it('is the Lacre address, not a second brand', () => {
    expect(LEGAL.contactEmail).toBe('hello@lacre.dev');
    expect(LEGAL.securityEmail).toBe('hello@lacre.dev');
  });

  it('appears nowhere as a hard-coded copy of the old brand', () => {
    const files = [
      'packages/site/src/site-footer.tsx',
      'packages/site/app/terms/page.tsx',
      'packages/site/app/privacy/page.tsx',
      'packages/site/app/pricing/page.tsx',
      'packages/site/app/enterprise/page.tsx',
      'docs/index.html',
    ];
    for (const file of files) {
      const text = readFileSync(join(REPO, file), 'utf8');
      expect(text, `${file} still names the old contact domain`).not.toMatch(/frontierforge/i);
    }
  });

  /**
   * legal.ts is the one file allowed to name the old domain, because it carries the
   * comment explaining why the mailbox provider moved with the address. What it may
   * not do is hold it as a value again.
   */
  it('is not still a value in the legal facts', () => {
    for (const [key, value] of Object.entries(LEGAL)) {
      if (typeof value === 'string') {
        expect(value, `LEGAL.${key} still carries the old domain`).not.toMatch(/frontierforge/i);
      }
    }
  });
});

describe('the mailbox provider the Privacy Policy names', () => {
  it('is the company that actually hosts the contact address', () => {
    const domain = LEGAL.contactEmail!.split('@')[1]!;
    const host = MAILBOX_HOSTS[domain];
    expect(host, `no MX record recorded for ${domain}: add one to MAILBOX_HOSTS`).toBeDefined();
    expect(LEGAL.mailboxProvider).toBe(host);
  });
});

/** The three variables a send needs, set to something that passes emailConfigured(). */
const SENDING = {
  [EMAIL_ENV.url]: 'https://api.resend.com/emails',
  [EMAIL_ENV.key]: 'test-key-not-a-real-credential',
  [EMAIL_ENV.from]: 'hello@lacre.dev',
} as const;

const saved = new Map<string, string | undefined>();

function setEnv(values: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(values)) {
    if (!saved.has(key)) saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  saved.clear();
});

const sendingOff = () => setEnv({ [EMAIL_ENV.url]: undefined, [EMAIL_ENV.key]: undefined, [EMAIL_ENV.from]: undefined });
const sendingOn = () => setEnv(SENDING);

const pricing = async () =>
  renderToStaticMarkup(await PricingPage({ searchParams: Promise.resolve({}) }));
const enterprise = async () =>
  renderToStaticMarkup(await EnterprisePage({ searchParams: Promise.resolve({}) }));

/** The page's visible words: tags dropped, entities decoded, runs of space collapsed. */
const unescape = (html: string) =>
  html
    .replace(/<[^>]*>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, '/')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');

describe('the waitlist says what it can actually do', () => {
  it('does not promise an email while nothing can be sent', async () => {
    sendingOff();
    expect(contactForwarding()).toBe(false);
    const html = unescape(await pricing());
    expect(html).toContain("The waitlist isn't taking sign-ups yet.");
    expect(html).toContain('email hello@lacre.dev with "Waitlist" in the subject');
    expect(html).not.toContain('we will email you when they open');
    expect(html).not.toContain('we will email you when it opens');
  });

  it('promises the email once a send would reach someone', async () => {
    sendingOn();
    expect(contactForwarding()).toBe(true);
    const html = unescape(await pricing());
    expect(html).toContain('we will email you when');
    expect(html).not.toContain("isn't taking sign-ups yet");
  });
});

describe('the Enterprise form says what it can actually do', () => {
  it('does not promise a reply while nothing can be sent', async () => {
    sendingOff();
    const html = unescape(await enterprise());
    expect(html).toContain("This form can't send messages yet.");
    expect(html).toContain('Email us at hello@lacre.dev and we reply within two business days.');
  });

  it('promises the reply once a send would reach someone', async () => {
    sendingOn();
    const html = unescape(await enterprise());
    expect(html).toContain('Tell us what you need below. We reply within two business days.');
    expect(html).not.toContain("This form can't send messages yet");
  });
});
