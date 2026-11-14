import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';

/**
 * The GitHub Pages landing page (docs/index.html) and the policy beside it
 * (docs/_headers) must not make a visitor's browser talk to anyone but the host
 * serving the page.
 *
 * Why this is a test and not a style preference. The published Privacy Policy
 * says, under "What we do not collect", that there is "no tracking across
 * sites", and its processor list names Vercel, Neon, Stripe, the sign-in email
 * provider and the mailbox provider -- nobody else. While this page loaded its
 * fonts from fonts.googleapis.com and fonts.gstatic.com, every visitor's IP
 * address and user agent went to a company the policy does not mention, from a
 * page that links no policy at all. The app at lacre.dev never did this; it
 * self-hosts the same families through next/font (src/fonts.ts).
 *
 * Everything below is derived from the files, not typed out: the hosts come from
 * the page's own markup, the font files from its own @font-face rules, and the
 * families from the custom properties the page sets. A new third-party
 * subresource, or a font rule pointing at a file nobody committed, fails here.
 */

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const LANDING = '../../../docs/index.html';
const HEADERS = '../../../docs/_headers';
const page = read(LANDING);

/**
 * Every absolute URL the page makes the browser fetch without the visitor
 * choosing to: a stylesheet or preconnect in <link>, a script or image src, and
 * any url() inside the page's CSS. An <a href> is not one of these -- following
 * a link is the visitor's own act -- so those are left out on purpose.
 */
function subresourceHosts(html: string): string[] {
  const urls = [
    ...[...html.matchAll(/<link\b[^>]*\bhref\s*=\s*"([^"]+)"/gi)].map((m) => m[1]!),
    ...[...html.matchAll(/<(?:script|img|iframe|source|video|audio)\b[^>]*\bsrc\s*=\s*"([^"]+)"/gi)].map((m) => m[1]!),
    ...[...html.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/gi)].map((m) => m[1]!),
  ];
  return [...new Set(urls.filter((u) => /^(https?:)?\/\//i.test(u)).map((u) => new URL(u, 'https://x.invalid').host))];
}

/** A CSP string as a map of directive to its sources. */
function directives(csp: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const part of csp.split(';')) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name) out.set(name.toLowerCase(), sources);
  }
  return out;
}

/** Sources that name a host. 'self', 'none', keyword quotes and data: do not. */
const hostSources = (sources: readonly string[]) =>
  sources.filter((s) => !s.startsWith("'") && !/^(data|blob|mediastream|filesystem):$/i.test(s));

const metaCsp = /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"/i.exec(page)?.[1];
const headerCsp = /^\s*Content-Security-Policy:\s*(.+)$/m.exec(read(HEADERS))?.[1];

describe('the Pages landing page talks to nobody but its own host', () => {
  it('loads every subresource from the page itself: no third-party host at all', () => {
    expect(subresourceHosts(page)).toEqual([]);
  });

  it('declares a policy, in both copies, that permits no external host for anything', () => {
    expect(metaCsp).toBeDefined();
    expect(headerCsp).toBeDefined();
    for (const [where, csp] of [['index.html', metaCsp!], ['_headers', headerCsp!]] as const) {
      for (const [name, sources] of directives(csp)) {
        expect(hostSources(sources), `${where}: ${name}`).toEqual([]);
      }
    }
  });

  it('keeps the two copies of the policy identical, so the intent is stated once', () => {
    expect(headerCsp!.trim()).toBe(metaCsp!.trim());
  });
});

describe('the fonts it names are committed beside it', () => {
  const faces = [...page.matchAll(/@font-face\s*\{([^}]*)\}/g)].map((m) => m[1]!);
  const field = (block: string, key: string) => new RegExp(`${key}\\s*:\\s*([^;\\n]+)`).exec(block)?.[1]?.trim();

  it('declares at least one @font-face', () => {
    expect(faces.length).toBeGreaterThan(0);
  });

  it.each(faces.map((block, i) => [i, block] as const))('face %i points at a real woff2 file', (_i, block) => {
    const src = field(block, 'src');
    expect(src).toBeDefined();
    const href = /url\(\s*['"]?([^'")]+)['"]?\s*\)/.exec(src!)?.[1];
    expect(href, src).toBeDefined();
    expect(href!.startsWith('/'), `${href} must be relative: Pages serves this page under /lacre/`).toBe(false);
    const file = new URL(`../../../docs/${href!}`, import.meta.url);
    expect(existsSync(file), `${href} is declared but not committed`).toBe(true);
    // wOF2: a stylesheet naming a file that is not a web font would fail silently in a browser.
    expect(readFileSync(file).subarray(0, 4).toString('latin1')).toBe('wOF2');
  });

  it('covers every font family the page sets itself, and ships the licence for them', () => {
    // --serif/--sans/--mono each begin with the quoted family the page wants.
    const wanted = [...page.matchAll(/--(?:serif|sans|mono)\s*:\s*'([^']+)'/g)].map((m) => m[1]!);
    expect(wanted.length).toBe(3);
    const declared = new Set(faces.map((b) => field(b, 'font-family')?.replace(/^'|'$/g, '')));
    for (const family of wanted) expect([...declared], family).toContain(family);
    expect(existsSync(new URL('../../../docs/fonts/OFL.txt', import.meta.url))).toBe(true);
  });
});
