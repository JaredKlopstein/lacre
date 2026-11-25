import { BRAND } from '../src/brand.js';

/**
 * Detaches BRAND.domain for a test, and restores whatever was there.
 *
 * A suite that exercises the SITE_BASE_URL or VERCEL_URL branches of linkBase()
 * has to control the branch above them: with a domain attached, linkBase()
 * returns it and never reads the environment at all. The same goes for
 * fromThisSite(), which compares the request's Origin against linkBase().
 *
 * Restoring the captured value rather than a hard-coded null is the point. BRAND
 * is a module singleton shared by every test in a worker, so a restore that
 * writes null instead of what was there rewrites the shipped brand for
 * everything that runs afterwards.
 */
export function withoutBrandDomain(): () => void {
  const brand = BRAND as { domain: string | null };
  const before = brand.domain;
  brand.domain = null;
  return () => {
    brand.domain = before;
  };
}

/**
 * Attaches a specific BRAND.domain for a test, and restores whatever was there.
 *
 * Used to show what happens when the attached domain is one linkBase() cannot
 * turn into an origin: a value is present, so any check that only asks "is a
 * domain set?" is satisfied, while every generated link would be unbuildable.
 */
export function withBrandDomain(domain: string | null): () => void {
  const brand = BRAND as { domain: string | null };
  const before = brand.domain;
  brand.domain = domain;
  return () => {
    brand.domain = before;
  };
}
