'use client';

import { useEffect } from 'react';

/**
 * Helpers for the server-rendered forms (sign-up, sign-in, Enterprise contact)
 * that post natively and come back through a redirect with ?<form>=<outcome>.
 *
 * A live region that already holds its text when a page loads is never read out,
 * so AnnounceOutcome moves focus to the outcome message. The pages put the outcome
 * in the document title themselves, from generateMetadata: the title is the first
 * thing a screen reader says after a page load, and Next owns <title>, so a title
 * set from an effect here would be overwritten when Next commits its metadata.
 *
 * KeepFields holds what was typed in this tab's sessionStorage across the
 * post-and-redirect, for one page load, and puts it back only when the page says
 * so (a refused or failed send). It runs as a React effect, so it also works when
 * the page was reached by client-side navigation, where an inline <script> would
 * never run. Nothing from the request is written into storage or the page.
 *
 * The effects are plain functions over the slice of `document` and `sessionStorage`
 * they use, so tests drive them with stand-ins.
 */

interface Field {
  value: string;
}
interface Focusable {
  focus(): void;
}
interface FormLike {
  addEventListener(type: 'submit', listener: () => void): void;
  removeEventListener(type: 'submit', listener: () => void): void;
}
export interface DocumentLike {
  getElementById(id: string): unknown;
}
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Focus the message (it carries tabIndex -1). */
export function announceOutcome(doc: DocumentLike, targetId: string): void {
  (doc.getElementById(targetId) as Focusable | null)?.focus();
}

/** The stored values, parsed: only string values for the listed ids survive. */
export function parseKept(raw: string | null, fieldIds: readonly string[]): Record<string, string> {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
  const kept: Record<string, string> = {};
  for (const id of fieldIds) {
    const value = (parsed as Record<string, unknown>)[id];
    if (typeof value === 'string') kept[id] = value;
  }
  return kept;
}

export interface KeepOptions {
  readonly formId: string;
  readonly fieldIds: readonly string[];
  readonly storageKey: string;
  /** Put the kept values back into empty fields. Otherwise they are only cleared. */
  readonly restore: boolean;
}

/**
 * Reads and clears what the last submit kept, restores it when asked, and keeps
 * the fields again on the next submit. Returns the cleanup that drops the listener.
 */
export function keepFields(doc: DocumentLike, storage: () => StorageLike, opts: KeepOptions): () => void {
  const field = (id: string) => doc.getElementById(id) as Field | null;
  let kept: Record<string, string> = {};
  try {
    const store = storage();
    kept = parseKept(store.getItem(opts.storageKey), opts.fieldIds);
    store.removeItem(opts.storageKey);
  } catch {
    // Storage is blocked; nothing to restore and nothing will be kept.
  }
  if (opts.restore) {
    for (const [id, value] of Object.entries(kept)) {
      const el = field(id);
      if (el && !el.value && value) el.value = value;
    }
  }
  const form = doc.getElementById(opts.formId) as FormLike | null;
  const onSubmit = () => {
    const values: Record<string, string> = {};
    for (const id of opts.fieldIds) {
      const el = field(id);
      if (el && typeof el.value === 'string') values[id] = el.value;
    }
    try {
      storage().setItem(opts.storageKey, JSON.stringify(values));
    } catch {
      // Storage is blocked; the form still posts.
    }
  };
  form?.addEventListener('submit', onSubmit);
  return () => form?.removeEventListener('submit', onSubmit);
}

/** Focus the message with `targetId` once the page is interactive. */
export function AnnounceOutcome({ targetId }: { targetId: string }) {
  useEffect(() => announceOutcome(document, targetId), [targetId]);
  return null;
}

export function KeepFields({ formId, fieldIds, storageKey, restore }: KeepOptions) {
  // A stable dependency: the ids are fixed per page, but the array is new each render.
  const ids = fieldIds.join(' ');
  useEffect(
    () => keepFields(document, () => sessionStorage, { formId, fieldIds: ids.split(' '), storageKey, restore }),
    [formId, ids, storageKey, restore],
  );
  return null;
}
