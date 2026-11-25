import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { openDb, closeDb, type Db } from '../src/db/client.js';
import { verifyChain, type VerifiableRecord } from '../src/chain/verify.js';
import { registerAgent, keyDirectory } from '../src/agents/store.js';
import { generateKeypair, deriveAgentId, publicKeyToJwk, type Keypair } from '../src/crypto/keys.js';
import {
  createMcpGateway,
  LACRE_DENIED_CODE,
  LACRE_APPROVAL_REQUIRED_CODE,
  type McpGatewayOptions,
} from '../src/gateway/mcp-gateway.js';
import { createMemoryApprovalStore, actionHashFor } from '../src/gateway/approvals.js';
import type { Contract } from '../src/gateway/contracts.js';
import type { Receipt } from '../src/receipt/schema.js';

/**
 * The gateway as a *gate*: Phase 2 of #274.
 *
 * Phase 1 made the gateway record from outside the agent. This is the part
 * that decides. The properties that matter, each pinned below:
 *
 *  - A refused call does not reach the server. Not "is logged as refused" --
 *    does not reach it.
 *  - The refusal is recorded by the gateway's own key, in the chain, with the
 *    rule that refused it. A deny nobody can prove happened is not a control.
 *  - **The agent cannot reach the decision.** Contracts live in this process.
 *    No line the agent can write supplies, names or weakens one, and an agent
 *    that retries a refused call is refused again.
 *  - Dry run forwards everything while recording the verdict it would have
 *    reached, so a rule can be rolled out before it can break production.
 */

let db: Db;
let kp: Keypair;
let agentId: string;
const sessionId = randomUUID();

function gateway(over: Partial<McpGatewayOptions> = {}) {
  return createMcpGateway({
    db,
    agent: {
      agentId,
      agentVersion: '1.0.0',
      trustLevel: 'L1',
      keyId: kp.keyId,
      secretKey: kp.secretKey,
    },
    sessionId,
    ...over,
  });
}

function readChain(): VerifiableRecord[] {
  return db.$client
    .prepare('SELECT seq, canonical_json as canonical_json, self_hash as self_hash FROM receipts ORDER BY seq')
    .all() as VerifiableRecord[];
}

function storedReceipts(): Receipt[] {
  return readChain().map((r) => JSON.parse(r.canonical_json) as Receipt);
}

const call = (id: unknown, name: string, args?: Record<string, unknown>) =>
  JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, ...(args ? { arguments: args } : {}) } });

const ok = (id: unknown, text: string) =>
  JSON.stringify({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } });

interface RpcError {
  jsonrpc: string;
  id: unknown;
  error: { code: number; message: string; data?: { lacre?: { contract_id?: string; reason?: string } } };
}

const asError = (line: string | null): RpcError => {
  expect(line).not.toBeNull();
  return JSON.parse(line as string) as RpcError;
};

const denyWrites: Contract = {
  id: 'no-writes-in-freeze',
  effect: 'deny',
  tools: ['write_file'],
  reason: 'change freeze until the release ships',
};

beforeEach(() => {
  db = openDb(':memory:');
  kp = generateKeypair();
  agentId = deriveAgentId(kp.publicKey);
  registerAgent(db, {
    agentId,
    displayName: 'test-agent',
    publicKeyJwk: publicKeyToJwk(kp.publicKey),
    agentVersion: '1.0.0',
  });
});

afterEach(() => closeDb(db));

describe('a deny stops the call', () => {
  it('does not forward a refused call', () => {
    const gw = gateway({ contracts: { contracts: [denyWrites] } });
    const directive = gw.fromAgent(call(1, 'write_file', { path: '/etc/hosts' }));
    expect(directive.forward).toBeNull();
    expect(directive.reply).not.toBeNull();
  });

  it('answers the agent with a JSON-RPC error carrying the same id', () => {
    const gw = gateway({ contracts: { contracts: [denyWrites] } });
    const err = asError(gw.fromAgent(call(7, 'write_file')).reply);
    expect(err.id).toBe(7);
    expect(err.error.code).toBe(LACRE_DENIED_CODE);
  });

  it('preserves a string id rather than coercing it', () => {
    const gw = gateway({ contracts: { contracts: [denyWrites] } });
    const err = asError(gw.fromAgent(call('abc', 'write_file')).reply);
    expect(err.id).toBe('abc');
  });

  it('tells the agent which rule refused it and why', () => {
    const gw = gateway({ contracts: { contracts: [denyWrites] } });
    const err = asError(gw.fromAgent(call(1, 'write_file')).reply);
    expect(err.error.message).toMatch(/no-writes-in-freeze/);
    expect(err.error.message).toMatch(/change freeze/);
    expect(err.error.data?.lacre?.contract_id).toBe('no-writes-in-freeze');
  });

  it('records one receipt with outcome denied', () => {
    const gw = gateway({ contracts: { contracts: [denyWrites] } });
    gw.fromAgent(call(1, 'write_file', { path: '/etc/hosts' }));
    const receipts = storedReceipts();
    expect(receipts).toHaveLength(1);
    expect(receipts[0]!.outcome).toBe('denied');
    expect(receipts[0]!.lacre.contract_id).toBe('no-writes-in-freeze');
    expect(receipts[0]!.lacre.contract_result).toBe('rejected');
  });

  it('records the rule and reason on the receipt', () => {
    const gw = gateway({ contracts: { contracts: [denyWrites] } });
    gw.fromAgent(call(1, 'write_file'));
    const detail = storedReceipts()[0]!.action_detail as { contract?: Record<string, unknown> };
    expect(detail.contract).toMatchObject({
      id: 'no-writes-in-freeze',
      result: 'rejected',
      reason: 'change freeze until the release ships',
    });
    expect(detail.contract).not.toHaveProperty('dry_run');
  });

  it('still records as gateway and observed', () => {
    const gw = gateway({ contracts: { contracts: [denyWrites] } });
    gw.fromAgent(call(1, 'write_file'));
    expect(storedReceipts()[0]!.lacre.issuer_kind).toBe('gateway');
    expect(storedReceipts()[0]!.lacre.provenance_class).toBe('observed');
  });

  it('leaves nothing pending, because no response will come', () => {
    const gw = gateway({ contracts: { contracts: [denyWrites] } });
    gw.fromAgent(call(1, 'write_file'));
    expect(gw.pendingCount()).toBe(0);
    expect(gw.abandon('timeout')).toBe(0);
  });

  it('keeps the chain verifiable', () => {
    const gw = gateway({ contracts: { contracts: [denyWrites] } });
    gw.fromAgent(call(1, 'write_file'));
    gw.fromAgent(call(2, 'read_file'));
    gw.fromServer(ok(2, 'contents'));
    expect(storedReceipts()).toHaveLength(2);
    expect(verifyChain(readChain(), keyDirectory(db)).ok).toBe(true);
  });

  it('does not forward even when the agent repeats the call under a new id', () => {
    const gw = gateway({ contracts: { contracts: [denyWrites] } });
    for (const id of [1, 2, 3]) {
      expect(gw.fromAgent(call(id, 'write_file')).forward).toBeNull();
    }
    expect(storedReceipts()).toHaveLength(3);
    expect(storedReceipts().every((r) => r.outcome === 'denied')).toBe(true);
  });

  it('allows a tool the contract does not name', () => {
    const gw = gateway({ contracts: { contracts: [denyWrites] } });
    const line = call(1, 'read_file');
    expect(gw.fromAgent(line).forward).toBe(line);
  });
});

describe('what lands on the receipt', () => {
  it('writes no contract fields at all when no contract set is configured', () => {
    const gw = gateway();
    gw.fromAgent(call(1, 'read_file'));
    gw.fromServer(ok(1, 'x'));
    const lacre = storedReceipts()[0]!.lacre;
    expect(lacre).not.toHaveProperty('contract_id');
    expect(lacre).not.toHaveProperty('contract_result');
    expect(lacre).not.toHaveProperty('approval_id');
    expect(storedReceipts()[0]!.action_detail).not.toHaveProperty('contract');
  });

  it('records not_applicable when contracts are in use but none matched', () => {
    const gw = gateway({ contracts: { contracts: [denyWrites] } });
    gw.fromAgent(call(1, 'read_file'));
    gw.fromServer(ok(1, 'x'));
    const lacre = storedReceipts()[0]!.lacre;
    expect(lacre.contract_result).toBe('not_applicable');
    expect(lacre).not.toHaveProperty('contract_id');
  });

  it('records passed and the rule id for an explicit allow', () => {
    const gw = gateway({
      contracts: { contracts: [{ id: 'reads-are-fine', effect: 'allow', tools: ['read_file'] }] },
    });
    gw.fromAgent(call(1, 'read_file'));
    gw.fromServer(ok(1, 'x'));
    const lacre = storedReceipts()[0]!.lacre;
    expect(lacre.contract_result).toBe('passed');
    expect(lacre.contract_id).toBe('reads-are-fine');
  });

  it('carries the decision onto the receipt written when the response arrives', () => {
    const gw = gateway({
      contracts: { contracts: [{ id: 'watch-reads', effect: 'allow', tools: ['read_file'] }] },
    });
    gw.fromAgent(call(1, 'read_file'));
    expect(storedReceipts()).toHaveLength(0);
    gw.fromServer(ok(1, 'x'));
    expect(storedReceipts()[0]!.lacre.contract_id).toBe('watch-reads');
    expect(storedReceipts()[0]!.outcome).toBe('success');
  });

  it('carries the decision onto an abandoned call', () => {
    const gw = gateway({
      contracts: { contracts: [{ id: 'watch-reads', effect: 'allow', tools: ['read_file'] }] },
    });
    gw.fromAgent(call(1, 'read_file'));
    expect(gw.abandon('timeout')).toBe(1);
    expect(storedReceipts()[0]!.lacre.contract_id).toBe('watch-reads');
    expect(storedReceipts()[0]!.outcome).toBe('timeout');
  });

  it('matches on side-effect class, not just tool name', () => {
    const gw = gateway({
      sideEffectClass: { drop_table: 'irreversible', read_file: 'read' },
      contracts: {
        contracts: [{ id: 'no-irreversible', effect: 'deny', sideEffectClasses: ['irreversible'] }],
      },
    });
    expect(gw.fromAgent(call(1, 'drop_table')).forward).toBeNull();
    const line = call(2, 'read_file');
    expect(gw.fromAgent(line).forward).toBe(line);
  });

  it('matches on argument predicates', () => {
    const gw = gateway({
      contracts: {
        contracts: [
          {
            id: 'no-etc',
            effect: 'deny',
            tools: ['write_file'],
            where: [{ path: 'path', op: 'matches', pattern: '^/etc/' }],
          },
        ],
      },
    });
    expect(gw.fromAgent(call(1, 'write_file', { path: '/etc/passwd' })).forward).toBeNull();
    const allowed = call(2, 'write_file', { path: '/tmp/safe' });
    expect(gw.fromAgent(allowed).forward).toBe(allowed);
  });
});

describe('dry run', () => {
  const dry = { contracts: [denyWrites], dryRun: true };

  it('forwards the call it would have refused', () => {
    const gw = gateway({ contracts: dry });
    const line = call(1, 'write_file', { path: '/etc/hosts' });
    const directive = gw.fromAgent(line);
    expect(directive.forward).toBe(line);
    expect(directive.reply).toBeNull();
  });

  it('records the verdict it would have reached, against the real outcome', () => {
    const gw = gateway({ contracts: dry });
    gw.fromAgent(call(1, 'write_file'));
    gw.fromServer(ok(1, 'written'));
    const receipt = storedReceipts()[0]!;
    // The call ran, so the outcome is what happened...
    expect(receipt.outcome).toBe('success');
    // ...and the contract result is what would have happened.
    expect(receipt.lacre.contract_result).toBe('rejected');
    expect(receipt.lacre.contract_id).toBe('no-writes-in-freeze');
  });

  it('marks the receipt so a dry run is not mistaken for a live gate', () => {
    const gw = gateway({ contracts: dry });
    gw.fromAgent(call(1, 'write_file'));
    gw.fromServer(ok(1, 'written'));
    const detail = storedReceipts()[0]!.action_detail as { contract?: { dry_run?: boolean } };
    expect(detail.contract?.dry_run).toBe(true);
  });
});

describe('approvals', () => {
  const needsApproval: Contract = {
    id: 'humans-approve-deletes',
    effect: 'require_approval',
    tools: ['delete_file'],
    reason: 'a delete needs a person',
  };

  it('escalates when nobody has answered', () => {
    const approvals = createMemoryApprovalStore();
    const gw = gateway({ contracts: { contracts: [needsApproval] }, approvals });
    const directive = gw.fromAgent(call(1, 'delete_file', { path: '/tmp/a' }));
    expect(directive.forward).toBeNull();
    const err = asError(directive.reply);
    expect(err.error.code).toBe(LACRE_APPROVAL_REQUIRED_CODE);
    expect(storedReceipts()[0]!.outcome).toBe('escalated');
  });

  it('registers the request so a person has something to answer', () => {
    const approvals = createMemoryApprovalStore();
    const gw = gateway({ contracts: { contracts: [needsApproval] }, approvals });
    gw.fromAgent(call(1, 'delete_file', { path: '/tmp/a' }));
    const pending = approvals.pending();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.tool).toBe('delete_file');
    expect(pending[0]!.contractId).toBe('humans-approve-deletes');
  });

  it('tells the agent to retry the identical call', () => {
    const approvals = createMemoryApprovalStore();
    const gw = gateway({ contracts: { contracts: [needsApproval] }, approvals });
    const err = asError(gw.fromAgent(call(1, 'delete_file')).reply);
    expect(err.error.message).toMatch(/retry the identical call/i);
  });

  it('forwards once the request is granted, and records the approval id', () => {
    const approvals = createMemoryApprovalStore();
    const gw = gateway({ contracts: { contracts: [needsApproval] }, approvals });
    const args = { path: '/tmp/a' };
    gw.fromAgent(call(1, 'delete_file', args));
    const granted = approvals.grant(actionHashFor('delete_file', args));

    const retry = call(2, 'delete_file', args);
    expect(gw.fromAgent(retry).forward).toBe(retry);
    gw.fromServer(ok(2, 'deleted'));

    const latest = storedReceipts()[1]!;
    expect(latest.outcome).toBe('success');
    expect(latest.lacre.contract_result).toBe('passed');
    expect(latest.lacre.approval_id).toBe(granted.approvalId);
  });

  it('binds the approval to those exact arguments', () => {
    const approvals = createMemoryApprovalStore();
    const gw = gateway({ contracts: { contracts: [needsApproval] }, approvals });
    approvals.grant(actionHashFor('delete_file', { path: '/tmp/scratch' }));

    // The approved one goes through.
    const approved = call(1, 'delete_file', { path: '/tmp/scratch' });
    expect(gw.fromAgent(approved).forward).toBe(approved);
    // A different path is a different action, and was never approved.
    expect(gw.fromAgent(call(2, 'delete_file', { path: '/' })).forward).toBeNull();
  });

  it('ignores argument key order, because the hash is canonical', () => {
    const approvals = createMemoryApprovalStore();
    const gw = gateway({ contracts: { contracts: [needsApproval] }, approvals });
    approvals.grant(actionHashFor('delete_file', { a: 1, b: 2 }));
    const reordered = call(1, 'delete_file', { b: 2, a: 1 });
    expect(gw.fromAgent(reordered).forward).toBe(reordered);
  });

  it('refuses when a person said no, and records that as denied', () => {
    const approvals = createMemoryApprovalStore();
    const gw = gateway({ contracts: { contracts: [needsApproval] }, approvals });
    const args = { path: '/tmp/a' };
    const refused = approvals.deny(actionHashFor('delete_file', args));

    const directive = gw.fromAgent(call(1, 'delete_file', args));
    expect(directive.forward).toBeNull();
    expect(asError(directive.reply).error.code).toBe(LACRE_DENIED_CODE);
    const receipt = storedReceipts()[0]!;
    expect(receipt.outcome).toBe('denied');
    expect(receipt.lacre.contract_result).toBe('rejected');
    expect(receipt.lacre.approval_id).toBe(refused.approvalId);
  });

  it('escalates again once a grant has expired', () => {
    let clock = 1_000;
    const approvals = createMemoryApprovalStore({ now: () => clock });
    const gw = gateway({ contracts: { contracts: [needsApproval] }, approvals, now: () => clock });
    const args = { path: '/tmp/a' };
    approvals.grant(actionHashFor('delete_file', args), { ttlMs: 500 });

    const inTime = call(1, 'delete_file', args);
    expect(gw.fromAgent(inTime).forward).toBe(inTime);

    clock += 500;
    expect(gw.fromAgent(call(2, 'delete_file', args)).forward).toBeNull();
    expect(storedReceipts().at(-1)!.outcome).toBe('escalated');
  });

  it('does not let a refusal lapse into permission', () => {
    let clock = 1_000;
    const approvals = createMemoryApprovalStore({ now: () => clock });
    const gw = gateway({ contracts: { contracts: [needsApproval] }, approvals, now: () => clock });
    const args = { path: '/tmp/a' };
    approvals.deny(actionHashFor('delete_file', args));
    clock += 10_000_000;
    expect(gw.fromAgent(call(1, 'delete_file', args)).forward).toBeNull();
    expect(storedReceipts().at(-1)!.outcome).toBe('denied');
  });

  it('refuses, and names the fix, when the contract needs approval and no store is configured', () => {
    const gw = gateway({ contracts: { contracts: [needsApproval] } });
    const directive = gw.fromAgent(call(1, 'delete_file'));
    expect(directive.forward).toBeNull();
    const err = asError(directive.reply);
    expect(err.error.code).toBe(LACRE_DENIED_CODE);
    expect(err.error.message).toMatch(/no approval store/i);
    expect(err.error.message).toMatch(/approvals/);
    expect(storedReceipts()[0]!.outcome).toBe('denied');
  });
});

describe('the agent cannot reach the decision', () => {
  it('ignores contract-shaped fields the agent puts in its params', () => {
    const gw = gateway({ contracts: { contracts: [denyWrites] } });
    const forged = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'write_file',
        arguments: { path: '/etc/hosts' },
        // All of this is noise. The decision comes from this process.
        contracts: [],
        contract_id: 'allow-everything',
        contract_result: 'passed',
        approval_id: 'apv-forged',
        lacre: { contract_result: 'passed' },
      },
    });
    expect(gw.fromAgent(forged).forward).toBeNull();
    const receipt = storedReceipts()[0]!;
    expect(receipt.outcome).toBe('denied');
    expect(receipt.lacre.contract_id).toBe('no-writes-in-freeze');
    expect(receipt.lacre).not.toHaveProperty('approval_id');
  });

  it('does not accept an approval the agent asserts over the wire', () => {
    const approvals = createMemoryApprovalStore();
    const gw = gateway({
      contracts: {
        contracts: [{ id: 'needs-human', effect: 'require_approval', tools: ['delete_file'] }],
      },
      approvals,
    });
    const forged = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'delete_file', arguments: { path: '/' }, approved: true, approval_id: 'apv-1' },
    });
    expect(gw.fromAgent(forged).forward).toBeNull();
    expect(storedReceipts()[0]!.outcome).toBe('escalated');
  });

  it('cannot be made to forward by sending a response line from the agent side', () => {
    const gw = gateway({ contracts: { contracts: [denyWrites] } });
    // A result travelling the wrong way: the agent writing what a server writes.
    expect(gw.fromAgent(ok(1, 'pretend this already happened')).forward).not.toBeNull();
    expect(storedReceipts()).toHaveLength(0);
    // And the real call is still refused.
    expect(gw.fromAgent(call(1, 'write_file')).forward).toBeNull();
  });

  it('signs every refusal with the gateway key, so a deny is provable', () => {
    const gw = gateway({ contracts: { contracts: [denyWrites] } });
    gw.fromAgent(call(1, 'write_file'));
    const receipt = storedReceipts()[0]!;
    expect(receipt.lacre.key_id).toBe(kp.keyId);
    expect(verifyChain(readChain(), keyDirectory(db)).ok).toBe(true);
  });

  it('gates a notification not at all, and records nothing for it', () => {
    // No id means no reply channel: there is nothing to refuse on and no
    // outcome to record. Forwarding it unchanged is the only honest option,
    // and the README says so rather than implying a gate that is not there.
    const gw = gateway({ contracts: { contracts: [denyWrites] } });
    const note = JSON.stringify({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'write_file' } });
    expect(gw.fromAgent(note).forward).toBe(note);
    expect(storedReceipts()).toHaveLength(0);
  });

  it('fails closed on a contract set it cannot evaluate', () => {
    const gw = gateway({
      contracts: {
        contracts: [
          { id: 'broken', effect: 'allow', tools: ['write_file'], where: [{ path: 'p', op: 'matches', pattern: '([' }] },
        ],
      },
    });
    expect(gw.fromAgent(call(1, 'write_file')).forward).toBeNull();
    expect(storedReceipts()[0]!.outcome).toBe('denied');
    expect(storedReceipts()[0]!.lacre.contract_id).toBe('broken');
  });

  it('forwards under fail_open when a contract cannot be evaluated', () => {
    const gw = gateway({
      contracts: {
        onError: 'fail_open',
        contracts: [
          { id: 'broken', effect: 'allow', tools: ['write_file'], where: [{ path: 'p', op: 'matches', pattern: '([' }] },
        ],
      },
    });
    const line = call(1, 'write_file');
    expect(gw.fromAgent(line).forward).toBe(line);
  });
});
