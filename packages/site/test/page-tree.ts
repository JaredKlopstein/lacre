import { isValidElement, type ReactNode } from 'react';
import type { DocumentLike, StorageLike } from '../src/form-outcome.js';

/**
 * Test helpers for the server-rendered forms. A page returns a React element
 * tree; the client components in it render nothing on the server, so their props
 * are read from the tree instead of the markup.
 */

/** The props of every element of `type` in the tree, in order. */
export function propsOf<P>(tree: ReactNode, type: unknown): P[] {
  const found: P[] = [];
  const walk = (node: ReactNode) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!isValidElement(node)) return;
    const props = node.props as { children?: ReactNode };
    if (node.type === type) found.push(node.props as P);
    walk(props.children);
  };
  walk(tree);
  return found;
}

/** A browser-ish stand-in: fields by id, one form's submit listeners and sessionStorage. */
export function browser(storage: Map<string, string>, formId: string, fieldIds: readonly string[]) {
  const listeners = new Set<() => void>();
  const fields = Object.fromEntries(fieldIds.map((id) => [id, { value: '', focused: false, focus() { this.focused = true; } }]));
  const form = {
    addEventListener: (_: string, fn: () => void) => void listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => void listeners.delete(fn),
  };
  const extra = new Map<string, unknown>();
  const doc: DocumentLike = {
    getElementById: (id: string) => (id === formId ? form : (fields[id] ?? extra.get(id) ?? null)),
  };
  const sessionStorage: StorageLike = {
    getItem: (k) => storage.get(k) ?? null,
    setItem: (k, v) => void storage.set(k, v),
    removeItem: (k) => void storage.delete(k),
  };
  return {
    doc,
    fields,
    storage: () => sessionStorage,
    /** Adds an element the page renders, such as the outcome message. */
    add: (id: string, el: unknown) => void extra.set(id, el),
    submit: () => listeners.forEach((fn) => fn()),
    listeners,
  };
}
