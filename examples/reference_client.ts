/**
 * Lacre reference client -- TypeScript. ~40 lines of actual logic.
 *
 * Wraps the CLI rather than reimplementing the protocol, deliberately: the CLI
 * is the reference surface, it already emits structured JSON and structured
 * errors, and shelling out means this client can never drift from the format.
 *
 * Run:  npx tsx examples/reference_client.ts
 *
 * Copied into another project, set LACRE_BIN to the path of
 * packages/core/bin/lacre.mjs in your Lacre checkout (or to an installed
 * `lacre` executable once the package is published).
 */
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = process.env.LACRE_BIN || fileURLToPath(new URL('../packages/core/bin/lacre.mjs', import.meta.url));
// A .mjs/.js path runs under node; anything else is an executable.
const [CMD, ...PREFIX] = /\.[cm]?js$/.test(BIN) ? [process.execPath, BIN] : [BIN];

export interface LacreError {
  code: string;
  message: string;
  retryable: boolean;
  fix?: { action?: string; arguments?: Record<string, unknown>; note: string };
}

function call(command: string, args: Record<string, unknown> = {}): any {
  const argv = [...PREFIX, ...command.split(' '), '--json'];
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === false) continue;
    argv.push(`--${key.replace(/_/g, '-')}`);
    if (value !== true) argv.push(typeof value === 'object' ? JSON.stringify(value) : String(value));
  }
  try {
    return JSON.parse(execFileSync(CMD!, argv, { encoding: 'utf8' })).result;
  } catch (err: any) {
    // Every Lacre error carries a `fix` telling you exactly what to do next.
    const parsed = JSON.parse(err.stdout || err.stderr || '{}')?.error as LacreError | undefined;
    if (parsed) throw Object.assign(new Error(parsed.message), parsed);
    throw err;
  }
}

export const lacre = {
  init: (displayName: string) => call('init', { display_name: displayName }),
  record: (action: string, detail: Record<string, unknown>, opts: Record<string, unknown> = {}) =>
    call('record', { action, action_detail: detail, ...opts }),
  verify: () => call('chain verify'),
  head: () => call('chain head'),
};

// --- demo ---
// Compared as paths, not URLs, so a directory with a space in it still matches.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const me = lacre.init('reference-client-ts');
  console.log('agent:', me.agent_id);

  const receipt = lacre.record(
    'refund.issue',
    { customer_id: 'c_8812', amount_usd: 42.5 },
    { side_effect_class: 'irreversible', idempotency_key: 'refund-c_8812-0001' },
  );
  // replayed: true means this key was already recorded and nothing new was written.
  console.log('receipt seq:', receipt.seq, 'hash:', receipt.self_hash.slice(0, 16), 'replayed:', receipt.replayed);

  console.log('chain ok:', lacre.verify().ok);
}
