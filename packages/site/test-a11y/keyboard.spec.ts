import { expect, test, type Page } from '@playwright/test';

// Keyboard and screen-reader behaviour axe cannot see (persona run "Sam":
// keyboard only, VoiceOver, 375px phone). Runs against the same built site as
// axe.spec.ts (see playwright.config.ts).

const phone = { width: 375, height: 812 };

/** The focused element, described by tag, id and accessible text, for readable failures. */
const focused = (page: Page) =>
  page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return 'body';
    return `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''} ${(el.textContent ?? '').trim().slice(0, 60)}`.trim();
  });

test.describe('Exhibit A', () => {
  test('hands focus to the next step after each button, and announces the verdict', async ({ page }) => {
    await page.goto('/');
    const exhibit = page.locator('section[aria-labelledby="exhibit-title"]');
    const alter = exhibit.getByRole('button', { name: /^Alter the refund/ });
    const resign = exhibit.getByRole('button', { name: /^Re-sign the chain/ });
    const reset = exhibit.getByRole('button', { name: 'Reset' });
    const verdict = exhibit.locator('[aria-live="polite"]');

    await expect(verdict).toHaveAttribute('aria-atomic', 'true');
    await expect(verdict).toContainText('Intact');

    await alter.focus();
    await page.keyboard.press('Enter');
    await expect(resign).toBeFocused();
    await expect(verdict).toContainText('Tampered: broken at seq 1');

    await page.keyboard.press('Enter');
    await expect(reset).toBeFocused();
    await expect(verdict).toContainText('Forged, and caught');

    await page.keyboard.press('Enter');
    await expect(alter).toBeFocused();
    await expect(verdict).toContainText('Intact');
    expect(await focused(page)).not.toBe('body');
  });

  test('keeps the same row elements across steps, so a screen reader keeps its place', async ({ page }) => {
    await page.goto('/');
    const exhibit = page.locator('section[aria-labelledby="exhibit-title"]');
    await exhibit.locator('ol > li').first().evaluate((li) => li.setAttribute('data-marker', 'kept'));
    await exhibit.getByRole('button', { name: /^Alter the refund/ }).click();
    await expect(exhibit.locator('[aria-live="polite"]')).toContainText('Tampered');
    await expect(exhibit.locator('ol > li').first()).toHaveAttribute('data-marker', 'kept');
    await expect(exhibit.locator('ol > li')).toHaveCount(4);
  });
});

test.describe('mobile menu at 375px', () => {
  test.use({ viewport: phone });

  test('closes when Tab moves focus past the last link, so focus is never hidden under the panel', async ({ page }) => {
    await page.goto('/');
    const toggle = page.getByRole('button', { name: 'Menu' });
    const links = page.locator('#site-nav-list a');

    await toggle.focus();
    await page.keyboard.press('Enter');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');

    const count = await links.count();
    for (let i = 0; i < count; i += 1) {
      await page.keyboard.press('Tab');
      await expect(links.nth(i)).toBeFocused();
      await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    }

    await page.keyboard.press('Tab');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(links.first()).toBeHidden();
    // Focus moved on into the page, and nothing covers it.
    const box = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement;
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return { inMain: !!el.closest('main'), covered: !(hit && (el === hit || el.contains(hit))) };
    });
    expect(box, `focus after the menu: ${await focused(page)}`).toEqual({ inMain: true, covered: false });
  });

  test('closes when Shift+Tab leaves it before the Menu button', async ({ page }) => {
    await page.goto('/');
    const toggle = page.getByRole('button', { name: 'Menu' });
    await toggle.focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Shift+Tab');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('.site-brand')).toBeFocused();
  });

  test('still closes on Escape, returning focus to the Menu button', async ({ page }) => {
    await page.goto('/');
    const toggle = page.getByRole('button', { name: 'Menu' });
    await toggle.focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Escape');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(toggle).toBeFocused();
  });

  test('closes on a press outside it, and a tap on a menu link still navigates', async ({ page }) => {
    await page.goto('/');
    const toggle = page.getByRole('button', { name: 'Menu' });
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await page.locator('footer').dispatchEvent('pointerdown');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');

    await toggle.click();
    await page.locator('#site-nav-list').getByRole('link', { name: 'Pricing' }).click();
    await expect(page).toHaveURL(/\/pricing$/);
  });
});

test.describe('skip link', () => {
  test('moves focus to <main>, not only the scroll position', async ({ page }) => {
    await page.goto('/pricing');
    await page.keyboard.press('Tab');
    const skip = page.getByRole('link', { name: 'Skip to content' });
    await expect(skip).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('main#main')).toBeFocused();
    // Focus on <main> draws no ring: it is a landmark, not a control.
    expect(await page.locator('main#main').evaluate((el) => getComputedStyle(el).outlineStyle)).toBe('none');
  });
});

test.describe('aria-current', () => {
  const navLinks = (page: Page) => page.locator('nav[aria-label="Main"] a');

  for (const [path, label] of [
    ['/pricing', 'Pricing'],
    ['/verify', 'Verify'],
    ['/how-it-works', 'How it works'],
    ['/signup', 'Sign in'],
  ] as const) {
    test(`marks only "${label}" as the current page on ${path}`, async ({ page }) => {
      await page.goto(path);
      const current = navLinks(page).and(page.locator('[aria-current="page"]'));
      await expect(current).toHaveCount(1);
      await expect(current).toHaveText(label);
    });
  }

  test('marks no nav link on the home page', async ({ page }) => {
    await page.goto('/');
    await expect(navLinks(page).and(page.locator('[aria-current]'))).toHaveCount(0);
  });

  test('names Start free with where it goes', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('nav[aria-label="Main"]').getByRole('link', { name: 'Start free (guide on GitHub)' })).toHaveCount(1);
  });
});
