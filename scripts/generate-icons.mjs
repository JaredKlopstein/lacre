#!/usr/bin/env node
/**
 * Regenerates every raster icon from packages/site/app/icon.svg (#257).
 *
 * The SVG is the only source. Run this from the site package, which is where the
 * browser that does the rasterising is a declared dependency:
 *
 *   pnpm --filter @lacre/site exec node ../../scripts/generate-icons.mjs
 *
 * It writes, and test/icons.test.ts checks, each of:
 *
 *   packages/site/app/favicon.ico      16, 32, 48, alpha kept
 *   packages/site/app/apple-icon.png   180x180, opaque, square corners
 *   docs/favicon.ico                   byte-identical to the site's
 *   docs/apple-touch-icon.png          byte-identical to the site's
 *
 * Authoring-time only: nothing in the build or in CI runs this. It rasterises in
 * Chromium through @playwright/test, the site's own devDependency, rather than
 * an image library this repo does not declare.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(REPO, 'packages/site/app/icon.svg');

/** favicon.ico carries these, largest last. */
const ICO_SIZES = [16, 32, 48];
/** Apple wants one opaque 180x180; iOS applies its own corner mask. */
const APPLE_SIZE = 180;

let chromium;
try {
  /*
   * Resolved from the site package, not from this file. A bare import in an ES
   * module resolves against the importing file's own directory, and this script
   * lives at the repo root where pnpm links no browser; the site package is
   * where @playwright/test is declared.
   */
  const fromSite = createRequire(join(REPO, 'packages/site/package.json'));
  const mod = await import(pathToFileURL(fromSite.resolve('@playwright/test')).href);
  // @playwright/test is CommonJS, so the named export is not always lifted onto
  // the namespace when it is imported through a file URL.
  chromium = mod.chromium ?? mod.default?.chromium;
  if (!chromium) throw new Error('no chromium export');
} catch {
  console.error(
    'This script rasterises in Chromium through @playwright/test, which resolves from\n' +
      'the site package. Run it as:\n\n' +
      '  pnpm --filter @lacre/site exec node ../../scripts/generate-icons.mjs\n',
  );
  process.exit(1);
}

const svg = await readFile(SOURCE, 'utf8');

/**
 * The apple icon is rendered from the mark with its corner radius removed.
 * iOS masks the icon to its own rounded square, so a mark that brings its own
 * rounded corners and is then put on white shows white wedges inside Apple's
 * mask. Same mark, same colours, square corners.
 */
const squared = svg.replace(/\srx="7"/, '');

const browser = await chromium.launch();
try {
  const render = async (markup, size, opaque) => {
    const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    await page.setContent(
      `<!doctype html><meta charset="utf-8">` +
        `<style>html,body{margin:0;padding:0;${opaque ? 'background:#fff;' : ''}}` +
        `svg{display:block;width:${size}px;height:${size}px}</style>${markup}`,
    );
    const data = await page.screenshot({ type: 'png', omitBackground: !opaque });
    await page.close();
    return data;
  };

  /**
   * An ICO holding PNG images, which every browser in use reads. Layout: a
   * 6-byte header, then one 16-byte directory entry per image, then the images.
   * A side of 256 is written as 0; nothing here is that large, but the rule is
   * part of the format.
   */
  const ico = (images) => {
    const header = Buffer.alloc(6);
    header.writeUInt16LE(0, 0); // reserved
    header.writeUInt16LE(1, 2); // 1 = icon
    header.writeUInt16LE(images.length, 4);

    let offset = 6 + images.length * 16;
    const entries = images.map(({ size, data }) => {
      const entry = Buffer.alloc(16);
      entry.writeUInt8(size >= 256 ? 0 : size, 0); // width
      entry.writeUInt8(size >= 256 ? 0 : size, 1); // height
      entry.writeUInt8(0, 2); // palette size: 0 for true colour
      entry.writeUInt8(0, 3); // reserved
      entry.writeUInt16LE(1, 4); // colour planes
      entry.writeUInt16LE(32, 6); // bits per pixel
      entry.writeUInt32LE(data.length, 8);
      entry.writeUInt32LE(offset, 12);
      offset += data.length;
      return entry;
    });

    return Buffer.concat([header, ...entries, ...images.map((image) => image.data)]);
  };

  const sized = [];
  for (const size of ICO_SIZES) sized.push({ size, data: await render(svg, size, false) });
  const faviconIco = ico(sized);
  const appleIcon = await render(squared, APPLE_SIZE, true);

  for (const [path, data] of [
    ['packages/site/app/favicon.ico', faviconIco],
    ['packages/site/app/apple-icon.png', appleIcon],
    ['docs/favicon.ico', faviconIco],
    ['docs/apple-touch-icon.png', appleIcon],
  ]) {
    const full = join(REPO, path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, data);
    console.log(`${path}  ${data.length} bytes`);
  }
} finally {
  await browser.close();
}
