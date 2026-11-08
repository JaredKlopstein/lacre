import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import HowItWorksPage from '../app/how-it-works/page.js';
import SecurityPage from '../app/security/page.js';
import { LEGAL, SECURITY_REPORT_URL } from '../src/legal.js';

/**
 * Persona findings (security reviewer): the site never said where an agent's
 * signing key lives or who vouches for the keys a bundle carries, and gave no way
 * to report a vulnerability. Every claim here is checked against packages/core,
 * so the copy cannot drift from what the code does.
 */

const unescape = (s: string) =>
  s.replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const text = (html: string) => unescape(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ');
const core = (path: string) => readFileSync(new URL(`../../core/src/${path}`, import.meta.url), 'utf8');

const security = renderToStaticMarkup(SecurityPage());
const howItWorks = renderToStaticMarkup(HowItWorksPage());

/** A section's markup, found by the id of the heading that names it. */
const section = (html: string, id: string) =>
  new RegExp(`<section aria-labelledby="${id}">([\\s\\S]*?)</section>`).exec(html)?.[1] ?? '';

describe('/security: keys and identity', () => {
  const keys = text(section(security, 'keys-and-identity'));

  it('has its own section, named by its heading', () => {
    expect(security).toContain('<h2 id="keys-and-identity">Keys and identity</h2>');
  });

  it('says where the key lives and how the file is protected, as core writes it', () => {
    expect(core('config.ts')).toContain("join(storeDir, 'agent.key.json')");
    expect(core('actions/identity.ts')).toContain('{ mode: 0o600 }');
    expect(keys).toContain('writes it to agent.key.json in the store directory');
    expect(keys).toContain('mode 0600 and holds the secret key unencrypted');
    expect(keys).toContain('There is no HSM or KMS support yet');
    expect(keys).toContain('unless --store or LACRE_HOME names another');
  });

  it('says the key never leaves the machine', () => {
    expect(core('crypto/keys.ts')).toContain('Never leaves the machine, never logged.');
    expect(keys).toContain('The secret key is never sent or logged');
  });

  it('describes registration as trust on first use, which core enforces', () => {
    expect(core('agents/store.ts')).toContain("code: 'AGENT_KEY_MISMATCH'");
    expect(keys).toContain('Registration: trust on first use');
    expect(keys).toContain('registering the same id with a different key is refused');
  });

  it('says rotation and revocation do not exist yet, because core has neither', () => {
    expect(core('agents/store.ts')).toContain('key rotation is not implemented yet');
    for (const file of ['actions/identity.ts', 'agents/store.ts', 'chain/verify.ts', 'db/schema.ts']) {
      expect(core(file), file).not.toMatch(/revok|revocation/i);
    }
    expect(keys).toContain('Neither exists yet.');
    expect(keys).toContain('There is no way to revoke a key.');
  });

  it('says only the bundle vouches for its public keys, so they must be pinned out of band', () => {
    expect(keys).toContain('Only the bundle.');
    expect(keys).toContain('Pin your agents’ keys out of band');
  });
});

describe('/security: report a vulnerability', () => {
  const report = section(security, 'report-a-vulnerability');

  it('links GitHub private vulnerability reporting, and security.txt', () => {
    expect(security).toContain('<h2 id="report-a-vulnerability">Report a vulnerability</h2>');
    expect(report).toContain(`<a href="${SECURITY_REPORT_URL}">report a vulnerability on GitHub</a>`);
    expect(report).toContain('<a href="/.well-known/security.txt">/.well-known/security.txt</a>');
    expect(text(report)).toContain('Please do not open a public issue for a vulnerability.');
  });

  it('invents no email and promises no response time the owner has not set', () => {
    expect(LEGAL.securityEmail).toBeNull();
    expect(report).not.toMatch(/mailto:|@[a-z0-9-]+\./i);
    expect(text(report)).not.toMatch(/\b(within|hours?|business days?|bounty)\b/i);
  });
});

describe('/how-it-works: keys and identity', () => {
  const keys = text(section(howItWorks, 'keys-and-identity'));

  it('summarizes the same facts and links the detail on /security', () => {
    expect(howItWorks).toContain('<h2 id="keys-and-identity">Keys and identity</h2>');
    expect(keys).toContain('kept in agent.key.json in the store directory');
    expect(keys).toContain('It never leaves the machine');
    expect(keys).toContain('registered by trust on first use');
    expect(keys).toContain('There is no key rotation or revocation yet');
    expect(keys).toContain('pin your agents’ key ids out of band');
    expect(section(howItWorks, 'keys-and-identity')).toContain('href="/security#keys-and-identity"');
  });
});
