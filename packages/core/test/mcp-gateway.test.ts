import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { openDb, closeDb, type Db } from '../src/db/client.js';
import { verifyChain, type VerifiableRecord } from '../src/chain/verify.js';
import { payloadHash } from '../src/receipt/hash.js';
import { registerAgent, keyDirectory } from '../src/agents/store.js';
import { generateKeypair, deriveAgentId, publicKeyToJwk, type Keypair } from '../src/crypto/keys.js';
import { createMcpGateway, type McpGatewayOptions } from '../src/gateway/mcp-gateway.js';
import type { Receipt } from '../src/receipt/schema.js';

/**
 * The gateway recorder: an MCP proxy that records a tool call from outside the
 * agent's process.
 *
 * The difference from src/adapters/mcp.ts is the whole point of it. That wrapper
 * runs inside the agent and signs with a key the agent holds, so a receipt says
 * what the agent reported about itself. This one sits on the wire between the
 * agent and the MCP server, holds the signing key in its own process, and writes
 * issuer_kind 'gateway' -- the value docs/adr/0004 reserved for "an intermediary
 * that saw the call on the wire" and which, until now, nothing produced.
 *
 * Two properties below are not cosmetic:
 *
 *  - Bytes are forwarded unchanged. A proxy that re-serialises JSON is a proxy
 *    that can silently alter what the server receives, which would make the
 *    receipt a record of something the agent did not send.
 *  - abandon() exists because a recorder outside the agent can still report a
 *    call that was issued and never came back. An in-agent recorder dies with
 *    the agent and writes nothing at all.
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
    runId: 'run-gw-1',
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

/** Every byte the store holds, for plain-text leak checks. */
function storedText(): string {
  return JSON.stringify(db.$client.prepare('SELECT * FROM receipts').all());
}

const call = (id: unknown, name: string, args?: Record<string, unknown>) =>
  JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, ...(args ? { arguments: args } : {}) } });

const ok = (id: unknown, text: string) =>
  JSON.stringify({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } });

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

describe('the gateway records from outside the agent', () => {
  it('writes one receipt per tools/call, as gateway and observed', () => {
    const gw = gateway();
    gw.fromAgent(call(1, 'read_file', { path: '/tmp/a.txt' }));
    gw.fromServer(ok(1, 'contents'));

    const receipts = storedReceipts();
    expect(receipts).toHaveLength(1);
    expect(receipts[0]!.lacre.issuer_kind).toBe('gateway');
    expect(receipts[0]!.lacre.provenance_class).toBe('observed');
    expect(receipts[0]!.lacre.action).toBe('mcp.read_file');
    expect(receipts[0]!.outcome).toBe('success');
    expect(receipts[0]!.action_type).toBe('tool_call');
  });

  /** The value that distinguishes it from the in-agent wrapper. */
  it('never claims to be the agent', () => {
    const gw = gateway();
    gw.fromAgent(call(1, 'read_file'));
    gw.fromServer(ok(1, 'x'));
    expect(storedReceipts()[0]!.lacre.issuer_kind).not.toBe('sdk');
  });

  it('chains, and the chain verifies', () => {
    const gw = gateway();
    for (const n of [1, 2, 3]) {
      gw.fromAgent(call(n, `tool_${n}`));
      gw.fromServer(ok(n, 'done'));
    }
    expect(storedReceipts()).toHaveLength(3);
    const verdict = verifyChain(readChain(), keyDirectory(db));
    expect(verdict.ok).toBe(true);
  });
});

describe('it forwards what it was given, byte for byte', () => {
  /**
   * Re-serialising would let the proxy alter what the server receives while the
   * receipt claims otherwise. Key order and spacing are preserved deliberately.
   */
  it('returns the original line, not a re-encoding of it', () => {
    const gw = gateway();
    const line = '{"jsonrpc":"2.0",  "id":7,"method":"tools/call","params":{"name":"b","arguments":{"z":1,"a":2}}}';
    expect(gw.fromAgent(line)).toBe(line);
    const response = '{"jsonrpc":"2.0", "id":7,  "result":{"content":[]}}';
    expect(gw.fromServer(response)).toBe(response);
  });

  it('passes traffic that is not a tool call straight through, recording nothing', () => {
    const gw = gateway();
    const listing = JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list' });
    expect(gw.fromAgent(listing)).toBe(listing);
    gw.fromServer(JSON.stringify({ jsonrpc: '2.0', id: 9, result: { tools: [] } }));
    expect(storedReceipts()).toHaveLength(0);
  });

  it('passes notifications through, recording nothing', () => {
    const gw = gateway();
    const note = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(gw.fromAgent(note)).toBe(note);
    expect(storedReceipts()).toHaveLength(0);
  });

  it('passes a line that is not JSON through, and does not throw', () => {
    const gw = gateway();
    expect(() => gw.fromAgent('not json at all')).not.toThrow();
    expect(gw.fromAgent('not json at all')).toBe('not json at all');
    expect(gw.fromServer('')).toBe('');
    expect(storedReceipts()).toHaveLength(0);
  });

  it('ignores a response whose id it never saw', () => {
    const gw = gateway();
    gw.fromServer(ok(404, 'orphan'));
    expect(storedReceipts()).toHaveLength(0);
  });

  it('matches ids by type as well as value, so 1 and "1" are different calls', () => {
    const gw = gateway();
    gw.fromAgent(call(1, 'numeric'));
    gw.fromAgent(call('1', 'stringy'));
    gw.fromServer(ok('1', 'done'));
    const receipts = storedReceipts();
    expect(receipts).toHaveLength(1);
    expect(receipts[0]!.lacre.action).toBe('mcp.stringy');
    expect(gw.pendingCount()).toBe(1);
  });
});

describe('it records how the call ended', () => {
  it('records a JSON-RPC error as a failure', () => {
    const gw = gateway();
    gw.fromAgent(call(1, 'boom'));
    gw.fromServer(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'exploded' } }));
    expect(storedReceipts()[0]!.outcome).toBe('failure');
  });

  /** MCP reports tool-level errors in-band, the same way the client wrapper sees them. */
  it('records an in-band isError result as a failure', () => {
    const gw = gateway();
    gw.fromAgent(call(1, 'soft_fail'));
    gw.fromServer(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [], isError: true } }));
    expect(storedReceipts()[0]!.outcome).toBe('failure');
  });

  /**
   * The case an in-agent recorder cannot cover: the agent issued a call and
   * nothing came back. A wrapper inside a process that dies writes nothing.
   */
  it('reports calls still in flight when the server goes away', () => {
    const gw = gateway();
    gw.fromAgent(call(1, 'slow_one'));
    gw.fromAgent(call(2, 'slow_two'));
    expect(gw.pendingCount()).toBe(2);

    expect(gw.abandon('timeout')).toBe(2);

    const receipts = storedReceipts();
    expect(receipts).toHaveLength(2);
    expect(receipts.map((r) => r.outcome)).toEqual(['timeout', 'timeout']);
    expect(gw.pendingCount()).toBe(0);
  });

  it('does not record the same call twice', () => {
    const gw = gateway();
    gw.fromAgent(call(1, 'once'));
    gw.fromServer(ok(1, 'first'));
    gw.fromServer(ok(1, 'again'));
    expect(storedReceipts()).toHaveLength(1);
  });
});

describe('it keeps the agent away from the arguments and the key', () => {
  it('hashes arguments rather than storing them, by default', () => {
    const gw = gateway();
    const args = { token: 'super-secret-value', path: '/tmp/a.txt' };
    gw.fromAgent(call(1, 'read_file', args));
    gw.fromServer(ok(1, 'contents'));

    expect(storedText()).not.toContain('super-secret-value');
    expect(storedReceipts()[0]!.input_hash).toBe(payloadHash(args));
  });

  it('stores them only when asked', () => {
    const gw = gateway({ storeArgs: true });
    gw.fromAgent(call(1, 'read_file', { path: '/tmp/a.txt' }));
    gw.fromServer(ok(1, 'contents'));
    expect(storedReceipts()[0]!.action_detail).toMatchObject({ arguments: { path: '/tmp/a.txt' } });
  });

  it('treats a tool with no declared class as a write, never as safe', () => {
    const gw = gateway();
    gw.fromAgent(call(1, 'unknown_tool'));
    gw.fromServer(ok(1, 'done'));
    expect(storedReceipts()[0]!.lacre.side_effect_class).toBe('write');
  });

  it('honours a per-tool class map', () => {
    const gw = gateway({ sideEffectClass: { read_file: 'read' } });
    gw.fromAgent(call(1, 'read_file'));
    gw.fromServer(ok(1, 'x'));
    gw.fromAgent(call(2, 'delete_everything'));
    gw.fromServer(ok(2, 'x'));
    const receipts = storedReceipts();
    expect(receipts[0]!.lacre.side_effect_class).toBe('read');
    expect(receipts[1]!.lacre.side_effect_class).toBe('write');
  });
});
