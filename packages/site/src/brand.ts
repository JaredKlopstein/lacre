/**
 * The site's brand, in one place.
 *
 * Page copy and metadata read the name, tagline and repository from here and
 * never hard-code them.
 *
 * `domain` is the owner-supplied domain the site is served from. It is the first
 * source linkBase() reads, so every link the site generates — the sign-in email,
 * and Stripe's success, cancel and return URLs — is built on it, and
 * /.well-known/security.txt publishes its Canonical and Policy lines on it. The
 * SITE_BASE_URL and VERCEL_URL fallbacks behind it are only reached while it is
 * null, which is how a preview deployment with no domain still builds links.
 */
export interface Brand {
  readonly name: string;
  readonly domain: string | null;
  readonly tagline: string;
  /** Source repository. Its path carries the name, so it lives here too. */
  readonly repository: string;
}

export const BRAND: Brand = {
  name: 'Lacre',
  domain: 'lacre.dev',
  tagline: 'tamper-evident receipts for AI agents',
  repository: 'https://github.com/JaredKlopstein/lacre',
};
