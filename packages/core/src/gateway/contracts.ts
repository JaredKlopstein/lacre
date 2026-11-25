/**
 * Contracts: the decision Lacre makes *before* a call is forwarded.
 *
 * Phase 1 (docs/adr/0006) moved recording outside the agent. Recording is
 * after the fact: it tells you what happened, and the strongest published
 * objection to hash-chained agent logs is that a record alone never stopped
 * anything. A contract is a rule evaluated on the wire, before the call
 * reaches the server, returning the `ContractResult` the receipt schema has
 * declared since ADR 0002 and that nothing until now produced.
 *
 * Three properties are deliberate, and each is pinned by a test:
 *
 *  - **The most restrictive matching contract wins**, not the first. With
 *    first-match-wins, an `allow` written above a `deny` silently disables it.
 *    Rule order must not be able to weaken a refusal.
 *  - **This function is total.** It sits on the path of production traffic. A
 *    malformed predicate, an invalid regex or a hostile argument object must
 *    produce a verdict, never an exception.
 *  - **An unevaluable predicate is not an allow.** The default is fail-closed:
 *    if the gate cannot tell, it refuses. A gate that fails open is not a gate.
 *    `onError: 'fail_open'` is available because a bug that stops real work is
 *    a real cost, but it has to be chosen in writing.
 *
 * Predicates are data, not functions, so a contract set can later come from a
 * file or a database without this module changing. That is also why an
 * operator this build does not recognise is an error rather than a non-match:
 * configuration written by a newer build must not quietly become an allow.
 */
import type { ContractResult, SideEffectClass } from '../receipt/schema.js';

/** A test against one tool argument. Addressed by dotted path. */
export type ArgumentPredicate =
  | { readonly path: string; readonly op: 'exists' }
  | { readonly path: string; readonly op: 'absent' }
  | { readonly path: string; readonly op: 'equals'; readonly value: string | number | boolean }
  | { readonly path: string; readonly op: 'matches'; readonly pattern: string };

/** What a matching contract does to the call. */
export type ContractEffect = 'allow' | 'deny' | 'require_approval';

export interface Contract {
  /** Written to `lacre.contract_id` on the receipt. */
  readonly id: string;
  readonly effect: ContractEffect;
  /** Exact tool names. Absent means any tool. */
  readonly tools?: readonly string[];
  /** Absent means any class. */
  readonly sideEffectClasses?: readonly SideEffectClass[];
  /** Every predicate must hold. Absent means no argument condition. */
  readonly where?: readonly ArgumentPredicate[];
  /** Shown to the agent on a deny and stored on the receipt. */
  readonly reason?: string;
}

export type FailurePolicy = 'fail_open' | 'fail_closed';

export interface ContractSet {
  readonly contracts: readonly Contract[];
  /** What to do when a predicate cannot be evaluated. Default `fail_closed`. */
  readonly onError?: FailurePolicy;
  /** Evaluate and record, but forward the call anyway. Default false. */
  readonly dryRun?: boolean;
}

export interface GatewayCall {
  readonly tool: string;
  readonly sideEffectClass: SideEffectClass;
  readonly args?: Record<string, unknown>;
}

export interface ContractVerdict {
  readonly effect: ContractEffect;
  /** The contract that decided, or null when none applied. */
  readonly contractId: string | null;
  readonly result: ContractResult;
  readonly reason: string | null;
  /** True when at least one contract could not be evaluated. */
  readonly errored: boolean;
}

/** Longer than any sane rule, and short enough to bound the regex engine. */
const MAX_PATTERN_LENGTH = 1000;

/** Ranks effects by restrictiveness. A higher number outranks a lower one. */
const SEVERITY: Record<ContractEffect, number> = { allow: 0, require_approval: 1, deny: 2 };

/** Thrown internally when a predicate cannot be decided; never escapes. */
class PredicateError extends Error {}

/**
 * Resolve a dotted path against tool arguments, reading own properties only.
 *
 * `Object.hasOwn` rather than `in` or a plain index is the whole point: a tool
 * argument named `constructor` or `__proto__` must not resolve to a prototype
 * member and quietly satisfy an `exists` predicate.
 */
function resolve(args: Record<string, unknown> | undefined, path: string): { found: boolean; value: unknown } {
  if (args === undefined || path === '') return { found: false, value: undefined };
  let cursor: unknown = args;
  for (const segment of path.split('.')) {
    if (Array.isArray(cursor)) {
      // Only a canonical non-negative integer indexes an array: "01" and "1.5"
      // are object keys, and an array does not have them.
      if (!/^\d+$/.test(segment)) return { found: false, value: undefined };
      const index = Number(segment);
      if (index >= cursor.length) return { found: false, value: undefined };
      cursor = cursor[index];
      continue;
    }
    if (typeof cursor !== 'object' || cursor === null) return { found: false, value: undefined };
    if (!Object.hasOwn(cursor, segment)) return { found: false, value: undefined };
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return { found: true, value: cursor };
}

function holds(predicate: ArgumentPredicate, args: Record<string, unknown> | undefined): boolean {
  const { found, value } = resolve(args, predicate.path);
  switch (predicate.op) {
    case 'exists':
      return found;
    case 'absent':
      return !found;
    case 'equals':
      // Strict equality: 1 is not "1". A contract that matched across types
      // would be a contract nobody could reason about.
      return found && value === predicate.value;
    case 'matches': {
      if (predicate.pattern.length > MAX_PATTERN_LENGTH) {
        throw new PredicateError(`pattern is longer than ${MAX_PATTERN_LENGTH} characters`);
      }
      let regex: RegExp;
      try {
        regex = new RegExp(predicate.pattern);
      } catch {
        throw new PredicateError('pattern is not a valid regular expression');
      }
      // A non-string argument does not match, and that is not an error: the
      // rule simply does not apply to this call.
      return found && typeof value === 'string' && regex.test(value);
    }
    default: {
      // An operator this build does not know. Not a non-match: see the header.
      const unknown = (predicate as { op?: unknown }).op;
      throw new PredicateError(`unknown operator ${JSON.stringify(unknown)}`);
    }
  }
}

function selectorsMatch(contract: Contract, call: GatewayCall): boolean {
  if (contract.tools !== undefined && !contract.tools.includes(call.tool)) return false;
  if (contract.sideEffectClasses !== undefined && !contract.sideEffectClasses.includes(call.sideEffectClass)) {
    return false;
  }
  return true;
}

const NOT_APPLICABLE = (errored: boolean): ContractVerdict => ({
  effect: 'allow',
  contractId: null,
  result: 'not_applicable',
  reason: null,
  errored,
});

const RESULT_FOR: Record<ContractEffect, ContractResult> = {
  allow: 'passed',
  deny: 'rejected',
  // An escalation has not passed and has not been rejected; it is pending a
  // human. `not_applicable` is the only honest value left in the AAT enum,
  // which is verbatim and not ours to extend. The receipt's `escalated`
  // outcome carries the fact that a decision was asked for.
  require_approval: 'not_applicable',
};

/**
 * Decide what happens to one call. Never throws.
 *
 * Returns the verdict of the most restrictive matching contract. A contract
 * whose predicates could not be evaluated is a deny under `fail_closed` (the
 * default) and is skipped under `fail_open`; either way `errored` is true, so
 * a caller can alert on rules that are silently not working.
 */
export function evaluateContracts(set: ContractSet, call: GatewayCall): ContractVerdict {
  const failClosed = (set.onError ?? 'fail_closed') === 'fail_closed';
  let winner: ContractVerdict | null = null;
  let errored = false;

  const consider = (candidate: ContractVerdict): void => {
    // Strictly greater, so the first contract at a given severity keeps it:
    // ties break by declaration order.
    if (winner === null || SEVERITY[candidate.effect] > SEVERITY[winner.effect]) winner = candidate;
  };

  for (const contract of set.contracts) {
    if (!selectorsMatch(contract, call)) continue;
    try {
      const applies = (contract.where ?? []).every((predicate) => holds(predicate, call.args));
      if (!applies) continue;
      consider({
        effect: contract.effect,
        contractId: contract.id,
        result: RESULT_FOR[contract.effect],
        reason: contract.reason ?? null,
        errored: false,
      });
    } catch (err) {
      errored = true;
      if (!failClosed) continue;
      const why = err instanceof Error ? err.message : String(err);
      consider({
        effect: 'deny',
        contractId: contract.id,
        result: 'rejected',
        reason: `contract ${contract.id} could not be evaluated (${why}); refusing because the failure policy is fail_closed`,
        errored: true,
      });
    }
  }

  if (winner === null) return NOT_APPLICABLE(errored);
  return { ...(winner as ContractVerdict), errored: errored || (winner as ContractVerdict).errored };
}
