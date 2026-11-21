import { describe, expect, it } from 'vitest';
import type { Metadata } from 'next';
import robots from '../app/robots.js';
import sitemap from '../app/sitemap.js';
import { BRAND } from '../src/brand.js';
import { DISALLOWED_PATHS, PUBLIC_PAGES, SITE_ORIGIN, siteUrl } from '../src/public-pages.js';
import { metadata as home } from '../app/page.js';
import { metadata as pricing } from '../app/pricing/page.js';
import { metadata as howItWorks } from '../app/how-it-works/page.js';
import { metadata as security } from '../app/security/page.js';
import { metadata as verify } from '../app/verify/page.js';
import { metadata as terms } from '../app/terms/page.js';
import { metadata as privacy } from '../app/privacy/page.js';
import { generateMetadata as enterpriseMetadata } from '../app/enterprise/page.js';
import { metadata as layout } from '../app/layout.js';

/**
 * robots.txt, sitemap.xml and the canonicals (#256). Before this, both files
 * returned a 404 HTML page and no page carried a canonical at all.
 *
 * The point of the test is that PUBLIC_PAGES stays the single list: a page added
 * there but given no canonical fails here rather than shipping, and a page given
 * a canonical that points somewhere else fails too. That is the failure mode
 * worth guarding, because a wrong canonical is worse than a missing one -- it
 * hands the ranking to another URL.
 */

/** Each public page's own metadata, by the path it is served at. */
const PAGE_METADATA: Record<string, Metadata> = {
  '/': home,
  '/pricing': pricing,
  '/how-it-works': howItWorks,
  '/security': security,
  '/verify': verify,
  '/terms': terms,
  '/privacy': privacy,
};

describe('robots.txt', () => {
  const rules = () => {
    const group = robots().rules;
    return Array.isArray(group) ? group[0]! : group;
  };

  it('allows every public page and nothing it should not', () => {
    expect(rules().userAgent).toBe('*');
    expect(rules().allow).toEqual(PUBLIC_PAGES.map((page) => page.path));
  });

  it('keeps crawlers out of the API and the signed-in surface', () => {
    expect(rules().disallow).toEqual([...DISALLOWED_PATHS]);
    for (const path of ['/api/', '/account', '/checkout', '/signin', '/welcome']) {
      expect(rules().disallow, `${path} must be disallowed`).toContain(path);
    }
  });

  it('points at an absolute sitemap on the site, not a relative one', () => {
    const sitemapUrl = robots().sitemap;
    expect(sitemapUrl).toBe(`https://${BRAND.domain}/sitemap.xml`);
    expect(() => new URL(String(sitemapUrl))).not.toThrow();
  });

  it('never allows and disallows the same path', () => {
    const allow = new Set(rules().allow as string[]);
    for (const path of rules().disallow as string[]) expect(allow.has(path)).toBe(false);
  });
});

describe('sitemap.xml', () => {
  it('lists every public page, and only those, as absolute URLs on lacre.dev', () => {
    const entries = sitemap();
    expect(entries.map((entry) => entry.url)).toEqual(PUBLIC_PAGES.map((page) => siteUrl(page.path)));
    for (const entry of entries) {
      expect(entry.url.startsWith(`https://${BRAND.domain}/`), entry.url).toBe(true);
    }
  });

  it('omits lastModified rather than claiming every page changed at build time', () => {
    for (const entry of sitemap()) expect(entry.lastModified).toBeUndefined();
  });
});

describe('canonicals', () => {
  it('resolve against the site origin, set once in the layout', () => {
    expect(SITE_ORIGIN).toBe(`https://${BRAND.domain}`);
    expect(String(layout.metadataBase)).toBe(`${SITE_ORIGIN}/`);
  });

  it('give every public page exactly one, pointing at itself', () => {
    for (const { path } of PUBLIC_PAGES) {
      if (path === '/enterprise') continue; // built by generateMetadata, below
      const canonical = PAGE_METADATA[path]?.alternates?.canonical;
      expect(canonical, `${path} has no canonical`).toBe(path);
      // Resolved the way Next resolves it, the result is this page and no other.
      expect(new URL(String(canonical), SITE_ORIGIN!).toString()).toBe(siteUrl(path));
    }
  });

  it('survive the Enterprise outcome redirects', async () => {
    const outcomes = [undefined, 'sent', 'invalid', 'not_configured'];
    for (const contact of outcomes) {
      const meta = await enterpriseMetadata({
        searchParams: Promise.resolve(contact ? { contact } : {}),
      });
      expect(meta.alternates?.canonical, `?contact=${contact}`).toBe('/enterprise');
    }
  });
});

describe('the home page description', () => {
  it('says something the title does not', () => {
    const description = String(home.description);
    const title = `${BRAND.name}: ${BRAND.tagline}`;
    expect(description).not.toBe(title);
    expect(description).not.toBe(`${title}.`);
    // Who it is for, which the title never says.
    expect(description).toContain('For teams running AI agents');
    expect(description.length).toBeGreaterThan(title.length + 40);
  });

  it('is short enough to survive a search result', () => {
    expect(String(home.description).length).toBeLessThanOrEqual(320);
  });
});
