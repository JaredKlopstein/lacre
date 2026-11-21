import type { MetadataRoute } from 'next';
import { PUBLIC_PAGES, SITE_ORIGIN, siteUrl } from '../src/public-pages';

/**
 * /sitemap.xml, which returned a 404 HTML page until now (#256).
 *
 * Built from PUBLIC_PAGES, so the sitemap and the canonicals cannot disagree
 * about which pages exist. No lastModified: the honest value is the date each
 * page's content last changed, which nothing in the build knows, and a
 * build-time `new Date()` would tell every crawler that all eight pages change
 * on every deploy.
 *
 * Empty while no domain is set, rather than emitting relative URLs that a
 * crawler must reject: a sitemap entry has to be an absolute URL.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  if (!SITE_ORIGIN) return [];
  return PUBLIC_PAGES.map((page) => ({
    url: siteUrl(page.path),
    changeFrequency: page.changeFrequency,
    priority: page.priority,
  }));
}
