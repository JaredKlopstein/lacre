import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import RootLayout from '../app/layout.js';
import SignupPage, { generateMetadata } from '../app/signup/page.js';
import SigninPage, { generateMetadata as signinMetadata } from '../app/signin/page.js';
import { AnnounceOutcome, KeepFields, announceOutcome, keepFields, type KeepOptions } from '../src/form-outcome.js';
import { browser, propsOf } from './page-tree.js';

/**
 * #123: the signup page reads "Sign in or create an account", says where a
 * signed-out redirect was headed, keeps the typed email after a refused or failed
 * send, and shows ?signup=expired as a styled message inside the site layout.
 */

type Params = Record<string, string>;

const render = async (params: Params = {}) =>
  renderToStaticMarkup(await SignupPage({ searchParams: Promise.resolve(params) }));
const main = (html: string) => /<main[^>]*>([\s\S]*)<\/main>/.exec(html)?.[1] ?? '';

const rules = readFileSync(new URL('../app/globals.css', import.meta.url), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\s+/g, ' ');

describe('signup page title', () => {
  it('reads "Sign in or create an account" in the title and the heading', async () => {
    expect((await generateMetadata({ searchParams: Promise.resolve({}) })).title).toBe('Sign in or create an account');
    expect(await render()).toContain('<h1>Sign in or create an account</h1>');
  });
});

describe('signup context line', () => {
  it('shows a line matching a known ?for= destination', async () => {
    const lines = {
      checkout: 'Sign in to continue to checkout.',
      account: 'Sign in to continue to your account.',
      welcome: 'Sign in to continue to getting started.',
    };
    for (const [key, line] of Object.entries(lines)) {
      expect(await render({ for: key }), key).toContain(`</h1><p>${line}</p>`);
    }
  });

  it('shows none for an unknown or missing value', async () => {
    for (const value of ['', 'pricing', '/account', 'https://evil.example', '__proto__', '<script>']) {
      expect(await render({ for: value }), value).not.toContain('Sign in to continue');
    }
    expect(await render()).not.toContain('Sign in to continue');
  });
});

describe('signup expired link', () => {
  it('shows a styled message inside the site layout, above the form', async () => {
    const page = await SignupPage({ searchParams: Promise.resolve({ signup: 'expired' }) });
    const body = main(renderToStaticMarkup(RootLayout({ children: page })));
    const status =
      '<p id="signup-outcome" role="status" tabindex="-1" data-outcome="expired">This sign-in link is no longer valid. Request a new one.</p>';
    expect(body).toMatch(/^<section aria-label="Sign in">/);
    expect(body).toContain(status);
    expect(body.indexOf(status)).toBeLessThan(body.indexOf('<form'));
    expect(rules).toMatch(/section\[aria-label='Sign in'\] p\[role='status'\],[^{]* \{[^}]*border:[^}]*background:/);
  });
});

describe('signin confirm page', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubEnv('SESSION_SECRET', '');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('uses the same sign-in layout as the signup page', async () => {
    // No token redirects to signup. A token with auth unset still renders this page.
    const html = renderToStaticMarkup(await SigninPage({ searchParams: Promise.resolve({ token: 'not-a-real-link' }) }));
    expect(html).toMatch(/^<section aria-label="Sign in"><h1>Sign in<\/h1>/);
  });

  it('focuses its "could not check" message and says so in the title (persona review, Sam 1)', async () => {
    const page = await SigninPage({ searchParams: Promise.resolve({ token: 'not-a-real-link' }) });
    expect(renderToStaticMarkup(page)).toContain('<p id="signin-outcome" role="status" tabindex="-1">We couldn');
    expect(propsOf(page, AnnounceOutcome)).toEqual([{ targetId: 'signin-outcome' }]);
    const meta = await signinMetadata({ searchParams: Promise.resolve({ token: 'not-a-real-link' }) });
    expect(meta.title).toBe('Sign-in link not checked · Sign in');
    expect(meta.referrer).toBe('no-referrer');
    expect((await signinMetadata({ searchParams: Promise.resolve({}) })).title).toBe('Sign in');
  });
});

const tree = (params: Params = {}) => SignupPage({ searchParams: Promise.resolve(params) });

/**
 * Loads the page in the stand-in browser: runs the effect KeepFields runs, with
 * the props the page gives it. The effect runs the same on a hard load and after
 * a client-side <Link> navigation, which an inline <script> did not (persona
 * review, Marcus 8).
 */
async function load(storage: Map<string, string>, params: Params = {}) {
  const [keep] = propsOf<KeepOptions>(await tree(params), KeepFields);
  expect(keep).toBeDefined();
  const b = browser(storage, keep!.formId, keep!.fieldIds);
  keepFields(b.doc, b.storage, keep!);
  return { ...b, email: b.fields['signup-email']! };
}

/** Types an address on a fresh page, submits, then loads the page the route redirects to. */
async function sendAndLandOn(outcome: string) {
  const storage = new Map<string, string>();
  const first = await load(storage);
  first.email.value = 'ada@example.com';
  first.submit();
  const next = await load(storage, { signup: outcome });
  return { email: next.email.value, storage };
}

describe('signup email field', () => {
  it('keeps the typed email after a refused or failed send', async () => {
    for (const outcome of ['invalid', 'unavailable', 'failed']) {
      const { email, storage } = await sendAndLandOn(outcome);
      expect(email, outcome).toBe('ada@example.com');
      expect(storage.size, outcome).toBe(0);
    }
  });

  it('starts empty after a send, and after an expired link or an unknown outcome', async () => {
    for (const outcome of ['sent', 'expired', '<script>']) {
      const { email, storage } = await sendAndLandOn(outcome);
      expect(email, outcome).toBe('');
      expect(storage.size, outcome).toBe(0);
    }
  });

  it('keeps it through a client-side component, not an inline script', async () => {
    const html = await render({ signup: 'invalid' });
    expect(html).not.toContain('<script');
    const src = readFileSync(new URL('../app/signup/page.tsx', import.meta.url), 'utf8');
    expect(src).not.toMatch(/dangerouslySetInnerHTML|<script/);
  });

  it('passes nothing from the request to the component but the restore flag', async () => {
    const [plain] = propsOf<KeepOptions>(await tree({ signup: 'invalid' }), KeepFields);
    const [withFor] = propsOf<KeepOptions>(await tree({ signup: 'invalid', for: 'checkout' }), KeepFields);
    expect(withFor).toEqual(plain);
    expect(plain).toEqual({ formId: 'signup-form', fieldIds: ['signup-email'], storageKey: 'signup-email', restore: true });
  });
});

describe('signup outcome, announced (persona review, Sam 1)', () => {
  const titles = {
    sent: 'Check your email',
    invalid: 'Error: not a valid email address',
    unavailable: 'Sign-up not open yet',
    failed: 'Error: sign-in email not sent',
    expired: 'Sign-in link expired',
  } as const;

  it('focuses the message and puts the outcome first in the title, for every outcome', async () => {
    for (const [outcome, start] of Object.entries(titles)) {
      const [announce] = propsOf<{ targetId: string }>(await tree({ signup: outcome }), AnnounceOutcome);
      expect(announce, outcome).toEqual({ targetId: 'signup-outcome' });
      const b = browser(new Map(), 'signup-form', []);
      const message = { focused: false, focus() { this.focused = true; } };
      b.add('signup-outcome', message);
      announceOutcome(b.doc, announce!.targetId);
      expect(message.focused, outcome).toBe(true);
      expect(await render({ signup: outcome })).toContain('<p id="signup-outcome"');
      // The layout template appends the brand: "Check your email · Sign in or create an account · <brand>".
      const { title } = await generateMetadata({ searchParams: Promise.resolve({ signup: outcome, for: 'checkout' }) });
      expect(title, outcome).toBe(`${start} · Sign in or create an account`);
    }
  });

  it('announces nothing without an outcome', async () => {
    expect(propsOf(await tree(), AnnounceOutcome)).toEqual([]);
    expect(propsOf(await tree({ signup: '<script>' }), AnnounceOutcome)).toEqual([]);
    expect((await generateMetadata({ searchParams: Promise.resolve({ signup: '<script>' }) })).title).toBe(
      'Sign in or create an account',
    );
  });

  it('makes errors alerts and the rest status messages, each focusable by script only', async () => {
    for (const outcome of ['invalid', 'failed']) expect(await render({ signup: outcome })).toMatch(/<p id="signup-outcome" role="alert" tabindex="-1"/);
    for (const outcome of ['sent', 'unavailable', 'expired']) expect(await render({ signup: outcome })).toMatch(/<p id="signup-outcome" role="status" tabindex="-1"/);
    expect(rules).toMatch(/section\[aria-label='Sign in'\] p\[role='alert'\]/);
  });
});

describe('signup for checkout while sign-in cannot send (persona review, Marcus 3)', () => {
  it('says checkout is not open and offers the early access list, not a dead end', async () => {
    const html = await render({ signup: 'unavailable', for: 'checkout' });
    expect(html).toContain('</h1><p>Sign in to continue to checkout.</p>');
    expect(html).toContain('Sign-in for checkout is not open yet, so nothing was sent and nothing was charged.');
    expect(html).toContain('Bundles open soon');
    expect(html).toContain('<a href="/pricing#waitlist">join the early access list</a>');
  });

  it('offers the early access list on a plain sign-up too', async () => {
    const html = await render({ signup: 'unavailable' });
    expect(html).toContain('Email sign-up is not open yet, so nothing was sent.');
    expect(html).toContain('<a href="/pricing#waitlist">Join the early access list</a>');
  });
});
