import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import RootLayout from '../app/layout.js';
import HomePage from '../app/page.js';
import VerifyPage from '../app/verify/page.js';
import SignupPage from '../app/signup/page.js';
import EnterprisePage from '../app/enterprise/page.js';
import { CONTACT_OUTCOMES } from '../src/contact.js';
import { SIGNUP_OUTCOMES } from '../src/auth/email.js';

/**
 * #103: accessibility basics. A skip link is the first focusable element on every
 * page and jumps to <main>; an outcome about what was typed marks the field(s)
 * aria-invalid and describes them with the message; the :focus-visible rules from
 * #93 are kept. The automated axe run is separate (test-a11y/, #121).
 */

const css = readFileSync(new URL('../app/globals.css', import.meta.url), 'utf8');
const rules = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ');

/** Opening tags of the elements a keyboard reaches, in document order. */
const focusable = (html: string) =>
  [...html.matchAll(/<(a|button|input|select|textarea)\b[^>]*>/g)]
    .map((m) => m[0])
    .filter((tag) => !/tabindex="-1"|type="hidden"/.test(tag));

const attr = (tag: string, name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1];

const signup = async (signup?: string) =>
  renderToStaticMarkup(await SignupPage({ searchParams: Promise.resolve(signup ? { signup } : {}) }));
const enterprise = async (contact?: string) =>
  renderToStaticMarkup(await EnterprisePage({ searchParams: Promise.resolve(contact ? { contact } : {}) }));

/** The form fields people fill in, by id. The honeypot is not one. */
const fieldTags = (html: string, ids: readonly string[]) =>
  ids.map((id) => new RegExp(`<(input|select|textarea)\\b[^>]*\\bid="${id}"[^>]*>`).exec(html)?.[0] ?? '');

describe('skip link', () => {
  const html = renderToStaticMarkup(RootLayout({ children: HomePage() }));

  it('is the first focusable element on the page and points at #main', () => {
    const first = focusable(html)[0] ?? '';
    expect(first).toMatch(/^<a\b/);
    expect(attr(first, 'href')).toBe('#main');
    expect(attr(first, 'class')).toBe('skip-link');
    expect(html).toContain('>Skip to content</a>');
  });

  it('lands on <main>, which carries the id it points at, exactly once', () => {
    expect(html).toMatch(/<main id="main">/);
    expect(html.match(/\bid="main"/g)).toHaveLength(1);
  });

  it('comes before the header, so it is first on every page that uses the layout', () => {
    expect(html.indexOf('class="skip-link"')).toBeLessThan(html.indexOf('<header'));
  });

  it('is off screen until focused, then shown', () => {
    expect(rules).toMatch(/\.skip-link \{[^}]*position: absolute;[^}]*transform: translateY\(-200%\);/);
    expect(rules).toMatch(/\.skip-link:focus \{ transform: none; \}/);
    expect(rules).not.toMatch(/\.skip-link[^{]*\{[^}]*display: none/);
  });
});

describe('focus styles from #93', () => {
  it('keeps the :focus-visible rules unchanged', () => {
    expect(rules).toContain(':focus-visible { outline: 3px solid var(--color-focus); outline-offset: 2px; border-radius: 2px; }');
    expect(rules).toContain(
      'input:focus-visible, select:focus-visible, textarea:focus-visible { outline-offset: 0; border-color: var(--color-focus); }',
    );
  });
});

describe('signup: the email field and its outcome', () => {
  it('an invalid address marks the email field invalid and describes it with the message', async () => {
    const html = await signup('invalid');
    const [email] = fieldTags(html, ['signup-email']);
    expect(attr(email!, 'aria-invalid')).toBe('true');
    const describedBy = attr(email!, 'aria-describedby');
    expect(describedBy).toBeTruthy();
    // An error in what was typed is an alert (persona review, Sam 1).
    expect(html).toMatch(new RegExp(`<p id="${describedBy}" role="alert" tabindex="-1" data-outcome="invalid">That does not look like an email address`));
  });

  it.each(SIGNUP_OUTCOMES.filter((o) => o !== 'invalid'))('"%s" marks no field invalid', async (outcome) => {
    const [email] = fieldTags(await signup(outcome), ['signup-email']);
    expect(email).not.toMatch(/aria-invalid|aria-describedby/);
  });

  it('with no outcome, the field carries no error attributes', async () => {
    const [email] = fieldTags(await signup(), ['signup-email']);
    expect(email).not.toMatch(/aria-invalid|aria-describedby/);
  });
});

describe('enterprise: the contact fields and their outcome', () => {
  const FIELDS = ['contact-name', 'contact-email', 'contact-company', 'contact-fleet', 'contact-need'] as const;

  // Persona review (Sam 8): only the fields the route names in ?fields= are marked, and the message names them.
  const invalidWith = async (fields: string) =>
    renderToStaticMarkup(await EnterprisePage({ searchParams: Promise.resolve({ contact: 'invalid', fields }) }));

  it('invalid details mark only the named fields invalid and describe each with the message', async () => {
    const html = await invalidWith('email,need');
    const [name, email, company, fleet, need] = fieldTags(html, FIELDS);
    for (const tag of [email!, need!]) {
      expect(attr(tag, 'aria-invalid'), tag).toBe('true');
      expect(attr(tag, 'aria-describedby'), tag).toBe('contact-outcome');
    }
    for (const tag of [name!, company!, fleet!]) expect(tag).not.toMatch(/aria-invalid|aria-describedby/);
    expect(html).toContain(
      '<p id="contact-outcome" role="alert" tabindex="-1" data-outcome="invalid">Nothing was sent. Check these fields: Work email, What you need. Then send it again.</p>',
    );
  });

  it('ignores unknown names in ?fields=, and marks nothing when none is known', async () => {
    const html = await invalidWith('website,<script>,__proto__');
    for (const tag of fieldTags(html, [...FIELDS, 'contact-website'])) expect(tag).not.toMatch(/aria-invalid|aria-describedby/);
    expect(html).toContain('Some details were missing or not valid, so nothing was sent.');
    expect(html).not.toContain('&lt;script');
  });

  it('never marks the honeypot', async () => {
    const [honeypot] = fieldTags(await invalidWith('website,name'), ['contact-website']);
    expect(honeypot).not.toMatch(/aria-invalid|aria-describedby/);
  });

  it.each(CONTACT_OUTCOMES.filter((o) => o !== 'invalid'))('"%s" marks no field invalid', async (outcome) => {
    for (const tag of fieldTags(await enterprise(outcome), FIELDS)) {
      expect(tag).not.toMatch(/aria-invalid|aria-describedby/);
    }
  });
});

describe('code blocks', () => {
  /** Opening tags of every <pre> in the rendered markup. */
  const preTags = (html: string) => html.match(/<pre\b[^>]*>/g) ?? [];

  // Home has no code block since Exhibit A replaced the static example (revamp 4/9); any it gains
  // later must follow the same rule. Verify always has some.
  it.each([
    ['home', () => renderToStaticMarkup(HomePage()), 0],
    ['verify', () => renderToStaticMarkup(VerifyPage()), 1],
  ])('on %s, each scrolling code block is keyboard-focusable and named', (_, render, atLeast) => {
    const tags = preTags(render());
    expect(tags.length).toBeGreaterThanOrEqual(atLeast);
    for (const tag of tags) {
      expect(attr(tag, 'tabindex'), tag).toBe('0');
      expect(attr(tag, 'role'), tag).toBe('region');
      expect(attr(tag, 'aria-label'), tag).toBeTruthy();
    }
  });

  it('every page renders code through CodeBlock, so no bare <pre> can skip the keyboard access', () => {
    const app = new URL('../app/', import.meta.url);
    const pages = ['page.tsx', 'verify/page.tsx', 'welcome/page.tsx', 'how-it-works/page.tsx', 'security/page.tsx'];
    for (const page of pages) {
      expect(readFileSync(new URL(page, app), 'utf8'), page).not.toMatch(/<pre\b/);
    }
  });
});
