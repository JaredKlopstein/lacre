'use client';

import { useEffect } from 'react';

/** The fragment the waitlist buttons and WAITLIST_HREF point at: the waitlist section under the cards. */
export const WAITLIST_ID = 'waitlist';

/** Whether a location hash, or a link's href, targets the waitlist. */
export function targetsWaitlist(hashOrHref: string | null | undefined): boolean {
  return typeof hashOrHref === 'string' && hashOrHref.endsWith(`#${WAITLIST_ID}`);
}

/** Bring the waitlist section into view and put focus in its first field. */
function openWaitlist(): void {
  const section = document.getElementById(WAITLIST_ID);
  if (!section) return;
  section.scrollIntoView({ block: 'start' });
  section.querySelector<HTMLElement>('input, select, textarea')?.focus({ preventScroll: true });
}

/**
 * Puts focus in the waitlist's first field when the page loads at
 * /pricing#waitlist, when the hash changes to it, and when a link to it is
 * followed, so a keyboard user lands in the form rather than above it. Next's
 * <Link> changes the hash with pushState, which fires no hashchange, so link
 * clicks are watched too. Renders nothing.
 */
export function WaitlistOpen() {
  useEffect(() => {
    const onHash = () => {
      if (targetsWaitlist(location.hash)) openWaitlist();
    };
    const onClick = (event: MouseEvent) => {
      const link = (event.target as Element | null)?.closest?.('a[href]');
      if (link && targetsWaitlist(link.getAttribute('href'))) requestAnimationFrame(openWaitlist);
    };
    onHash();
    window.addEventListener('hashchange', onHash);
    document.addEventListener('click', onClick);
    return () => {
      window.removeEventListener('hashchange', onHash);
      document.removeEventListener('click', onClick);
    };
  }, []);
  return null;
}
