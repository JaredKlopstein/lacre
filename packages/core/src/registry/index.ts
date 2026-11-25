/**
 * The typed action registry, without the store.
 *
 * This is the `@lacre/core/registry` entry point named in package.json. Like
 * `./canonical`, it exists so a consumer can use the registry without loading
 * the package root, which imports the action modules for registration and so
 * pulls in better-sqlite3. Nothing re-exported here has a runtime dependency on
 * the database: `registry.js` has no runtime imports at all, `types.js` is
 * types only, and `discover.js` reaches the receipt schema and pagination but
 * never the db client.
 *
 * `buildManifest` is deliberately NOT re-exported: actions register themselves
 * when `@lacre/core` imports them, so calling it from here, before anything has
 * registered, returns an empty action set. It stays on the package root, where
 * the actions are loaded.
 */
export { defineAction, getAction, allActions, actionNames } from './registry.js';
export { EXIT_CODES } from './discover.js';
export type {
  ActionDef,
  ActionContext,
  ActionDescription,
  ActionResult,
  NextAction,
} from './types.js';
