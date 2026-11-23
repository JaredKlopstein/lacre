import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { runCli } from '../src/adapters/cli.js';
import { parseGatewayArgs, lineSplitter } from '../src/gateway/stdio.js';
import { openDb, closeDb } from '../src/db/client.js';
import { dbPath } from '../src/config.js';
import type { Receipt } from '../src/receipt/schema.js';

/**
 * The transport half of the gateway, and one end-to-end run of the real binary.
 *
 * The unit tests below cover the two things most likely to go quietly wrong in a
 * proxy: argument handling, and reassembling lines across chunk boundaries. The
 * end-to-end test is the one that proves the claim on the tin -- that an agent
 * can talk to an MCP server through this process, get the right answer, and
 * leave behind a signed receipt it did not write and could not have forged.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const GATEWAY_BIN = join(HERE, '..', 'bin', 'lacre-mcp-gateway.mjs');

describe('argument handling', () => {
  it('splits our options from the server command at --', () => {
    const opts = parseGatewayArgs(['--store', '/tmp/s', '--', 'my-server', '--its-flag', '--store']);
    expect(opts.store).toBe('/tmp/s');
    // Everything after -- belongs to the server, including flags that look like ours.
    expect(opts.command).toEqual(['my-server', '--its-flag', '--store']);
    expect(opts.error).toBeUndefined();
  });

  it('rejects an unknown option rather than ignoring it', () => {
    // The CLI's rule, for the CLI's reason: a mistyped flag must not silently
    // change what gets recorded.
    expect(parseGatewayArgs(['--stroe', '/tmp/s', '--', 'x']).error).toMatch(/Unknown option/);
  });

  it('rejects an option whose value is missing', () => {
    expect(parseGatewayArgs(['--store', '--session', 'abc', '--', 'x']).error).toMatch(/--store needs a value/);
  });

  it('records no command when there is no --', () => {
    expect(parseGatewayArgs(['--help']).command).toEqual([]);
    expect(parseGatewayArgs(['--help']).help).toBe(true);
  });

  it('defaults to hashing arguments, not storing them', () => {
    expect(parseGatewayArgs(['--', 'x']).storeArgs).toBe(false);
    expect(parseGatewayArgs(['--store-args', '--', 'x']).storeArgs).toBe(true);
  });
});

describe('line reassembly', () => {
  const collect = () => {
    const written: string[] = [];
    return { written, write: (text: string) => void written.push(text) };
  };

  it('joins a line split across chunks', () => {
    const out = collect();
    const split = lineSplitter((line) => line, out.write);
    split.push('{"a":');
    split.push('1}\n');
    expect(out.written).toEqual(['{"a":1}\n']);
  });

  it('emits several lines arriving in one chunk, in order', () => {
    const out = collect();
    const split = lineSplitter((line) => line, out.write);
    split.push('one\ntwo\nthree\n');
    expect(out.written).toEqual(['one\n', 'two\n', 'three\n']);
  });

  it('holds a partial line until flush, and never invents a newline', () => {
    const out = collect();
    const split = lineSplitter((line) => line, out.write);
    split.push('no newline yet');
    expect(out.written).toEqual([]);
    split.flush();
    expect(out.written).toEqual(['no newline yet']);
  });

  it('passes each line through the handler exactly once', () => {
    const seen: string[] = [];
    const out = collect();
    const split = lineSplitter((line) => {
      seen.push(line);
      return line.toUpperCase();
    }, out.write);
    split.push('a\nb\n');
    expect(seen).toEqual(['a', 'b']);
    expect(out.written).toEqual(['A\n', 'B\n']);
  });
});

/**
 * A minimal MCP server: reads newline-delimited JSON-RPC and answers tools/call.
 * It is deliberately not the real SDK -- the gateway must work with anything
 * that speaks the wire format.
 */
const FAKE_SERVER = `
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let i = buffer.indexOf('\\n');
  while (i !== -1) {
    const line = buffer.slice(0, i);
    buffer = buffer.slice(i + 1);
    if (line.trim() !== '') {
      const msg = JSON.parse(line);
      if (msg.method === 'tools/call') {
        const text = 'ran ' + msg.params.name;
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text }] } }) + '\\n');
      }
    }
    i = buffer.indexOf('\\n');
  }
});
process.stdin.on('end', () => process.exit(0));
`;

describe('end to end, through the real binary', () => {
  let store: string;

  beforeEach(async () => {
    store = mkdtempSync(join(tmpdir(), 'lacre-gw-'));
    const code = await runCli(['init', '--store', store, '--json'], { out: () => {}, err: () => {} });
    expect(code, 'lacre init failed').toBe(0);
  });

  afterEach(() => rmSync(store, { recursive: true, force: true }));

  it('proxies a tool call and records a gateway receipt the agent never wrote', async () => {
    const serverPath = join(store, 'fake-server.mjs');
    writeFileSync(serverPath, FAKE_SERVER);

    const child = spawn('node', [GATEWAY_BIN, '--store', store, '--', 'node', serverPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c: string) => {
      out += c;
    });

    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'read_file', arguments: { path: '/tmp/a.txt' } },
      })}\n`,
    );

    // Wait for the server's answer to come back through the proxy.
    await new Promise<void>((done) => {
      const started = Date.now();
      const check = setInterval(() => {
        if (out.includes('ran read_file') || Date.now() - started > 15_000) {
          clearInterval(check);
          done();
        }
      }, 25);
    });

    child.stdin.end();
    const exitCode = await new Promise<number>((done) => child.on('close', (c) => done(c ?? 0)));

    // The agent got the server's real answer, unaltered.
    expect(out).toContain('ran read_file');
    expect(exitCode).toBe(0);

    const db = openDb(dbPath(store));
    try {
      const rows = db.$client
        .prepare('SELECT canonical_json as canonical_json FROM receipts ORDER BY seq')
        .all() as { canonical_json: string }[];
      const receipts = rows.map((r) => JSON.parse(r.canonical_json) as Receipt);
      const toolCalls = receipts.filter((r) => r.action_type === 'tool_call');

      expect(toolCalls).toHaveLength(1);
      expect(toolCalls[0]!.lacre.action).toBe('mcp.read_file');
      expect(toolCalls[0]!.lacre.issuer_kind).toBe('gateway');
      expect(toolCalls[0]!.lacre.provenance_class).toBe('observed');
      expect(toolCalls[0]!.outcome).toBe('success');
      // Arguments are hashed, not stored, with no flag asking otherwise.
      expect(JSON.stringify(toolCalls[0]!.action_detail)).not.toContain('/tmp/a.txt');
      expect(toolCalls[0]!.input_hash).toBeTruthy();
    } finally {
      closeDb(db);
    }
  }, 30_000);

  it('refuses to start without a server command, and says where it goes', async () => {
    const child = spawn('node', [GATEWAY_BIN, '--store', store], { stdio: ['pipe', 'pipe', 'pipe'] });
    let err = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c: string) => {
      err += c;
    });
    const code = await new Promise<number>((done) => child.on('close', (c) => done(c ?? 0)));
    expect(code).toBe(2);
    expect(err).toContain('no server command');
  }, 15_000);
});
