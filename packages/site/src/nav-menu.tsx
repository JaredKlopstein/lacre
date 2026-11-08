'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

export const NAV_LIST_ID = 'site-nav-list';

export type NavItem = {
  readonly href: string;
  readonly label: string;
  /** `action` items sit at the right of the bar; `cta` is the one styled as a button. */
  readonly kind?: 'action' | 'cta';
  /** Visually hidden text read after the label, such as where an off-site link goes. */
  readonly hint?: string;
};

/** What a key press does to the menu: close it and return focus to the Menu button, or nothing. */
export function navKeyAction(key: string, open: boolean): { open: false; focusToggle: true } | null {
  return key === 'Escape' && open ? { open: false, focusToggle: true } : null;
}

/**
 * Whether focus leaving a nav element closes the open menu. It does when focus
 * moved to an element outside the nav (Tab past the last link, Shift+Tab before
 * the Menu button). It does not when focus moved nowhere (`next` is null): Safari
 * does not focus links on click, so a tap on a menu link blurs the Menu button
 * with no new target, and closing then would hide the link before the click lands.
 * Pointer presses outside the nav close it separately.
 */
export function navFocusOutCloses(open: boolean, next: 'inside' | 'outside' | null): boolean {
  return open && next === 'outside';
}

/** aria-current for a nav link: "page" on the link to the page being shown. */
export function navCurrent(pathname: string | null, href: string): 'page' | undefined {
  return pathname !== null && href.startsWith('/') && pathname === href ? 'page' : undefined;
}

/**
 * The header nav. Horizontal on wide screens. Under 640px app/globals.css hides
 * the list and shows the Menu button from first paint, so server and hydrated
 * HTML lay out the same and nothing shifts; `@media (scripting: none)` shows the
 * list instead, so every link stays reachable without JavaScript. data-open opens
 * the list as a panel below the header row.
 *
 * The open menu is a disclosure, not a modal dialog, so it does not trap focus:
 * moving focus out of the nav, or pressing outside it, closes it, and Escape
 * closes it and returns focus to the Menu button.
 */
export function NavMenu({ items }: { items: readonly NavItem[] }) {
  const [open, setOpen] = useState(false);
  const nav = useRef<HTMLElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const pathname = usePathname();

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      const action = navKeyAction(event.key, open);
      if (!action) return;
      setOpen(action.open);
      if (action.focusToggle) toggle.current?.focus();
    };
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !nav.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open]);

  return (
    <nav
      ref={nav}
      aria-label="Main"
      className="site-nav"
      data-open={open ? '' : undefined}
      onBlur={(event) => {
        const next = event.relatedTarget;
        const where = next === null ? null : event.currentTarget.contains(next) ? 'inside' : 'outside';
        if (navFocusOutCloses(open, where)) setOpen(false);
      }}
    >
      <button
        ref={toggle}
        type="button"
        className="nav-toggle"
        aria-expanded={open}
        aria-controls={NAV_LIST_ID}
        onClick={() => setOpen((o) => !o)}
      >
        Menu
      </button>
      <ul id={NAV_LIST_ID}>
        {items.map((item) => (
          <li key={item.href} className={item.kind ? `nav-${item.kind}` : undefined}>
            <Link href={item.href} aria-current={navCurrent(pathname, item.href)} onClick={() => setOpen(false)}>
              {item.label}
              {item.hint ? <span className="nav-hint"> {item.hint}</span> : null}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
