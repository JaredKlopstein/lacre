import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The READMEs ship on GitHub and in the @lacre/core package, so they must not
 * claim a sale that does not exist. Nothing can be bought today: checkout refuses
 * every purchase until the owner's legal facts, payment and sign-in are all set
 * (packages/site/src/bundle-sale.ts), the same as docs/getting-started.md
 * section 5 says.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const READMES = ['README.md', 'packages/core/README.md'];

/** Prose with line breaks folded, so a phrase wrapped across two lines is still caught. */
const prose = (file: string) => readFileSync(join(ROOT, file), 'utf8').replace(/\s+/g, ' ');

describe('README sale claims', () => {
  it.each(READMES)('%s never says something is on sale today or can be bought now', (file) => {
    const text = prose(file);
    expect(text).not.toMatch(/on sale today/i);
    expect(text).not.toMatch(/can buy now/i);
    expect(text).not.toMatch(/paid path today/i);
  });

  it.each(READMES)('%s says the bundle is not on sale yet, as the guide does', (file) => {
    expect(prose(file)).toContain('not on sale yet: nothing can be bought or charged today');
  });

  it('the guide says the same', () => {
    expect(prose('docs/getting-started.md')).toContain('nothing can be bought today');
  });
});
