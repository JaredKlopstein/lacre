import type { MetadataRoute } from 'next';
import { DISALLOWED_PATHS, PUBLIC_PAGES, SITE_ORIGIN, siteUrl } from '../src/public-pages';

/**
 * /robots.txt, which returned a 404 HTML page until now (#256).
 *
 * Allow is explicit rather than left to the default. A bare `disallow` list is
 * read correctly by every crawler, but it leaves no record in the file of which
 * pages were meant to be indexed, and this file and app/sitemap.ts are the only
 * two places that answer that question.
 *
 * The sitemap line is omitted while no domain is set, because a Sitemap
 * directive must be an absolute URL and a relative one is simply ignored.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: PUBLIC_PAGES.map((page) => page.path),
        disallow: [...DISALLOWED_PATHS],
      },
    ],
    ...(SITE_ORIGIN ? { sitemap: siteUrl('/sitemap.xml'), host: SITE_ORIGIN } : {}),
  };
}
