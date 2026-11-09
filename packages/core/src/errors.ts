/**
 * Design law 4: every error teaches its own fix.
 *
 * The audience for these messages is an agent with a limited context window that
 * cannot read documentation mid-task. An error must therefore carry, in the
 * payload itself: what went wrong, whether retrying could possibly help, whether
 * the action executed, and the exact next call to make. "Invalid input" costs an
 * agent an entire exploratory loop; a `fix` block costs it one call.
 */

export const ERROR_CODES = {
  /** Input failed schema validation. Never executed. */
  INVALID_INPUT: 'INVALID_INPUT',
  /** An option was supplied that the action does not define. Never executed --
   *  ignoring it could silently change what is recorded or returned. */
  UNKNOWN_ARGUMENT: 'UNKNOWN_ARGUMENT',
  /** No agent registered under that id. Never executed. */
  AGENT_NOT_FOUND: 'AGENT_NOT_FOUND',
  /** Agent id is registered to a DIFFERENT key than the one presented. */
  AGENT_KEY_MISMATCH: 'AGENT_KEY_MISMATCH',
  /** That agent id is already registered. */
  AGENT_EXISTS: 'AGENT_EXISTS',
  /** A keypair already exists and would be replaced. Nothing was written. */
  KEY_EXISTS: 'KEY_EXISTS',
  /** No keypair in the store. Never executed. */
  NO_KEYPAIR: 'NO_KEYPAIR',
  /** Store is not initialized. Never executed. */
  NOT_INITIALIZED: 'NOT_INITIALIZED',
  /** Concurrent append took our sequence number. Nothing was written. */
  CHAIN_CONFLICT: 'CHAIN_CONFLICT',
  /** The chain failed integrity verification. */
  CHAIN_BROKEN: 'CHAIN_BROKEN',
  /** An existing anchor commits this position to a DIFFERENT head. The history
   *  changed underneath an attestation. Nothing was written. */
  ANCHOR_CONTRADICTION: 'ANCHOR_CONTRADICTION',
  /** Same idempotency key, different arguments. Nothing was written. */
  IDEMPOTENCY_MISMATCH: 'IDEMPOTENCY_MISMATCH',
  /** Requested a paid capability from the open-source build. */
  REQUIRES_CLOUD: 'REQUIRES_CLOUD',
  /** A cursor could not be decoded. */
  INVALID_CURSOR: 'INVALID_CURSOR',
  /** The store's database file is not readable SQLite: corrupt, truncated, or
   *  not a Lacre store at all. The action did not complete. */
  STORE_UNREADABLE: 'STORE_UNREADABLE',
  /** The native SQLite binding (better-sqlite3) is missing or was built for a
   *  different Node.js version. Nothing was executed. */
  NATIVE_DEPENDENCY_MISSING: 'NATIVE_DEPENDENCY_MISSING',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export interface ErrorFix {
  /** The action to call next, by registry name. */
  action?: string;
  /** Fully-formed arguments -- ready to execute, not a template. */
  arguments?: Record<string, unknown>;
  /** Plain-language guidance, including whether the action executed. */
  note: string;
}

export interface LacreErrorPayload {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  fix?: ErrorFix;
  details?: Record<string, unknown>;
}

export class LacreError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly fix?: ErrorFix;
  readonly details?: Record<string, unknown>;

  constructor(payload: LacreErrorPayload) {
    super(payload.message);
    this.name = 'LacreError';
    this.code = payload.code;
    this.retryable = payload.retryable;
    this.fix = payload.fix;
    this.details = payload.details;
  }

  /** The wire shape. Identical across CLI --json, HTTP and MCP. `ok: false`
   *  mirrors the success envelope's `ok: true`, so a caller can branch on one
   *  field whichever way the call went. */
  toJSON(): { ok: false; error: LacreErrorPayload } {
    return {
      ok: false,
      error: {
        code: this.code,
        message: this.message,
        retryable: this.retryable,
        ...(this.fix ? { fix: this.fix } : {}),
        ...(this.details ? { details: this.details } : {}),
      },
    };
  }
}

/** STORE_UNREADABLE: the store's lacre.db exists but is not a readable Lacre database. */
export function storeUnreadable(message: string, details: Record<string, unknown>): LacreError {
  return new LacreError({
    code: 'STORE_UNREADABLE',
    message,
    retryable: false,
    fix: {
      note:
        'The action did NOT complete and nothing was written. Keep this lacre.db as it is: it may be evidence. ' +
        'Restore lacre.db from a known-good backup and run lacre chain verify, or pass --store with the ' +
        'directory of the store you meant.',
    },
    details,
  });
}

/** Wrap an unknown throw so no surface ever emits an untyped error. */
export function toLacreError(err: unknown): LacreError {
  if (err instanceof LacreError) return err;
  const message = err instanceof Error ? err.message : String(err);
  const sqliteCode = (err as { code?: unknown } | null)?.code;
  if (sqliteCode === 'SQLITE_NOTADB' || sqliteCode === 'SQLITE_CORRUPT') {
    return storeUnreadable(
      `The store's database file could not be read as SQLite: ${message}. It is corrupt, truncated, or not a Lacre store.`,
      { sqlite_code: sqliteCode },
    );
  }
  if (/Could not locate the bindings file|better_sqlite3\.node|NODE_MODULE_VERSION/.test(message)) {
    return new LacreError({
      code: 'NATIVE_DEPENDENCY_MISSING',
      message:
        'The native SQLite binding (better-sqlite3) is missing or was built for a different Node.js version. ' +
        `Lacre cannot open a store without it. Cause: ${message.split('\n')[0]}`,
      retryable: false,
      fix: {
        note:
          'Nothing was executed: no key or receipt was read or written (an empty store directory may exist). ' +
          'Build the binding for this Node.js version, then retry. ' +
          'With npm: npm rebuild better-sqlite3 (and do not install with --ignore-scripts). ' +
          'With pnpm, which blocks dependency build scripts by default: pnpm approve-builds, allow better-sqlite3, ' +
          'then pnpm rebuild better-sqlite3.',
      },
    });
  }
  return new LacreError({
    code: 'INVALID_INPUT',
    message,
    retryable: false,
    fix: {
      note:
        'This was not a recognised Lacre error. The action did NOT complete. ' +
        'Re-check the argument schema with: lacre discover --json',
    },
  });
}
