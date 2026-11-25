/**
 * MCP gateway recorder: one chained receipt per tools/call, written from
 * outside the agent's process.
 *
 * src/adapters/mcp.ts already records tool calls, but it runs *inside* the
 * agent and signs with a key the agent holds. A receipt it writes says what the
 * agent reported about itself, and an agent that can reach its own signing key
 * and its own store can rewrite both. This module is the other half of
 * docs/adr/0004: it sits on the wire between the agent and the MCP server,
 * keeps the signing key in its own process, and writes `issuer_kind: 'gateway'`
 * -- the value that ADR reserved for "an intermediary that saw the call on the
 * wire", and which until now nothing in this repository produced.
 *
 * With a contract set (docs/adr/0007) it also *decides*: a rule is evaluated
 * before the call is forwarded, and a refusal is returned to the agent as a
 * JSON-RPC error with a receipt recording what was refused and which rule
 * refused it. Without one it behaves exactly as it did before, forwarding
 * everything, and the receipts it writes keep their earlier bytes.
 *
 * What it still does not do, so nobody reads more into it than is there:
 *
 *  - A deny stops the call *through this proxy*. It is not egress control. An
 *    agent holding its own API keys can call a service directly and this will
 *    neither see it nor stop it.
 *  - It only sees traffic routed through it. An agent holding its own API keys
 *    can call a service directly and this will never know.
 *  - `provenance_class: 'observed'` means the bytes crossed this process. It is
 *    not a claim that the tool did what it said.
 *
 * The transport is deliberately not in here. This takes lines and returns the
 * lines to forward, so it is testable without spawning anything, and so the
 * same logic can sit behind stdio, a socket or a test harness.
 */
import type { Db } from '../db/client.js';
import { appendReceipt } from '../chain/append.js';
import type { ContractResult, Outcome, SideEffectClass, TrustLevel } from '../receipt/schema.js';
import { evaluateContracts, type ContractSet } from './contracts.js';
import { actionHashFor, type ApprovalStore } from './approvals.js';

export interface McpGatewayOptions {
  db: Db;
  /** The identity the gateway signs as. Its key lives here, not in the agent. */
  agent: {
    agentId: string;
    agentVersion: string;
    trustLevel: TrustLevel;
    keyId: string;
    secretKey: Uint8Array;
  };
  sessionId: string;
  runId?: string;
  turnId?: string;
  attemptId?: string;
  /**
   * One class for every tool, or a map of tool name to class. Any tool without
   * one is `write`: an MCP tool's effect is unknown, so it is not assumed safe.
   */
  sideEffectClass?: SideEffectClass | Record<string, SideEffectClass>;
  /**
   * Rules evaluated before a call is forwarded. Absent means the gateway only
   * records, exactly as it did before contracts existed.
   */
  contracts?: ContractSet;
  /**
   * Where `require_approval` decisions are read from and asked for. Required
   * for a contract set that uses `require_approval`; without it such a
   * contract can never be satisfied, so the call is refused.
   */
  approvals?: ApprovalStore;
  /** Store plain arguments in `action_detail`. Off by default; only the hash is kept. */
  storeArgs?: boolean;
  /** Injectable clock, so latency is measurable in a test without waiting. */
  now?: () => number;
}

/**
 * What to do with a line the agent sent.
 *
 * `fromAgent` returns this rather than a string because a gateway that can
 * refuse has two outputs, not one. The type change is deliberate: every
 * existing caller has to be updated, rather than silently forwarding a call
 * the gate refused.
 */
export interface AgentDirective {
  /** Bytes to forward to the server, or null when the call was refused. */
  readonly forward: string | null;
  /** Bytes to write back to the agent, or null. A JSON-RPC error on a refusal. */
  readonly reply: string | null;
}

export interface McpGateway {
  /**
   * A line travelling agent to server. When the call is allowed, `forward`
   * holds exactly the bytes received. When a contract refuses it, `forward` is
   * null and `reply` holds the JSON-RPC error for the agent.
   */
  fromAgent(line: string): AgentDirective;
  /** A line travelling server to agent. Returns exactly the bytes to forward. */
  fromServer(line: string): string;
  /** Calls seen but not yet answered. */
  pendingCount(): number;
  /**
   * Record every in-flight call as having ended this way, and forget them.
   * Returns how many were written. This is the case an in-agent recorder
   * cannot cover: a recorder that dies with the agent writes nothing at all.
   */
  abandon(outcome: Extract<Outcome, 'timeout' | 'failure'>): number;
}

const DEFAULT_SIDE_EFFECT_CLASS: SideEffectClass = 'write';

function sideEffectFor(opt: McpGatewayOptions['sideEffectClass'], tool: string): SideEffectClass {
  if (opt === undefined) return DEFAULT_SIDE_EFFECT_CLASS;
  if (typeof opt === 'string') return opt;
  // Own keys only, so a tool named e.g. "constructor" cannot pick up a prototype member.
  return Object.hasOwn(opt, tool) ? opt[tool]! : DEFAULT_SIDE_EFFECT_CLASS;
}

/** A JSON-RPC id is a string or a number, and 1 is not "1". */
function idKey(id: unknown): string | null {
  if (typeof id === 'number') return `n:${id}`;
  if (typeof id === 'string') return `s:${id}`;
  return null;
}

function parse(line: string): Record<string, unknown> | null {
  const text = line.trim();
  if (text === '' || (text[0] !== '{' && text[0] !== '[')) return null;
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    // Not JSON. Forwarding it unchanged is the only correct thing to do: this
    // process is a proxy, not a validator, and the server may accept what we
    // cannot read.
    return null;
  }
}

/** MCP reports tool-level errors in-band as `{ isError: true }`, not by failing the call. */
function isErrorResult(result: unknown): boolean {
  return typeof result === 'object' && result !== null && (result as { isError?: unknown }).isError === true;
}

/**
 * JSON-RPC reserves -32000..-32099 for implementation-defined server errors.
 * These two are Lacre's, and they are distinct so an agent (or a human reading
 * a transcript) can tell "never allowed" from "waiting on a person".
 */
export const LACRE_DENIED_CODE = -32001;
export const LACRE_APPROVAL_REQUIRED_CODE = -32002;

function jsonRpcError(id: unknown, code: number, message: string, data: Record<string, unknown>): string {
  // `id` is echoed so the agent's client can settle the right promise. A
  // request with no usable id never reaches here: it is a notification.
  return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message, data } });
}

/** The pre-execution decision, carried onto the receipt for the call. */
interface Decision {
  contractId: string | null;
  contractResult: ContractResult | null;
  approvalId: string | null;
  reason: string | null;
  dryRun: boolean;
}

const NO_DECISION: Decision = {
  contractId: null,
  contractResult: null,
  approvalId: null,
  reason: null,
  dryRun: false,
};

interface Pending {
  tool: string;
  args?: Record<string, unknown>;
  startedAt: number;
  decision: Decision;
}

export function createMcpGateway(opts: McpGatewayOptions): McpGateway {
  const pending = new Map<string, Pending>();
  const now = opts.now ?? Date.now;

  const record = (call: Pending, outcome: Outcome, output: unknown): void => {
    const { decision } = call;
    appendReceipt(opts.db, {
      ...opts.agent,
      action: `mcp.${call.tool}`,
      actionType: 'tool_call',
      actionDetail: {
        tool: call.tool,
        ...(opts.storeArgs === true && call.args !== undefined ? { arguments: call.args } : {}),
        // What was refused and which rule refused it. The tool and the
        // argument hash are already on the receipt; this is the part a reader
        // cannot reconstruct.
        ...(decision.contractId !== null
          ? {
              contract: {
                id: decision.contractId,
                ...(decision.contractResult !== null ? { result: decision.contractResult } : {}),
                ...(decision.reason !== null ? { reason: decision.reason } : {}),
                // Present only on a dry run, so its absence cannot be read as
                // "this gate was live" on a receipt written before dry-run existed.
                ...(decision.dryRun ? { dry_run: true } : {}),
              },
            }
          : {}),
      },
      ...(decision.contractId !== null ? { contractId: decision.contractId } : {}),
      ...(decision.contractResult !== null ? { contractResult: decision.contractResult } : {}),
      ...(decision.approvalId !== null ? { approvalId: decision.approvalId } : {}),
      sideEffectClass: sideEffectFor(opts.sideEffectClass, call.tool),
      outcome,
      sessionId: opts.sessionId,
      input: call.args,
      output,
      // The two fields this module exists to write.
      issuerKind: 'gateway',
      provenanceClass: 'observed',
      runId: opts.runId,
      turnId: opts.turnId,
      attemptId: opts.attemptId,
      latencyMs: Math.max(0, Math.round(now() - call.startedAt)),
    });
  };

  return {
    fromAgent(line: string): AgentDirective {
      const pass = (): AgentDirective => ({ forward: line, reply: null });
      const message = parse(line);
      if (message?.method !== 'tools/call') return pass();

      const key = idKey(message.id);
      // A tools/call with no id is a notification: nothing comes back, so there
      // is no outcome to record and nothing to wait for. It is also not gated,
      // because there is no reply channel on which to refuse it.
      if (key === null) return pass();

      const params = message.params;
      const shape =
        typeof params === 'object' && params !== null ? (params as Record<string, unknown>) : undefined;
      const tool = typeof shape?.name === 'string' ? shape.name : null;
      if (tool === null) return pass();

      const rawArgs = shape?.arguments;
      const args =
        typeof rawArgs === 'object' && rawArgs !== null && !Array.isArray(rawArgs)
          ? (rawArgs as Record<string, unknown>)
          : undefined;
      const startedAt = now();

      // No contract set: record only, exactly as this module behaved before
      // contracts existed, down to the bytes of the receipt.
      if (opts.contracts === undefined) {
        pending.set(key, { tool, args, startedAt, decision: NO_DECISION });
        return pass();
      }

      const sideEffectClass = sideEffectFor(opts.sideEffectClass, tool);
      // The decision is computed here, from the contract set held in this
      // process. Nothing in `message` contributes to it: an agent cannot
      // supply, name or weaken a contract over the wire.
      const verdict = evaluateContracts(opts.contracts, { tool, sideEffectClass, args });
      const dryRun = opts.contracts.dryRun === true;
      const base: Decision = {
        contractId: verdict.contractId,
        contractResult: verdict.result,
        approvalId: null,
        reason: verdict.reason,
        dryRun,
      };

      /** Let the call through, carrying the decision onto its eventual receipt. */
      const allow = (decision: Decision): AgentDirective => {
        pending.set(key, { tool, args, startedAt, decision });
        return pass();
      };

      /**
       * Refuse the call: write its receipt now and hand the agent an error.
       * The call never reaches the server, so no response will arrive and
       * nothing is left pending.
       */
      const refuse = (decision: Decision, outcome: Outcome, code: number, text: string): AgentDirective => ({
        forward: null,
        reply: ((): string => {
          record({ tool, args, startedAt, decision }, outcome, undefined);
          return jsonRpcError(message.id, code, text, {
            lacre: {
              tool,
              ...(decision.contractId !== null ? { contract_id: decision.contractId } : {}),
              ...(decision.reason !== null ? { reason: decision.reason } : {}),
            },
          });
        })(),
      });

      if (verdict.effect === 'allow') return allow(base);

      if (verdict.effect === 'require_approval') {
        const contractId = verdict.contractId ?? '(unnamed)';
        // A contract that asks for approval with nowhere to read answers from
        // can never be satisfied. Refusing is the fail-closed reading, and the
        // message names the fix rather than leaving the operator to guess.
        if (opts.approvals === undefined) {
          const decision: Decision = { ...base, contractResult: 'rejected' };
          if (dryRun) return allow(decision);
          return refuse(
            decision,
            'denied',
            LACRE_DENIED_CODE,
            `Contract ${contractId} requires approval for ${tool}, but this gateway has no approval store, ` +
              `so no approval can ever be found. Pass \`approvals\` to createMcpGateway, or change the ` +
              `contract's effect to 'allow' or 'deny'.`,
          );
        }

        const actionHash = actionHashFor(tool, args);
        const answer = opts.approvals.lookup(actionHash);

        if (answer !== undefined && answer.granted) {
          // Approved for this exact tool and these exact arguments.
          return allow({ ...base, contractResult: 'passed', approvalId: answer.approvalId });
        }

        if (answer !== undefined) {
          // A person said no. That is a rejection, not an escalation.
          const decision: Decision = { ...base, contractResult: 'rejected', approvalId: answer.approvalId };
          if (dryRun) return allow(decision);
          return refuse(
            decision,
            'denied',
            LACRE_DENIED_CODE,
            `Contract ${contractId} required approval for ${tool} and it was refused.` +
              (verdict.reason !== null ? ` Rule: ${verdict.reason}` : ''),
          );
        }

        // Nobody has answered. Register the ask and refuse retriably.
        opts.approvals.request({
          actionHash,
          tool,
          contractId,
          reason: verdict.reason,
          requestedAt: startedAt,
        });
        if (dryRun) return allow(base);
        return refuse(
          base,
          'escalated',
          LACRE_APPROVAL_REQUIRED_CODE,
          `Contract ${contractId} requires approval before ${tool} runs, and no decision has been recorded ` +
            `for these exact arguments. The request is now pending. Retry the identical call once it is ` +
            `approved; a different argument needs its own approval.` +
            (verdict.reason !== null ? ` Rule: ${verdict.reason}` : ''),
        );
      }

      // --- deny ---
      if (dryRun) return allow(base);
      return refuse(
        base,
        'denied',
        LACRE_DENIED_CODE,
        `Contract ${verdict.contractId ?? '(unnamed)'} refused ${tool}.` +
          (verdict.reason !== null ? ` Rule: ${verdict.reason}` : ''),
      );
    },

    fromServer(line: string): string {
      const message = parse(line);
      if (message !== null) {
        const key = idKey(message.id);
        const call = key === null ? undefined : pending.get(key);
        if (key !== null && call !== undefined) {
          // Delete first: a duplicate response for the same id must not write a
          // second receipt for one call.
          pending.delete(key);
          const failed = message.error !== undefined || isErrorResult(message.result);
          // No output on failure: there was no result, and the server's error
          // text is not ours to store.
          record(call, failed ? 'failure' : 'success', failed ? undefined : message.result);
        }
      }
      return line;
    },

    pendingCount: () => pending.size,

    abandon(outcome): number {
      const abandoned = [...pending.values()];
      pending.clear();
      for (const call of abandoned) record(call, outcome, undefined);
      return abandoned.length;
    },
  };
}
