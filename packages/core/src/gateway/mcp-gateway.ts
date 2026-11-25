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
 * What it still does not do, so nobody reads more into it than is there:
 *
 *  - It does not decide. Every call is forwarded. A gate that refuses an action
 *    is a different feature with different failure modes; this records.
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
import type { Outcome, SideEffectClass, TrustLevel } from '../receipt/schema.js';

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
  /** Store plain arguments in `action_detail`. Off by default; only the hash is kept. */
  storeArgs?: boolean;
  /** Injectable clock, so latency is measurable in a test without waiting. */
  now?: () => number;
}

export interface McpGateway {
  /** A line travelling agent to server. Returns exactly the bytes to forward. */
  fromAgent(line: string): string;
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

interface Pending {
  tool: string;
  args?: Record<string, unknown>;
  startedAt: number;
}

export function createMcpGateway(opts: McpGatewayOptions): McpGateway {
  const pending = new Map<string, Pending>();
  const now = opts.now ?? Date.now;

  const record = (call: Pending, outcome: Outcome, output: unknown): void => {
    appendReceipt(opts.db, {
      ...opts.agent,
      action: `mcp.${call.tool}`,
      actionType: 'tool_call',
      actionDetail: {
        tool: call.tool,
        ...(opts.storeArgs === true && call.args !== undefined ? { arguments: call.args } : {}),
      },
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
    fromAgent(line: string): string {
      const message = parse(line);
      if (message?.method === 'tools/call') {
        const key = idKey(message.id);
        // A tools/call with no id is a notification: nothing will come back, so
        // there is no outcome to record and nothing to wait for.
        if (key !== null) {
          const params = message.params;
          const shape =
            typeof params === 'object' && params !== null ? (params as Record<string, unknown>) : undefined;
          const tool = typeof shape?.name === 'string' ? shape.name : null;
          if (tool !== null) {
            const args = shape?.arguments;
            pending.set(key, {
              tool,
              args: typeof args === 'object' && args !== null ? (args as Record<string, unknown>) : undefined,
              startedAt: now(),
            });
          }
        }
      }
      return line;
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
