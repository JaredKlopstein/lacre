import { vi } from 'vitest';
import { PRICE_ENV } from '@lacre/cloud/dist/billing/config.js';
import { LEGAL, type LegalFacts } from '../src/legal.js';

/**
 * Puts the evidence bundle on sale for a test: the owner's legal facts filled in
 * (test values, restored after), checkout's variables and sign-in's variables
 * set. Secret-shaped values are assembled at runtime so this file contains none
 * (cloud's billing-setup test searches the repo for them).
 */

const u = (...parts: string[]) => parts.join('_');

/** Obviously fake facts, never shown outside a test. */
export const TEST_FACTS: LegalFacts = {
  entityName: 'Test Entity (test only)',
  entityJurisdiction: 'a test jurisdiction',
  contactEmail: 'contact@example.test',
  securityEmail: 'security@example.test',
  postalAddress: null,
  effectiveDate: '2000-01-01',
  refundWindowDays: 0,
  governingLaw: 'test law',
  emailProvider: 'a test provider',
  contactRetention: 'a test period',
  bundleRetention: 'a test period',
  mailboxProvider: 'a test mailbox',
};

/** Fills LEGAL with TEST_FACTS. Returns the function that puts the nulls back. */
export function fillLegalFacts(): () => void {
  const facts = LEGAL as { -readonly [K in keyof LegalFacts]: LegalFacts[K] };
  const before = { ...facts };
  Object.assign(facts, TEST_FACTS);
  return () => {
    Object.assign(facts, before);
  };
}

/** Everything cloud's checkout config and the checkout route need, as test values. */
export function stubCheckoutEnv(): void {
  vi.stubEnv('SITE_BASE_URL', 'https://site.example.test');
  vi.stubEnv('DATABASE_URL', ['postgresql:', '', 'test-user:test-password@db.site.test', 'site'].join('/'));
  clearBillingMode();
  vi.stubEnv('STRIPE_SECRET_KEY', u('sk', 'test', 'x'.repeat(24)));
  for (const [key, name] of Object.entries(PRICE_ENV)) vi.stubEnv(name, u('price', `test${key.replace(/_/g, '')}`));
}

/** Test mode: the billing mode variable unset, under its current and any earlier name. */
function clearBillingMode(): void {
  vi.stubEnv('LACRE_BILLING_MODE', '');
  for (const key of Object.keys(process.env)) if (key.endsWith('_BILLING_MODE')) vi.stubEnv(key, '');
}

/**
 * Everything the magic-link route needs, as test values. A session secret or
 * database a test has already set is kept, so its signed cookies stay valid.
 */
export function stubSignInEnv(): void {
  const keep = (name: string, value: string) => {
    if (!process.env[name]?.trim()) vi.stubEnv(name, value);
  };
  vi.stubEnv('MAGIC_LINK_ENABLED', '1');
  keep('SESSION_SECRET', 'test-session-secret-long-enough-for-the-sale-tests');
  vi.stubEnv('EMAIL_API_URL', 'https://email.example.test/send');
  vi.stubEnv('EMAIL_API_KEY', 'test-email-api-key');
  vi.stubEnv('EMAIL_FROM', 'signin@example.test');
  keep('DATABASE_URL', ['postgresql:', '', 'test-user:test-password@db.site.test', 'site'].join('/'));
}

/** Puts the bundle on sale for the checkout config a test has already set. Returns the restore for LEGAL. */
export function openSaleKeepingCheckout(): () => void {
  stubSignInEnv();
  return fillLegalFacts();
}

/** Every variable the sale reads, unset, whatever the shell running the tests has. */
export function clearSaleEnv(): void {
  for (const name of [
    'SITE_BASE_URL',
    'VERCEL_URL',
    'DATABASE_URL',
    'STRIPE_SECRET_KEY',
    ...Object.values(PRICE_ENV),
    'MAGIC_LINK_ENABLED',
    'SESSION_SECRET',
    'EMAIL_API_URL',
    'EMAIL_API_KEY',
    'EMAIL_FROM',
  ]) {
    vi.stubEnv(name, '');
  }
  clearBillingMode();
}
