import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The raster icons (#257). /favicon.ico, /apple-touch-icon.png and /apple-icon
 * all returned 404 on lacre.dev and on the Pages landing, because the only icon
 * declared anywhere was the SVG.
 *
 * Next serves app/favicon.ico and app/apple-icon.png by file convention and
 * emits the <link> tags itself, so what is worth checking is the files: that
 * they are the formats they claim to be, at the sizes a browser asks for, and
 * that the Pages copies have not drifted from the app's.
 *
 * scripts/generate-icons.mjs makes all four from app/icon.svg. Nothing here
 * runs it: a test that regenerates what it checks proves only that the script is
 * deterministic.
 */

const REPO = join(import.meta.dirname, '..', '..', '..');
const read = (path: string) => readFileSync(join(REPO, path));

const SITE_ICO = 'packages/site/app/favicon.ico';
const SITE_APPLE = 'packages/site/app/apple-icon.png';
const DOCS_ICO = 'docs/favicon.ico';
const DOCS_APPLE = 'docs/apple-touch-icon.png';

/** The sides declared in an ICO's directory, in file order. A 0 means 256. */
function icoSizes(buffer: Buffer): number[] {
  expect(buffer.readUInt16LE(0), 'ICO reserved field').toBe(0);
  expect(buffer.readUInt16LE(2), 'ICO type: 1 is an icon').toBe(1);
  const count = buffer.readUInt16LE(4);
  return Array.from({ length: count }, (_, i) => {
    const entry = 6 + i * 16;
    const width = buffer.readUInt8(entry) || 256;
    const height = buffer.readUInt8(entry + 1) || 256;
    expect(width, 'icons are square').toBe(height);
    // The payload must sit inside the file.
    const length = buffer.readUInt32LE(entry + 8);
    const offset = buffer.readUInt32LE(entry + 12);
    expect(offset + length).toBeLessThanOrEqual(buffer.length);
    // Each payload is a PNG, which is what every browser in use reads.
    expect([...buffer.subarray(offset, offset + 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    return width;
  });
}

/** Width, height and colour type from a PNG's IHDR. */
function png(buffer: Buffer) {
  expect([...buffer.subarray(0, 8)], 'PNG signature').toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  expect(buffer.subarray(12, 16).toString('ascii'), 'first chunk is IHDR').toBe('IHDR');
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
    /** 6 is RGBA, 2 is RGB: an apple icon must not be the former. */
    colourType: buffer.readUInt8(25),
  };
}

describe('favicon.ico', () => {
  it('carries the three sizes a browser asks for', () => {
    expect(icoSizes(read(SITE_ICO))).toEqual([16, 32, 48]);
  });

  it('keeps its transparency, so the rounded corners are not white wedges', () => {
    const buffer = read(SITE_ICO);
    const offset = buffer.readUInt32LE(6 + 12);
    expect(png(buffer.subarray(offset)).colourType, 'RGBA').toBe(6);
  });
});

describe('the apple icon', () => {
  it('is 180x180', () => {
    const { width, height } = png(read(SITE_APPLE));
    expect([width, height]).toEqual([180, 180]);
  });

  /**
   * iOS composites the icon on its own background and masks the corners. An
   * icon with alpha shows through; one carrying its own rounded corners shows
   * white wedges inside Apple's mask. So: opaque, and square.
   */
  it('is opaque', () => {
    expect(png(read(SITE_APPLE)).colourType, 'RGB, not RGBA').toBe(2);
  });
});

describe('the Pages landing', () => {
  it('serves the same two files as the app, not a second pair that can drift', () => {
    expect(read(DOCS_ICO).equals(read(SITE_ICO))).toBe(true);
    expect(read(DOCS_APPLE).equals(read(SITE_APPLE))).toBe(true);
  });

  it('declares both, from its own directory', () => {
    const html = read('docs/index.html').toString('utf8');
    expect(html).toContain('<link rel="icon" href="favicon.ico" sizes="any">');
    expect(html).toContain('<link rel="apple-touch-icon" href="apple-touch-icon.png">');
    // Relative, so nothing is fetched from another host.
    expect(html).not.toMatch(/<link rel="(icon|apple-touch-icon)" href="https?:/);
  });
});

describe('the source of every raster', () => {
  it('is the one SVG mark, with its palette', () => {
    const svg = read('packages/site/app/icon.svg').toString('utf8');
    expect(svg).toContain('#0b57d0');
    expect(svg).toContain('#ffffff');
    // The header mark's palette is a different one and must not leak in here.
    expect(svg).not.toContain('#141a22');
    expect(svg).not.toContain('#e8e8e4');
  });
});
