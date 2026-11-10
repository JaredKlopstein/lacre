import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  OVERAGE_BUNDLE_PRICE_USD,
  PAYG_BUNDLE_PRICE_USD,
  PLANS,
} from '../packages/cloud/src/pricing.js';

/**
 * The landing page in docs/ is a public site. These tests pin the launch-readiness
 * files a crawler and a browser expect to find: robots.txt, sitemap.xml, and the
 * security policy (docs/_headers for a header-capable host, meta equivalents for
 * GitHub Pages, which cannot send custom headers).
 */

const DOCS = new URL('../docs/', import.meta.url).pathname;
const SITE = 'https://jaredklopstein.github.io/lacre';
/** Where the rename notice sends readers while no Lacre site deployment is serving. */
const REPOSITORY = 'https://github.com/JaredKlopstein/lacre';

const read = (name: string) => readFileSync(join(DOCS, name), 'utf8');

describe('robots.txt', () => {
  const robots = read('robots.txt');

  it('allows crawlers', () => {
    expect(robots).toMatch(/^User-agent:\s*\*$/m);
    expect(robots).toMatch(/^Allow:\s*\/$/m);
    expect(robots).not.toMatch(/^Disallow:\s*\/$/m);
  });

  it('points at the sitemap that exists', () => {
    expect(robots).toContain(`Sitemap: ${SITE}/sitemap.xml`);
  });
});

describe('sitemap.xml', () => {
  const sitemap = read('sitemap.xml');

  it('is a sitemap document listing the landing page', () => {
    expect(sitemap.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(sitemap).toContain('xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"');
    expect(sitemap).toContain(`<loc>${SITE}/</loc>`);
  });
});

describe('_headers', () => {
  const headers = read('_headers');

  it('applies the policy to every path', () => {
    expect(headers).toMatch(/^\/\*$/m);
  });

  it('sets the four headers preflight checks', () => {
    expect(headers).toMatch(/^\s+X-Content-Type-Options: nosniff$/m);
    expect(headers).toMatch(
      /^\s+Referrer-Policy: (no-referrer|strict-origin|strict-origin-when-cross-origin)$/m,
    );
    expect(headers).toMatch(/^\s+X-Frame-Options: DENY$/m);
    expect(headers).toMatch(/^\s+Content-Security-Policy: .*frame-ancestors 'none'/m);
  });
});

describe('index.html', () => {
  const html = read('index.html');

  it('declares the CSP a browser can honour from a meta tag', () => {
    expect(html).toMatch(
      /<meta http-equiv="Content-Security-Policy" content="[^"]*frame-ancestors 'none'[^"]*">/,
    );
  });

  it('declares a referrer policy', () => {
    expect(html).toMatch(
      /<meta name="referrer" content="(no-referrer|strict-origin|strict-origin-when-cross-origin)">/,
    );
  });

  // lacre-site.vercel.app answered 404 on 2026-11-08: no Lacre site deployment is
  // serving. Until a canonical host is chosen and serving, the page names none and
  // sends readers to the repository, which is.
  it('says the product is now Lacre and points at the repository, not at an unserved host', () => {
    expect(html).toContain(`Provenant is now Lacre. Source and docs are at <a href="${REPOSITORY}">`);
    expect(html).not.toMatch(/<link rel="canonical"/);
    expect(html).not.toMatch(/vercel\.app/);
  });

  it('never redirects on a timer, so the demo stays usable (WCAG 2.2.1)', () => {
    expect(html).not.toMatch(/http-equiv="refresh"/i);
    expect(html).not.toMatch(/location\.(href|replace|assign)/);
  });

  it('keeps a clickjacking guard, since GitHub Pages cannot send X-Frame-Options', () => {
    expect(html).toContain('if (self !== top)');
  });

  it('keeps the CSP compatible with what the page actually loads', () => {
    const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]*)">/.exec(html)?.[1];
    expect(csp).toBeDefined();
    // The page has an inline <style>, an inline <script> and Google-hosted fonts.
    expect(csp).toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).toContain("style-src 'self' 'unsafe-inline' https://fonts.googleapis.com");
    expect(csp).toContain('font-src https://fonts.gstatic.com');
    expect(html).toContain('https://fonts.googleapis.com/css2?');
  });

  it('opens with a skip link to <main>, and keeps the moved banner inside the header landmark', () => {
    const body = html.slice(html.indexOf('<body>') + '<body>'.length).trimStart();
    expect(body.startsWith('<a class="skip" href="#main">Skip to content</a>')).toBe(true);
    expect(html).toMatch(/<main class="wrap" id="main"[^>]*>/);
    const header = /<header>([\s\S]*?)<\/header>/.exec(html)?.[1] ?? '';
    expect(header).toContain('<div class="moved">');
    expect(html.match(/class="moved"/g)).toHaveLength(1);
  });

  it('makes the scrolling quick-start block keyboard-focusable and names it', () => {
    const tags = html.match(/<pre class="cmd"[^>]*>/g) ?? [];
    expect(tags).toHaveLength(1);
    expect(tags[0]).toContain('tabindex="0"');
    expect(tags[0]).toContain('role="region"');
    expect(tags[0]).toContain('aria-label="Quick start commands"');
  });

  it('keeps the quick start out of ~/.lacre, as docs/getting-started.md does', () => {
    const cmd = /<pre class="cmd"[^>]*>([\s\S]*?)<\/pre>/.exec(html)?.[1] ?? '';
    const step = 'export LACRE_HOME="$PWD/.lacre"';
    expect(read('getting-started.md')).toContain(step);
    expect(cmd).toContain(step);
    expect(cmd.indexOf(step)).toBeLessThan(cmd.indexOf('lacre.mjs init'));
    expect(cmd.indexOf(step)).toBeGreaterThan(cmd.indexOf('pnpm run build'));
  });
});

/**
 * The "operator holds the keys" plates quote the tools. They used to claim to be
 * verbatim while paraphrasing; now they are real output, trimmed with … marks.
 * Every quoted sentence must still be one the tools actually print.
 */
describe('terminal plates', () => {
  const html = read('index.html');
  const src = (path: string) => readFileSync(new URL(`../packages/${path}`, import.meta.url), 'utf8');
  const plates = [...html.matchAll(/<div class="plate">[\s\S]*?<pre>([\s\S]*?)<\/pre>/g)].map((m) =>
    m[1]!.replace(/<[^>]+>/g, ''),
  );

  it('no longer claims to be verbatim, and says it is trimmed', () => {
    expect(html).not.toMatch(/verbatim/i);
    expect(html).toContain("Both are the tools' real output, trimmed where you see …");
    expect(plates).toHaveLength(2);
    for (const plate of plates) expect(plate).toContain('…');
  });

  it('quotes chain verify’s own JSON, including the self-attested anchor_note', () => {
    const [local] = plates;
    const note = 'This chain is self-attested: it proves internal consistency only. An operator with database access could have rewritten the entire history, including this result.';
    expect(src('core/src/actions/chain.ts')).toContain(note);
    expect(local).toContain('"ok": true');
    expect(local).toContain('"failures": []');
    expect(local).toContain('"anchored": false');
    expect(local).toContain(`"anchor_note": "${note} …"`);
  });

  it('quotes the verifier’s forgery verdict in full, down to "Do not trust this bundle."', () => {
    const [, anchored] = plates;
    const verifier = src('verifier/src/bundle.ts');
    for (const line of ['VERIFICATION FAILED / FORGERY DETECTED', 'ANCHOR_HEAD_MISMATCH']) {
      expect(anchored).toContain(line);
      expect(verifier + src('verifier/src/cli.ts')).toContain(line);
    }
    const verdict = 'VERIFICATION FAILED / FORGERY DETECTED. The receipts in this bundle do not produce the head that was externally timestamped at seq 2. Someone altered the history after it was anchored, and could not forge a replacement timestamp. Do not trust this bundle.';
    expect(anchored.replace(/<[^>]+>/g, '')).toContain(verdict);
    // bundle.ts builds the sentence from the canonical verdict name plus string
    // pieces split across lines.
    expect(verifier).toContain("'VERIFICATION FAILED / FORGERY DETECTED'");
    expect(verifier).toContain('`${v.verdict}. The receipts in this bundle do not produce the head that was `');
    expect(verifier).toContain('`was anchored, and could not forge a replacement timestamp. Do not trust this bundle.`');
  });
});

describe('Exhibit A on the landing page', () => {
  const html = read('index.html');

  it('does not imply its anchor can be checked from the page, and points at the sample bundle', () => {
    expect(html).not.toContain('These are three real receipts');
    expect(html).not.toContain('The chain above is real.');
    const note = "not the timestamp token itself, so the anchor can’t be checked from here. To check one, verify the sample bundle below.";
    expect(html.replace(/\s+/g, ' ').replace(/\\u2019/g, '’')).toContain(note);
    expect(html).toMatch(/sample bundle in the repository, with its timestamp token,\s+so you can check the anchor yourself\. It is a different chain from Exhibit A\./);
  });
});

/**
 * The pricing cards are the public price list. Each card carries a data-tier
 * attribute so these assertions can be scoped to one card: a term that moves to
 * the wrong card, or drops out of it, must fail here even if it still appears
 * somewhere else on the page.
 */
describe('pricing cards', () => {
  const html = read('index.html');

  /** The markup of every card, keyed by its data-tier value. */
  function cards(): Map<string, string> {
    const start = html.indexOf('<div class="tiers">');
    expect(start).toBeGreaterThan(-1);
    const block = html.slice(start, html.indexOf('</section>', start));
    const found = new Map<string, string>();
    const parts = block.split(/(?=<div class="tier[^"]*" data-tier=")/).slice(1);
    for (const part of parts) {
      const tier = /data-tier="([^"]+)"/.exec(part)?.[1];
      if (tier) found.set(tier, part);
    }
    return found;
  }

  const price = (card: string) => /<div class="price">([^<]*)<\/div>/.exec(card)?.[1];

  it('shows exactly four cards, in order', () => {
    expect([...cards().keys()]).toEqual(['core', 'bundle', 'cloud', 'enterprise']);
    expect(html.match(/<div class="tier[ "]/g)).toHaveLength(4);
  });

  it('prices each card', () => {
    const c = cards();
    expect(price(c.get('core')!)).toMatch(/free/i);
    expect(price(c.get('bundle')!)).toBe(`$${PAYG_BUNDLE_PRICE_USD} each`);
    expect(price(c.get('cloud')!)).toBe(
      `$${PLANS.cloud.monthlyUsd}/mo or $${PLANS.cloud.annualUsd}/yr`,
    );
    expect(price(c.get('enterprise')!)).toMatch(/contact us/i);
  });

  it('no longer advertises the old $99 bundle price', () => {
    expect(html).not.toContain('$99 per bundle');
    // The tamper demo's dollar figure is part of the exhibit, not a price.
    expect(html).toContain('Alter the refund to $99,999');
  });

  it('lists every Cloud term on the Cloud card', () => {
    const cloud = cards().get('cloud')!;
    expect(cloud).toContain('$49/mo or $490/yr');
    expect(cloud).toMatch(/5 bundles\/month, no rollover/);
    expect(cloud).toContain('$10 per extra bundle');
    expect(cloud).toMatch(/\b10 agent identities included/);
    expect(cloud).toContain('$4/mo per extra identity');
    expect(cloud).toContain('90-day retention');
    expect(cloud).toMatch(/\b(1M|1,000,000) receipts\/month fair-use cap/);
    expect(cloud).toMatch(/at most 15 minutes/);
  });

  it('matches the cloud plan in pricing.ts', () => {
    const cloud = cards().get('cloud')!;
    const p = PLANS.cloud;
    expect(p.fairUseReceiptsPerMonth).toBe(1_000_000);
    expect(cloud).toContain(`${p.includedBundlesPerMonth} bundles/month, no rollover`);
    expect(cloud).toContain(`$${OVERAGE_BUNDLE_PRICE_USD} per extra bundle`);
    expect(cloud).toContain(`${p.includedAgentIdentities} agent identities included`);
    expect(cloud).toContain(`$${p.perExtraIdentityUsd}/mo per extra identity`);
    expect(cloud).toContain(`${p.retentionDays}-day retention`);
    expect(cloud).toContain(`at most ${p.maxAnchorIntervalMinutes} minutes`);
  });

  it('labels Cloud Early access and its terms as planned, since it is off sale', () => {
    const cloud = cards().get('cloud')!;
    expect(cloud).toContain('<strong>Early access</strong>: not on sale yet.');
    expect(cloud).toContain('Planned, not available yet');
    expect(cloud.indexOf('Planned, not available yet')).toBeLessThan(cloud.indexOf('<ul>'));
    // The emphasis goes to the bundle, the offer meant to go on sale first.
    expect(html).toContain('<div class="tier paid" data-tier="bundle">');
    expect(html).toContain('<div class="tier" data-tier="cloud">');
  });

  // The page is static: it cannot know whether checkout is open, and it is closed
  // until the owner's legal facts exist. So the card says so, and its terms read
  // as planned, like Cloud's.
  it('labels the bundle not on sale and its terms as planned', () => {
    const bundle = cards().get('bundle')!;
    // All three conditions bundleSale() checks (packages/site/src/bundle-sale.ts): Terms, payment, sign-in.
    expect(bundle).toContain(
      '<strong>Not on sale yet</strong>: bundles open once the Terms are final and both payment and account sign-in are set up.',
    );
    expect(bundle).toContain('Nothing can be bought or charged today.');
    expect(bundle.indexOf('Planned, not available yet')).toBeGreaterThan(-1);
    expect(bundle.indexOf('Planned, not available yet')).toBeLessThan(bundle.indexOf('<ul>'));
  });

  it('does not say anything is charged for today', () => {
    expect(html).not.toContain('That is the only thing we charge for.');
    expect(html).toContain('nothing is on sale yet');
  });

  it('does not offer a contact route that does not exist', () => {
    expect(cards().get('enterprise')!).toContain('no contact address is published yet');
  });

  it('says how a bundle arrives, and that the signing key never leaves the buyer', () => {
    const bundle = cards().get('bundle')!;
    expect(bundle).toContain('Delivered by email within 2 business days of receiving your chain file');
    expect(bundle).toContain('your signing key never leaves you');
    expect(bundle).toContain('JSON, with a human-readable PDF and HTML report');
  });

  it('shows no price on the Enterprise card', () => {
    expect(cards().get('enterprise')!).not.toMatch(/\$\s*\d/);
  });

  it('has no Team plan anywhere on the site', () => {
    expect(html).not.toMatch(/\bTeam\b/);
  });

  it('does not claim checkout is live', () => {
    expect(html).not.toMatch(/stripe|checkout/i);
  });
});

/**
 * The tamper demo's DATA is a real chain anchored at DigiCert. Recompute it the
 * way the page does (RFC 8785, SHA-256) so a bad regeneration fails here rather
 * than on the live demo.
 */
describe('tamper demo DATA', () => {
  const html = read('index.html');
  const line = /^const DATA = (.*);$/m.exec(html)?.[1];
  const DATA = JSON.parse(line ?? 'null') as {
    anchor: { seq: number; head: string; time: string; authority: string };
    receipts: { seq: number; canonical: string; self_hash: string }[];
  };
  const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

  it('is three receipts whose hashes link up to the anchored head', () => {
    expect(DATA.receipts.map((r) => r.seq)).toEqual([0, 1, 2]);
    let prev: string | null = null;
    for (const r of DATA.receipts) {
      expect(sha256(r.canonical)).toBe(r.self_hash);
      expect(JSON.parse(r.canonical).prev_hash).toBe(prev);
      prev = r.self_hash;
    }
    expect(DATA.anchor.seq).toBe(2);
    expect(prev).toBe(DATA.anchor.head);
    expect(DATA.anchor.authority).toContain('DigiCert');
  });

  it('carries the lacre extension the demo script reads', () => {
    const actions = DATA.receipts.map((r) => JSON.parse(r.canonical).lacre.action);
    expect(actions).toEqual(['refund.issue', 'email.send', 'refund.issue']);
    expect(JSON.parse(DATA.receipts[0]!.canonical).action_detail.amount_usd).toBe(42.5);
    expect(html).toContain('recs[i].lacre.action');
  });
});
