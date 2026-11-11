import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import TermsPage, { metadata as termsMetadata } from '../app/terms/page.js';
import PrivacyPage, { metadata as privacyMetadata } from '../app/privacy/page.js';
import { GET as securityTxt } from '../app/.well-known/security.txt/route.js';
import RootLayout from '../app/layout.js';
import HomePage from '../app/page.js';
import { LegalNotice } from '../src/legal-notice.js';
import { BRAND } from '../src/brand.js';
import { LEGAL, REQUIRED_FACTS, SECURITY_REPORT_URL, fact, missingFacts, type LegalFacts } from '../src/legal.js';
import { buildSecurityTxt } from '../src/security-txt.js';
import { bundleSale } from '../src/bundle-sale.js';

/**
 * #96 (draft): Terms, Privacy, the footer's legal links and security.txt. The
 * owner supplies the entity and contact facts in src/legal.ts; until then the
 * pages say they are a draft and show bracketed placeholders, and security.txt
 * lists only GitHub private vulnerability reporting. Nothing here may invent a
 * name, address or email.
 */

const FILLED: LegalFacts = {
  entityName: 'Example Labs LLC',
  entityJurisdiction: 'a Delaware limited liability company',
  contactEmail: 'hello@example.test',
  securityEmail: 'security@example.test',
  postalAddress: null,
  effectiveDate: '2026-11-01',
  refundWindowDays: 14,
  governingLaw: 'the laws of the State of Delaware',
  emailProvider: 'Example Mail',
  contactRetention: '12 months',
  bundleRetention: '12 months',
  mailboxProvider: 'Example Mailbox',
};

const terms = () => renderToStaticMarkup(TermsPage());
const privacy = () => renderToStaticMarkup(PrivacyPage());

/**
 * The facts the owner supplied (2026-11-10). The mailbox provider hosts the inbox
 * the owner named for chain files (contact@frontierforge.tech), as the owner
 * confirmed.
 */
const SUPPLIED: LegalFacts = {
  entityName: 'Ascella Studios LLC',
  entityJurisdiction: 'a Wisconsin limited liability company',
  contactEmail: 'contact@frontierforge.tech',
  securityEmail: 'contact@frontierforge.tech',
  postalAddress: '408 N Votech Drive, Watertown, WI 53098',
  effectiveDate: '2026-11-14',
  refundWindowDays: 30,
  governingLaw: 'the laws of the State of Wisconsin',
  emailProvider: 'Resend',
  contactRetention: '90 days',
  bundleRetention: '90 days',
  mailboxProvider: 'Microsoft 365 (Exchange Online)',
};

describe('owner-supplied facts', () => {
  it('carry exactly what the owner supplied, and nothing invented', () => {
    for (const [key, value] of Object.entries(LEGAL)) {
      expect(value, key).toBe(SUPPLIED[key as keyof LegalFacts]);
    }
    expect(missingFacts()).toEqual([]);
  });

  it('render as a bracketed placeholder until set, then as the value', () => {
    expect(fact('contactEmail', { ...LEGAL, contactEmail: null })).toBe('[contact email: owner to supply]');
    expect(fact('entityName')).toBe('Ascella Studios LLC');
    expect(fact('entityName', FILLED)).toBe('Example Labs LLC');
    expect(missingFacts(FILLED)).toEqual([]);
  });

  it('the postal address is optional', () => {
    expect(REQUIRED_FACTS).not.toContain('postalAddress');
  });
});

describe('Terms and Privacy pages', () => {
  it.each([
    ['Terms', terms, termsMetadata],
    ['Privacy', privacy, privacyMetadata],
  ] as const)('%s takes effect on 2026-11-14 with every fact supplied, and shows no placeholder', (title, render, meta) => {
    const html = render();
    expect(meta.title).toBe(title);
    expect(html).toContain('<p>Effective 2026-11-14.</p>');
    expect(html).not.toMatch(/Draft, not yet in effect/);
    expect(html).not.toMatch(/owner to supply/);
  });

  it('the notice switches to the effective date once every required fact is supplied', () => {
    const filled = renderToStaticMarkup(LegalNotice({ facts: FILLED }));
    expect(filled).toBe('<p>Effective 2026-11-01.</p>');
    expect(renderToStaticMarkup(LegalNotice({ facts: { ...FILLED, contactEmail: null } }))).toContain('Draft, not yet in effect');
  });

  it('Terms cover refunds and cancellation, and state what a receipt does not prove', () => {
    const html = terms();
    expect(html).toContain('<h2>Refunds and cancellation</h2>');
    expect(html).toContain(
      'You can request a refund within 30 days of purchase by writing to contact@frontierforge.tech, for an evidence bundle we have not yet delivered.',
    );
    // A delivered bundle's timestamp has been issued and cannot be withdrawn.
    expect(html).toContain('A delivered bundle is not refundable: its timestamp has already been issued and cannot be undone.');
    expect(html).toMatch(/cancelled at any time in the billing portal/);
    expect(html).toMatch(/does not show that an\s+action happened as described/);
  });

  it('Privacy says a bundle buyer\'s chain file is received, never a key, kept for an owner-set period (D5)', () => {
    const html = privacy();
    expect(html).toContain('Your chain file, if you buy an evidence bundle.');
    expect(html).toContain('It never holds a signing key, and we never ask for one.');
    expect(html).toMatch(/we keep the chain file and the bundle for\s+90 days/);
    expect(html).toContain('Microsoft 365 (Exchange Online), which hosts the inbox that receives chain files for evidence bundles.');
    expect(html).toContain('We receive them only if you send us your chain file');
    expect(html).not.toContain('we never receive them');
    expect(REQUIRED_FACTS).toContain('bundleRetention');
    expect(REQUIRED_FACTS).toContain('mailboxProvider');
  });

  it('Privacy names what is collected, the processors, and the one essential cookie', () => {
    const html = privacy();
    for (const processor of ['Vercel', 'Neon', 'Stripe']) expect(html).toContain(processor);
    expect(html).toMatch(/Resend[^<]*sign-in/);
    expect(html).toMatch(/No analytics or advertising cookies/);
    expect(html).toMatch(/One essential cookie keeps you signed in for up to seven days/);
  });

  it('carry no price, so pricing stays in one place', () => {
    for (const file of ['../app/terms/page.tsx', '../app/privacy/page.tsx']) {
      expect(readFileSync(new URL(file, import.meta.url), 'utf8'), file).not.toMatch(/\$\d/);
    }
  });
});

describe('footer and checkout links', () => {
  const html = renderToStaticMarkup(RootLayout({ children: HomePage() }));
  const legalNav = /<nav aria-label="Legal">([\s\S]*?)<\/nav>/.exec(html)?.[1] ?? '';

  it('every page footer links Terms, Privacy, a contact and where to report a vulnerability', () => {
    expect(legalNav).toContain('href="/terms">Terms</a>');
    expect(legalNav).toContain('href="/privacy">Privacy</a>');
    expect(legalNav).toMatch(/>(Contact|Sales and enterprise)<\/a>/);
    expect(legalNav).toContain('href="/security#report-a-vulnerability">Report a vulnerability</a>');
  });

  it('links Contact to the contact email now that it is set', () => {
    expect(legalNav).toContain('href="mailto:contact@frontierforge.tech">Contact</a>');
  });

  it('checkout links the Terms and the Privacy Policy', () => {
    const src = readFileSync(new URL('../app/checkout/page.tsx', import.meta.url), 'utf8');
    expect(src).toContain('<Link href={TERMS_PATH}>Terms</Link>');
    expect(src).toContain('<Link href={PRIVACY_PATH}>Privacy Policy</Link>');
  });
});

describe('/.well-known/security.txt', () => {
  // It used to answer 404 while LEGAL.securityEmail was null. GitHub private
  // vulnerability reporting is now enabled on the repository, so there is a real,
  // non-personal contact to publish without inventing an address.
  it('lists the security email first, then GitHub private vulnerability reporting', async () => {
    const res = securityTxt();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    const body = await res.text();
    expect(SECURITY_REPORT_URL).toBe('https://github.com/JaredKlopstein/lacre/security/advisories/new');
    expect(body.split('\n').slice(0, 2)).toEqual(['Contact: mailto:contact@frontierforge.tech', `Contact: ${SECURITY_REPORT_URL}`]);
    expect(body).not.toMatch(/owner to supply/);
  });

  it('has an RFC 9116 Expires under a year ahead, and no Canonical or Policy until the site has a domain', async () => {
    const before = Date.now();
    const body = await securityTxt().text();
    const expires = /^Expires: (\S+)$/m.exec(body)?.[1] ?? '';
    expect(expires).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    const days = (Date.parse(expires) - before) / 86_400_000;
    expect(days).toBeGreaterThan(0);
    expect(days).toBeLessThan(365);
    expect(body).toMatch(/^Preferred-Languages: en$/m);
    expect(BRAND.domain).toBeNull();
    // Both must be absolute https URLs on the site's own origin, which needs a domain.
    expect(body).not.toMatch(/^(Canonical|Policy):/m);
  });

  it('once set, has the RFC 9116 Contact and an Expires under a year ahead', () => {
    const now = new Date('2026-11-01T00:00:00Z');
    const body = buildSecurityTxt(FILLED, now)!;
    expect(body).toContain('Contact: mailto:security@example.test\n');
    const expires = /^Expires: (\S+)$/m.exec(body)?.[1] ?? '';
    expect(expires).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    const days = (Date.parse(expires) - now.getTime()) / 86_400_000;
    expect(days).toBeGreaterThan(0);
    expect(days).toBeLessThan(365);
  });
});

describe('the supplied facts on the Terms and Privacy pages', () => {
  it('Terms name the entity, its form, contact, postal address and Wisconsin law', () => {
    const html = terms().replace(/&#x27;/g, "'");
    expect(html).toContain('is run by Ascella Studios LLC, a Wisconsin limited liability company');
    expect(html).toContain('contact@frontierforge.tech, or by post at 408 N Votech Drive, Watertown, WI 53098.');
    expect(html).toContain('These terms are governed by the laws of the State of Wisconsin.');
  });

  it('Privacy names the entity, its contact and postal address, and 90-day contact retention', () => {
    const html = privacy();
    expect(html).toContain('Ascella Studios LLC, a Wisconsin limited liability company, is responsible');
    expect(html).toContain('contact@frontierforge.tech or write to 408 N Votech Drive, Watertown, WI 53098.');
    expect(html).toMatch(/90 days/);
  });

  it('the Terms being in effect does not by itself open the sale: checkout and sign-in still need configuring', () => {
    expect(missingFacts()).toEqual([]);
    expect(bundleSale({}).blockers).toEqual(['checkout', 'sign-in']);
  });
});
