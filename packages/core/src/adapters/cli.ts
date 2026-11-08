/**
 * Design law 1: the CLI is the reference surface, not a wrapper over one.
 * Benchmarks consistently show CLI beating MCP on reliability and token cost for
 * developer-shaped workflows -- sometimes by an order of magnitude on tokens.
 * MCP and HTTP will be generated from the same registry as adapters.
 *
 * Every command here is generated from the action registry, so a new action gets
 * a CLI command, --help, --json and --dry-run for free, and the surfaces cannot
 * drift apart.
 */
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { allActions, getAction } from '../registry/registry.js';
import type { ActionContext, ActionDef, NextAction } from '../registry/types.js';
import { buildManifest, EXIT_CODES } from '../registry/discover.js';
import { existsSync } from 'node:fs';
import { openDb, closeDb, type Db } from '../db/client.js';
import { resolveStoreDir, dbPath } from '../config.js';
import { readLacreEnv } from '../env.js';
import { loadKeypair } from '../actions/identity.js';
import { LacreError, toLacreError } from '../errors.js';
import type { Keypair } from '../crypto/keys.js';

// Registering the action modules IS what populates the CLI. This list must stay
// in step with src/index.ts -- when it drifted, `anchor now` and `anchor list`
// vanished from the shipped `lacre` binary while the registry test (which
// imports index.ts) still asserted they existed. cli.test.ts now asserts the
// binary's own action set, so that cannot recur silently.
import '../actions/identity.js';
import '../actions/record.js';
import '../actions/chain.js';
import '../actions/anchor.js';

/** `chain.verify` is reachable as both `chain verify` and `chain.verify`. */
function commandAliases(name: string): string[] {
  return name.includes('.') ? [name, name.replace('.', ' ')] : [name];
}

interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | boolean | string[]>;
}

/**
 * True when a token can only be read as an option: `--` alone, or `--` plus a
 * lowercase kebab-case name, optionally with `=value`. Every option this CLI
 * generates has that shape, because they come from snake_case schema keys.
 */
function isOptionShaped(token: string): boolean {
  return /^--(?:[a-z][a-z0-9-]*(?:=[\s\S]*)?)?$/.test(token);
}

/**
 * `takesValue` comes from the action registry: it says whether an option
 * (snake_case, aliases included) expects a value rather than being a boolean.
 *
 * For a value-taking option, the next token is its value even when it begins
 * with `--`, unless it is option-shaped. About 1 in 4096 base64url Ed25519
 * public keys begins with `--`, so `--public-key <key>` has to survive that.
 * An option-shaped token stays an option, so a typo such as
 * `--display-name --dryrun` is still rejected as unknown rather than silently
 * becoming the display name while the mutation runs for real. A value that is
 * itself option-shaped can always be attached as `--opt=value`.
 *
 * Booleans and options the registry does not know keep the plain rule: a next
 * token that does not begin with `--` is the value (`--reliability false`).
 */
function parseArgv(argv: string[], takesValue: (key: string) => boolean = () => false): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean | string[]> = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const body = arg.slice(2);
    const eq = body.indexOf('=');
    let key: string;
    let value: string | boolean;

    if (eq !== -1) {
      key = body.slice(0, eq);
      value = body.slice(eq + 1);
    } else {
      key = body;
      const next = argv[i + 1];
      const nextIsValue =
        next !== undefined &&
        (takesValue(key.replace(/-/g, '_')) ? !isOptionShaped(next) : !next.startsWith('--'));
      if (nextIsValue) {
        value = next;
        i++;
      } else {
        value = true;
      }
    }

    key = key.replace(/-/g, '_');
    const existing = flags[key];
    if (existing === undefined) flags[key] = value;
    else if (Array.isArray(existing)) existing.push(String(value));
    else flags[key] = [String(existing), String(value)];
  }

  return { positional, flags };
}

/**
 * Coerce CLI strings into the shapes the Zod schema expects. The CLI is the
 * reference surface, so it has to accept what a shell can actually produce:
 * JSON for objects, comma lists for arrays, bare strings for numbers.
 */
function coerceToSchema(
  flags: Record<string, string | boolean | string[]>,
  schema: z.ZodType,
  aliases: Record<string, string> = {},
  action?: ActionDef<never, never>,
): { input: Record<string, unknown>; unknown: string[] } {
  const shape = getObjectShape(schema);
  const out: Record<string, unknown> = {};
  const unknown: string[] = [];

  for (const [rawKey, raw] of Object.entries(flags)) {
    if (RESERVED_FLAGS.has(rawKey)) continue;
    const key = aliases[rawKey] ?? rawKey;
    const field = shape?.[key];
    if (!field) {
      // Collected, never silently dropped. See rejectUnknownFlags below for why
      // this is a safety property rather than a nicety.
      unknown.push(key);
      continue;
    }
    out[key] = coerceValue(raw, field, key, action);
  }
  return { input: out, unknown };
}

/** `action_detail` -> `--action-detail`. */
function optionName(key: string): string {
  return `--${key.replace(/_/g, '-')}`;
}

/**
 * A valid value for an object or array option, quoted for a shell: the
 * action's own example when it has one, otherwise a generic one.
 */
function exampleValue(key: string, type: string | undefined, action?: ActionDef<never, never>): string {
  const fromExample = action?.examples?.find((ex) => ex.arguments[key] !== undefined)?.arguments[key];
  if (fromExample !== undefined && typeof fromExample === 'object') return `'${JSON.stringify(fromExample)}'`;
  return type === 'array' ? `'["first","second"]'` : `'{"key":"value"}'`;
}

/**
 * JSON.parse, but a failure names the option and shows a value that would
 * have worked. A bare "Expected property name at position 1" tells an agent
 * neither which of its options was wrong nor what right looks like.
 */
function parseJsonOption(raw: string, key: string, type: string | undefined, action?: ActionDef<never, never>): unknown {
  try {
    return JSON.parse(raw);
  } catch (err) {
    const option = optionName(key);
    const what = type === 'array' ? 'a JSON array or a comma-separated list' : 'a JSON object';
    const command = action ? `lacre ${action.name.replace('.', ' ')}` : 'lacre';
    throw new LacreError({
      code: 'INVALID_INPUT',
      message:
        `${option} is not valid JSON (${err instanceof Error ? err.message : String(err)}). ` +
        `It takes ${what}. Nothing was executed.`,
      retryable: false,
      details: { option, field: key, received: raw },
      fix: {
        ...(action ? { action: action.name } : {}),
        // No `arguments`: running an example value as-is would record made-up facts.
        note:
          `Pass ${what} in single quotes so the shell keeps the double quotes, for example: ` +
          `${command} ${option} ${exampleValue(key, type, action)}. Keys and string values need double quotes.`,
      },
    });
  }
}

/** The type an option expects, in the words a fix should use. */
function expectedType(field: z.ZodType | undefined): string {
  if (!field) return 'nothing (this option is not defined)';
  const inner = unwrap(field) as unknown as {
    def?: { type?: string };
    options?: unknown[];
    isInt?: boolean;
  };
  switch (inner.def?.type) {
    case 'string': return 'string';
    case 'number': return inner.isInt ? 'integer' : 'number';
    case 'boolean': return 'boolean';
    case 'enum': return `one of ${(inner.options ?? []).map((o) => JSON.stringify(o)).join(' | ')}`;
    case 'record':
    case 'object': return 'JSON object';
    case 'array': return 'comma-separated list or JSON array';
    case 'unknown':
    case 'any': return 'any JSON value';
    default: return inner.def?.type ?? 'value';
  }
}

/**
 * One validation issue, phrased with the CLI option name and the expected
 * type: `--side-effect-class: expected one of "read" | "write" | "irreversible", got "money"`.
 */
function describeIssue(
  issue: z.core.$ZodIssue,
  shape: Record<string, z.ZodType>,
  input: Record<string, unknown>,
): { text: string; field: Record<string, unknown> } {
  if (issue.path.length === 0) {
    return { text: `<root>: ${issue.message}`, field: { field: null, problem: issue.message } };
  }
  const key = String(issue.path[0]);
  const nested = issue.path.length > 1;
  const option = optionName(key) + (nested ? ` (at ${issue.path.slice(1).join('.')})` : '');
  const expected = expectedType(shape[key]);
  const value = nested ? undefined : input[key];
  const got = value === undefined ? 'nothing (it is required)' : JSON.stringify(value);
  const typeProblem = issue.code === 'invalid_type' || issue.code === 'invalid_value';
  return {
    text: typeProblem && !nested
      ? `${option}: expected ${expected}, got ${got}`
      : `${option}: ${issue.message} (expects ${expected})`,
    field: {
      field: key,
      option: optionName(key),
      expected,
      ...(value !== undefined ? { received: value } : {}),
      problem: issue.message,
    },
  };
}

/**
 * Levenshtein distance, capped. Used only to suggest the flag the caller meant.
 */
function editDistance(a: string, b: string): number {
  const dp: number[] = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0]!;
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j]!;
      dp[j] = Math.min(dp[j]! + 1, dp[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length]!;
}

function suggestFlag(
  unknownFlag: string,
  schema: z.ZodType,
  aliases: Record<string, string> = {},
): string | null {
  const candidates = [
    ...Object.keys(getObjectShape(schema) ?? {}),
    ...Object.keys(aliases),
    ...RESERVED_FLAGS,
  ];

  // A truncated flag is the most common real typo (`--side-effect` for
  // `--side-effect-class`), and edit distance scores those poorly because the
  // missing suffix is long. Prefix match first.
  const prefix = candidates.filter((c) => c.startsWith(unknownFlag) || unknownFlag.startsWith(c));
  if (prefix.length === 1) return prefix[0]!;
  if (prefix.length > 1) {
    return prefix.reduce((a, b) => (Math.abs(a.length - unknownFlag.length) <= Math.abs(b.length - unknownFlag.length) ? a : b));
  }

  let best: { name: string; d: number } | null = null;
  for (const c of candidates) {
    const d = editDistance(unknownFlag, c);
    if (!best || d < best.d) best = { name: c, d };
  }
  return best && best.d <= Math.max(2, Math.floor(unknownFlag.length / 3)) ? best.name : null;
}

const RESERVED_FLAGS = new Set(['json', 'dry_run', 'store', 'help', 'quiet']);

/**
 * Which options take a value, read from the action registry. With no action
 * (before the command is resolved) only the global `--store` does.
 */
function valueOptions(action?: ActionDef<never, never>): (key: string) => boolean {
  const shape = (action && getObjectShape(action.input as z.ZodType)) ?? {};
  const aliases = action?.aliases ?? {};
  return (key) => {
    if (key === 'store') return true;
    if (RESERVED_FLAGS.has(key)) return false;
    const field = shape[aliases[key] ?? key];
    if (!field) return false;
    return (unwrap(field) as unknown as { def?: { type?: string } }).def?.type !== 'boolean';
  };
}

/**
 * Fix text for value-taking options that ended up with no value, which is
 * what a value beginning with `--` looks like when it was read as an option.
 */
function missingValueHint(
  flags: Record<string, string | boolean | string[]>,
  takesValue: (key: string) => boolean,
): string {
  const bare = Object.keys(flags).filter((k) => flags[k] === true && takesValue(k));
  return bare
    .map((k) => {
      const opt = `--${k.replace(/_/g, '-')}`;
      return ` ${opt} takes a value but got none. If the value itself begins with '--', attach it with '=': ${opt}=<value>.`;
    })
    .join('');
}

function getObjectShape(schema: z.ZodType): Record<string, z.ZodType> | null {
  const def = (schema as unknown as { def?: { type?: string; shape?: Record<string, z.ZodType> } }).def;
  if (def?.type === 'object' && def.shape) return def.shape;
  return null;
}

function unwrap(schema: z.ZodType): z.ZodType {
  let cur = schema;
  for (let i = 0; i < 10; i++) {
    const def = (cur as unknown as { def?: { type?: string; innerType?: z.ZodType } }).def;
    if (def && (def.type === 'optional' || def.type === 'default' || def.type === 'nullable') && def.innerType) {
      cur = def.innerType;
    } else break;
  }
  return cur;
}

function coerceValue(
  raw: string | boolean | string[],
  field: z.ZodType,
  key: string,
  action?: ActionDef<never, never>,
): unknown {
  const inner = unwrap(field);
  const type = (inner as unknown as { def?: { type?: string } }).def?.type;

  if (type === 'boolean') return raw === true || raw === 'true';
  if (typeof raw === 'boolean') return raw;

  if (type === 'number') {
    const n = Number(raw);
    return Number.isNaN(n) ? raw : n;
  }
  if (type === 'array') {
    if (Array.isArray(raw)) return raw;
    const s = String(raw).trim();
    if (s.startsWith('[')) return parseJsonOption(s, key, type, action);
    return s.split(',').map((p) => p.trim()).filter(Boolean);
  }
  if (type === 'record' || type === 'object') {
    return parseJsonOption(String(raw), key, type, action);
  }
  // z.unknown() for --input/--output: accept JSON, fall back to the raw string.
  if (type === 'unknown' || type === 'any') {
    const s = String(raw);
    try {
      return JSON.parse(s);
    } catch {
      return s;
    }
  }
  return raw;
}

// ---------------------------------------------------------------- help

function renderActionHelp(action: ActionDef<never, never>): string {
  const d = action.description;
  const shape = getObjectShape(action.input as z.ZodType) ?? {};
  const lines: string[] = [];

  lines.push(`lacre ${action.name.replace('.', ' ')} -- ${action.summary}`);
  lines.push('');
  lines.push(`WHAT      ${wrap(d.what)}`);
  lines.push(`WHEN      ${wrap(d.when)}`);
  lines.push(`WHEN NOT  ${wrap(d.whenNot)}`);
  lines.push(`COST      ${wrap(d.cost)}`);
  lines.push(`RETURNS   ${wrap(d.returns)}`);
  lines.push('');
  lines.push(`SIDE EFFECT CLASS: ${action.sideEffect}${action.dryRun ? '  (supports --dry-run)' : ''}`);
  lines.push('');
  lines.push('OPTIONS');
  for (const [name, field] of Object.entries(shape)) {
    const desc = (field as unknown as { description?: string }).description ?? '';
    const optional = isOptional(field);
    lines.push(`  --${name.replace(/_/g, '-')}${optional ? '' : '  (required)'}`);
    if (desc) lines.push(`      ${wrap(desc, 6)}`);
  }
  const aliasesByCanonical = new Map<string, string[]>();
  for (const [alias, canonical] of Object.entries(action.aliases ?? {})) {
    aliasesByCanonical.set(canonical, [...(aliasesByCanonical.get(canonical) ?? []), alias]);
  }
  if (aliasesByCanonical.size) {
    lines.push('');
    lines.push('ALSO ACCEPTED');
    for (const [canonical, list] of aliasesByCanonical) {
      lines.push(`  ${list.map((a) => '--' + a.replace(/_/g, '-')).join(', ')}  ->  --${canonical.replace(/_/g, '-')}`);
    }
  }
  lines.push('');
  lines.push('  --json          Emit machine-readable JSON (recommended for agents)');
  if (action.dryRun) lines.push('  --dry-run       Show the exact effect, apply nothing');
  lines.push('  --store <dir>   Override the store location');
  lines.push('');
  lines.push("EXIT CODES: 0 success, 1 any error. See 'lacre --help'.");

  if (action.examples?.length) {
    lines.push('');
    lines.push('EXAMPLES');
    for (const ex of action.examples) {
      lines.push(`  # ${ex.description}`);
      lines.push(`  ${renderExample(action.name, ex.arguments)}`);
    }
  }
  return lines.join('\n');
}

function renderExample(name: string, args: Record<string, unknown>): string {
  const parts = Object.entries(args).map(([k, v]) => {
    const flag = `--${k.replace(/_/g, '-')}`;
    if (typeof v === 'boolean') return v ? flag : '';
    if (typeof v === 'object') return `${flag} '${JSON.stringify(v)}'`;
    return `${flag} ${JSON.stringify(String(v))}`;
  });
  return `lacre ${name.replace('.', ' ')} ${parts.filter(Boolean).join(' ')}`;
}

function isOptional(field: z.ZodType): boolean {
  const type = (field as unknown as { def?: { type?: string } }).def?.type;
  return type === 'optional' || type === 'default' || type === 'nullable';
}

function wrap(text: string, indent = 10): string {
  const width = 78 - indent;
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    if ((line + ' ' + w).trim().length > width) {
      lines.push(line.trim());
      line = w;
    } else line += ' ' + w;
  }
  if (line.trim()) lines.push(line.trim());
  return lines.join('\n' + ' '.repeat(indent));
}

function renderRootHelp(): string {
  const lines: string[] = [];
  lines.push('lacre -- tamper-evident receipts for autonomous agents');
  lines.push('');
  lines.push('USAGE');
  lines.push('  lacre <command> [options] [--json]');
  lines.push('');
  lines.push('COMMANDS');
  const width = Math.max(...allActions().map((a) => a.name.length)) + 2;
  for (const a of allActions()) {
    lines.push(`  ${a.name.replace('.', ' ').padEnd(width)} ${a.summary}`);
  }
  lines.push(`  ${'discover'.padEnd(width)} Full machine-readable manifest of this service`);
  lines.push('');
  lines.push('GLOBAL OPTIONS');
  lines.push('  --json          Machine-readable output. Every command supports it.');
  lines.push('  --dry-run       On mutations: show the exact effect, apply nothing.');
  lines.push('  --store <dir>   Store location (default: $LACRE_HOME, ./.lacre, or ~/.lacre)');
  lines.push('  --help          This help, or per-command help.');
  lines.push('');
  lines.push('EXIT CODES');
  for (const [code, meaning] of Object.entries(EXIT_CODES)) {
    lines.push(`  ${code.padEnd(4)}${wrap(meaning, 6)}`);
  }
  lines.push('');
  lines.push('START HERE');
  lines.push('  lacre init --json');
  lines.push('  lacre discover --json     # full schemas, errors, quickstart');
  lines.push('');
  lines.push('Agents: `lacre discover --json` returns everything needed to operate');
  lines.push('this service, including input/output JSON Schemas and a literal quickstart.');
  return lines.join('\n');
}

// ---------------------------------------------------------------- run

export interface CliIO {
  out(text: string): void;
  err(text: string): void;
}

const defaultIO: CliIO = {
  out: (t) => process.stdout.write(t + '\n'),
  err: (t) => process.stderr.write(t + '\n'),
};

export async function runCli(argv: string[], io: CliIO = defaultIO): Promise<number> {
  let { positional, flags } = parseArgv(argv, valueOptions());
  const json = flags.json === true || flags.json === 'true';

  const emitError = (err: unknown): number => {
    const pe = toLacreError(err);
    if (json) io.err(JSON.stringify(pe.toJSON(), null, 2));
    else {
      io.err(`error [${pe.code}]: ${pe.message}`);
      if (pe.fix) {
        io.err(`  fix: ${pe.fix.note}`);
        if (pe.fix.action) {
          io.err(`  next: lacre ${pe.fix.action.replace('.', ' ')} ${
            pe.fix.arguments ? JSON.stringify(pe.fix.arguments) : ''
          }`);
        }
      }
      io.err(`  retryable: ${pe.retryable}`);
    }
    return 1;
  };

  // Resolve the command by longest alias first, so `chain verify` wins over `chain`.
  let matched: ActionDef<never, never> | undefined;
  let consumed = 0;
  const two = positional.slice(0, 2).join(' ');
  const one = positional[0];

  for (const action of allActions()) {
    for (const alias of commandAliases(action.name)) {
      if (alias === two && alias.includes(' ')) {
        matched = action;
        consumed = 2;
      } else if (!matched && alias === one) {
        matched = action;
        consumed = 1;
      }
    }
  }

  // Now that the action is known, re-read the options with its schema, so a
  // value-taking option keeps a value that begins with '--'.
  const takesValue = valueOptions(matched);
  if (matched) ({ positional, flags } = parseArgv(argv, takesValue));
  const rest = positional.slice(consumed);

  if (!matched) {
    if (one === 'discover') {
      io.out(JSON.stringify(buildManifest(), null, 2));
      return 0;
    }
    if (!one || one === 'help' || flags.help) {
      io.out(json ? JSON.stringify(buildManifest(), null, 2) : renderRootHelp());
      return 0;
    }
    return emitError(
      new LacreError({
        code: 'INVALID_INPUT',
        message: `Unknown command '${positional.join(' ')}'. Nothing was executed.`,
        retryable: false,
        fix: {
          action: 'discover',
          arguments: {},
          note: `Run 'lacre discover --json' for the full action list with schemas. Available: ${allActions()
            .map((a) => a.name)
            .join(', ')}.`,
        },
      }),
    );
  }

  if (flags.help === true) {
    io.out(json ? JSON.stringify(describeAction(matched), null, 2) : renderActionHelp(matched));
    return 0;
  }

  const storeDir = resolveStoreDir(typeof flags.store === 'string' ? flags.store : undefined);
  // Opened only once the arguments are known to be valid, so a rejected call
  // never touches the store.
  let db: Db | undefined;

  try {
    const { input: rawInput, unknown: unknownFlags } = coerceToSchema(
      flags,
      matched.input as z.ZodType,
      matched.aliases ?? {},
      matched,
    );

    /**
     * Reject unknown flags. This is a SAFETY property, not tidiness.
     *
     * Silently dropping them made the dry-run guard fail OPEN: `--dryrun`
     * (a typo of `--dry-run`) executed the mutation for real and reported
     * success. Worse, `--side-effect irreversible` (correct flag:
     * `--side-effect-class`) recorded the action as `write` and returned ok --
     * permanently writing the wrong risk class into a tamper-evident chain.
     * A mistyped filter like `--agent x` silently widened a query to everything.
     *
     * For an audit tool, a typo that quietly changes what is recorded or
     * returned is worse than an error. Fail loudly, and name the likely fix.
     */
    if (unknownFlags.length > 0) {
      const details = unknownFlags.map((f) => {
        const suggestion = suggestFlag(f, matched!.input as z.ZodType, matched!.aliases ?? {});
        return suggestion
          ? `--${f.replace(/_/g, '-')} (did you mean --${suggestion.replace(/_/g, '-')}?)`
          : `--${f.replace(/_/g, '-')}`;
      });
      return emitError(
        new LacreError({
          code: 'UNKNOWN_ARGUMENT',
          message:
            `Unrecognised option(s) for '${matched.name}': ${details.join(', ')}. ` +
            `Nothing was executed. Unknown options are rejected rather than ignored, because a ` +
            `mistyped flag could otherwise change what gets recorded or silently widen a query.`,
          retryable: false,
          details: { unknown: unknownFlags },
          fix: {
            action: matched.name,
            note:
              `Run 'lacre ${matched.name.replace('.', ' ')} --help' for the exact option names, or 'lacre discover --json' for the full input schema.` +
              missingValueHint(flags, takesValue),
          },
        }),
      );
    }
    // Allow `lacre record refund.issue` as shorthand for --action.
    if (rest[0] && matched.name === 'record' && rawInput.action === undefined) {
      rawInput.action = rest[0];
    }

    const parsed = (matched.input as z.ZodType).safeParse(rawInput);
    if (!parsed.success) {
      const shape = getObjectShape(matched.input as z.ZodType) ?? {};
      const described = parsed.error.issues.map((i) => describeIssue(i, shape, rawInput));
      return emitError(
        new LacreError({
          code: 'INVALID_INPUT',
          message: `Arguments for '${matched.name}' failed validation: ${described
            .map((d) => d.text)
            .join('; ')}. Nothing was executed.`,
          retryable: false,
          details: {
            fields: described.map((d) => d.field),
            issues: parsed.error.issues as unknown as Record<string, unknown>[],
          },
          fix: {
            action: matched.name,
            note:
              `Run 'lacre ${matched.name.replace('.', ' ')} --help' for every option, or 'lacre discover --json' for the full input schema.` +
              missingValueHint(flags, takesValue),
          },
        }),
      );
    }

    const wantDryRun = flags.dry_run === true || flags.dry_run === 'true';
    if (wantDryRun && !matched.dryRun) {
      return emitError(
        new LacreError({
          code: 'INVALID_INPUT',
          message: `'${matched.name}' is a ${matched.sideEffect} action and has no dry-run. Nothing was executed.`,
          retryable: false,
          fix: { action: matched.name, note: 'Read actions have no effect to preview; call it directly.' },
        }),
      );
    }

    // Fail closed. A read against a store that does not exist must not create
    // an empty one and then report it as a clean, verified chain: a typo in
    // --store or LACRE_HOME would otherwise look exactly like a sound record.
    const file = dbPath(storeDir);
    const storeExists = existsSync(file);
    if (!storeExists && matched.sideEffect === 'read') {
      return emitError(notInitialized(storeDir, file));
    }
    // A dry run applies nothing, and that includes creating the store. Against
    // a store that does not exist yet it previews from an empty in-memory one.
    db = openDb(storeExists || !wantDryRun ? file : ':memory:');

    let cached: Keypair | null = null;
    const ctx: ActionContext = {
      db,
      storeDir,
      sessionId: readLacreEnv('LACRE_SESSION_ID') ?? randomUUID(),
      identity: () => (cached ??= loadKeypair(storeDir)),
    };

    const input = parsed.data as never;
    const result = await (wantDryRun ? matched.dryRun!(input, ctx) : matched.handler(input, ctx));

    const nextActions: NextAction[] = matched.nextActions
      ? matched.nextActions(input, result, ctx)
      : [];

    if (json) {
      io.out(
        JSON.stringify(
          { ok: true, action: matched.name, result, next_actions: nextActions },
          null,
          2,
        ),
      );
    } else {
      io.out(renderHuman(matched.name, result, nextActions, wantDryRun));
    }
    return 0;
  } catch (err) {
    return emitError(err);
  } finally {
    if (db) closeDb(db);
  }
}

/** NOT_INITIALIZED for a read against a store with no database. */
function notInitialized(storeDir: string, file: string): LacreError {
  return new LacreError({
    code: 'NOT_INITIALIZED',
    message:
      `No Lacre store at ${storeDir} (expected ${file}). Nothing was executed and no files were created. ` +
      `A read against a missing store fails rather than reporting an empty chain as verified.`,
    retryable: false,
    details: { store: storeDir, db_path: file },
    fix: {
      action: 'init',
      arguments: {},
      note:
        `If this is the right location, run 'lacre init --store ${storeDir}' to create it. If you meant an ` +
        `existing store, pass its directory with --store <dir> or set LACRE_HOME to it; a misspelled path ` +
        `lands here. The store directory is the one holding lacre.db.`,
    },
  });
}

function describeAction(a: ActionDef<never, never>): Record<string, unknown> {
  const m = buildManifest().actions as Array<Record<string, unknown>>;
  return m.find((x) => x.name === a.name) ?? {};
}

function renderHuman(
  name: string,
  result: unknown,
  next: NextAction[],
  dryRun: boolean,
): string {
  const lines: string[] = [];
  if (dryRun) lines.push('DRY RUN -- nothing was written.');
  lines.push(JSON.stringify(result, null, 2));
  if (next.length) {
    lines.push('');
    lines.push('next:');
    for (const n of next) lines.push(`  ${n.action} -- ${n.why}`);
  }
  return lines.join('\n');
}
