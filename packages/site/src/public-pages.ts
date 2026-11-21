import { BRAND } from './brand';

/**
 * The site's own origin, for the absolute URLs metadata needs.
 *
 * It reads BRAND.domain and nothing else. linkBase() in src/auth/email.ts
 * answers the same question with SITE_BASE_URL and VERCEL_URL fallbacks behind
 * it, and is the right function for a link that has to work on a preview
 * deployment. This one is deliberately not that: it feeds metadataBase, the
 * canonicals and the sitemap, and a canonical pointing at a preview host is
 * worse than no canonical at all. The layout also must not import auth code, or
 * every page stops being statically rendered.
 */
export const SITE_ORIGIN: string | null = BRAND.domain ? `https://${BRAND.domain}` : null;

/**
 * Every page a search engine should index, and nothing else.
 *
 * This is the one list. app/sitemap.ts publishes it, app/robots.ts allows it,
 * and test/seo.test.ts checks each entry has exactly one canonical pointing at
 * itself, so a new public page that is added here but given no canonical fails
 * rather than shipping unindexed.
 *
 * `changeFrequency` and `priority` are hints, not promises: the legal pages move
 * when the facts do, the marketing pages when the product does.
 */
export const PUBLIC_PAGES = [
  { path: '/', changeFrequency: 'weekly', priority: 1.0 },
  { path: '/how-it-works', changeFrequency: 'monthly', priority: 0.8 },
  { path: '/pricing', changeFrequency: 'weekly', priority: 0.8 },
  { path: '/security', changeFrequency: 'monthly', priority: 0.7 },
  { path: '/verify', changeFrequency: 'monthly', priority: 0.7 },
  { path: '/enterprise', changeFrequency: 'monthly', priority: 0.5 },
  { path: '/terms', changeFrequency: 'yearly', priority: 0.3 },
  { path: '/privacy', changeFrequency: 'yearly', priority: 0.3 },
] as const satisfies readonly { path: string; changeFrequency: string; priority: number }[];

export type PublicPage = (typeof PUBLIC_PAGES)[number];

/**
 * Paths a crawler is asked to leave alone.
 *
 * `/api/` is every route handler: none of it is a page, and the auth routes
 * answer to tokens. The rest is the signed-in and transactional surface. They
 * carry no content a search result could usefully point at, and `/signin` is
 * useless without the token from an email.
 *
 * `/signup` is deliberately absent: it is the "Sign in" entry in the site nav,
 * so it is a real public page. It is not in PUBLIC_PAGES either, because a
 * sign-in form is not content worth a sitemap entry.
 */
export const DISALLOWED_PATHS = ['/api/', '/account', '/checkout', '/signin', '/welcome'] as const;

/** An absolute URL on the site's own origin. Throws while no domain is set. */
export function siteUrl(path: string): string {
  if (!SITE_ORIGIN) throw new Error('BRAND.domain is not set, so there is no origin to build a URL on');
  return new URL(path, SITE_ORIGIN).toString();
}
