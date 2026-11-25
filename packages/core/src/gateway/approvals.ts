/**
 * Approvals: the human-in-the-loop half of a contract.
 *
 * A contract with `effect: 'require_approval'` does not decide on its own. It
 * asks, and the call waits for an answer from someone who is not the agent.
 *
 * **How waiting works here, stated plainly.** The gateway sits on a synchronous
 * line-in/line-out wire, so it does not park a request and resume it later.
 * Instead it refuses the call *now* with a retriable JSON-RPC error, records
 * `outcome: 'escalated'`, and registers the request. A person answers out of
 * band. The agent's next attempt at the same call finds the decision and
 * proceeds or is refused. So "hold" means **refused now, retriable once
 * answered** -- not a socket held open. That is a real limitation and it is
 * written down rather than implied: an agent that never retries never runs the
 * approved call.
 *
 * **An approval is bound to one action, not one tool.** The key is a hash of
 * the tool name and its canonical arguments, so approving `delete_file` on
 * `/tmp/scratch` does not authorise `delete_file` on `/`. The receipt schema
 * has said "approvals, bound to a specific action hash" since ADR 0002; this
 * is that binding.
 *
 * Grants may expire. An expired grant is treated as no grant: the call
 * escalates again rather than proceeding on a stale yes.
 *
 * The store is an interface because the durable implementation belongs with
 * the operator's own review queue. What ships here is in-memory, which means a
 * gateway restart forgets every pending request and every grant. For a
 * long-running gate that is not good enough, and nothing here pretends
 * otherwise.
 */
import { payloadHash } from '../receipt/hash.js';

export interface ApprovalDecision {
  readonly approvalId: string;
  /** True: the call may proceed. False: it is refused. */
  readonly granted: boolean;
  /** Epoch milliseconds after which a grant no longer counts. */
  readonly expiresAt?: number;
}

export interface PendingApproval {
  readonly actionHash: string;
  readonly tool: string;
  readonly contractId: string;
  readonly reason: string | null;
  readonly requestedAt: number;
}

export interface ApprovalStore {
  /** The decision for this exact action, if anyone has made one. */
  lookup(actionHash: string): ApprovalDecision | undefined;
  /** Register that a decision was asked for, so a person has something to answer. */
  request(req: PendingApproval): void;
  /** Requests nobody has answered yet. */
  pending(): readonly PendingApproval[];
}

/**
 * The key an approval is bound to: this tool with these arguments.
 *
 * `payloadHash` is RFC 8785 canonicalization then SHA-256, the same function
 * the receipt uses for `input_hash`, so two calls that differ only in key
 * order share an approval and two that differ in any value do not.
 */
export function actionHashFor(tool: string, args: Record<string, unknown> | undefined): string {
  return payloadHash({ tool, arguments: args });
}

export interface MemoryApprovalStore extends ApprovalStore {
  /** Answer yes. `ttlMs` makes the grant expire; without it, it does not. */
  grant(actionHash: string, opts?: { approvalId?: string; ttlMs?: number }): ApprovalDecision;
  /** Answer no. */
  deny(actionHash: string, opts?: { approvalId?: string }): ApprovalDecision;
  /** Forget a decision, so the next call escalates again. */
  revoke(actionHash: string): void;
}

/**
 * An in-memory store, for tests and for a single short-lived gateway.
 *
 * `now` is injectable so expiry is testable without waiting.
 */
export function createMemoryApprovalStore(opts: { now?: () => number } = {}): MemoryApprovalStore {
  const now = opts.now ?? Date.now;
  const decisions = new Map<string, ApprovalDecision>();
  const requests = new Map<string, PendingApproval>();
  let counter = 0;
  const nextId = (): string => `apv-${String(++counter)}`;

  return {
    lookup(actionHash) {
      const decision = decisions.get(actionHash);
      if (decision === undefined) return undefined;
      // An expired grant is not a grant. An expired *denial* still stands:
      // letting a refusal lapse into permission would be the wrong direction
      // to fail in.
      if (decision.granted && decision.expiresAt !== undefined && now() >= decision.expiresAt) {
        return undefined;
      }
      return decision;
    },
    request(req) {
      // Keep the first ask: its timestamp is when the decision was first
      // needed, which is what a reviewer wants to see.
      if (!requests.has(req.actionHash)) requests.set(req.actionHash, req);
    },
    pending() {
      return [...requests.values()].filter((req) => this.lookup(req.actionHash) === undefined);
    },
    grant(actionHash, grantOpts = {}) {
      const decision: ApprovalDecision = {
        approvalId: grantOpts.approvalId ?? nextId(),
        granted: true,
        ...(grantOpts.ttlMs !== undefined ? { expiresAt: now() + grantOpts.ttlMs } : {}),
      };
      decisions.set(actionHash, decision);
      return decision;
    },
    deny(actionHash, denyOpts = {}) {
      const decision: ApprovalDecision = { approvalId: denyOpts.approvalId ?? nextId(), granted: false };
      decisions.set(actionHash, decision);
      return decision;
    },
    revoke(actionHash) {
      decisions.delete(actionHash);
    },
  };
}
