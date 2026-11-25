/**
 * The stdio transport for the MCP gateway recorder.
 *
 * It is a separate binary, `lacre-mcp-gateway`, and not an action in the
 * registry, for one reason: an MCP stdio server owns stdin and stdout. The CLI
 * writes JSON results to stdout, so an action that also proxied an MCP stream
 * would interleave two protocols on one pipe and corrupt both. Everything this
 * process says for itself therefore goes to **stderr**, and stdout carries the
 * downstream server's bytes and nothing else.
 *
 * Put it in front of an MCP server by changing the command the agent launches:
 *
 *   "command": "lacre-mcp-gateway",
 *   "args": ["--", "the-real-server", "--its", "--flags"]
 *
 * The agent then speaks to this process, this process speaks to the real
 * server, and the signing key stays here -- in a process the agent does not
 * control and cannot read.
 */
import { spawn } from 'node:child_process';
import { openDb, closeDb } from '../db/client.js';
import { dbPath, resolveStoreDir } from '../config.js';
import { loadKeypair } from '../actions/identity.js';
import { requireAgent } from '../agents/store.js';
import { deriveAgentId } from '../crypto/keys.js';
import { createMcpGateway, type McpGateway } from './mcp-gateway.js';
import type { SideEffectClass, TrustLevel } from '../receipt/schema.js';

const USAGE = `lacre-mcp-gateway: record MCP tool calls from outside the agent

  lacre-mcp-gateway [options] -- <server-command> [server-args...]

Options:
  --store <dir>      Lacre store to write receipts to (default: the usual resolution)
  --session <id>     Session id for the receipts (default: a new uuid)
  --run <id>         Run id for the receipts
  --store-args       Store plain tool arguments. Off by default; only the hash is kept.
  --help             This text

Everything after -- is the MCP server to run. This process speaks MCP to the
agent on stdin/stdout and forwards it unchanged; its own messages go to stderr.

What it records: one signed, chained receipt per tools/call, with issuer_kind
'gateway' and provenance_class 'observed'. It does not decide, block or alter
anything, and it only sees traffic routed through it.
`;

export interface GatewayCliOptions {
  store?: string;
  session?: string;
  run?: string;
  storeArgs: boolean;
  command: string[];
  help: boolean;
  /** Set when the arguments could not be read; the message is for stderr. */
  error?: string;
}

/** Split argv at the first `--`: ours before, the server's after. */
export function parseGatewayArgs(argv: string[]): GatewayCliOptions {
  const out: GatewayCliOptions = { storeArgs: false, command: [], help: false };
  const split = argv.indexOf('--');
  const ours = split === -1 ? argv : argv.slice(0, split);
  out.command = split === -1 ? [] : argv.slice(split + 1);

  for (let i = 0; i < ours.length; i += 1) {
    const arg = ours[i]!;
    const needsValue = (name: string): string | undefined => {
      const value = ours[i + 1];
      if (value === undefined || value.startsWith('--')) {
        out.error = `${name} needs a value.`;
        return undefined;
      }
      i += 1;
      return value;
    };
    if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg === '--store-args') out.storeArgs = true;
    else if (arg === '--store') out.store = needsValue('--store');
    else if (arg === '--session') out.session = needsValue('--session');
    else if (arg === '--run') out.run = needsValue('--run');
    // An unknown option is rejected, not ignored: the same rule the CLI applies,
    // for the same reason -- a mistyped flag must not silently change what is recorded.
    else out.error ??= `Unknown option '${arg}'. Run with --help.`;
  }
  return out;
}

/**
 * Feed a stream of chunks to a handler one complete line at a time, forwarding
 * what the handler returns. MCP stdio is newline-delimited JSON, and a chunk
 * boundary can fall anywhere, so a partial line is held until the rest arrives.
 */
/**
 * Split a byte stream into lines and hand each to `onLine`.
 *
 * `onLine` may return null, which writes nothing: that is how a refused call
 * is dropped instead of being forwarded. Anything it returns is written
 * verbatim, so an allowed line reaches the other side byte for byte.
 */
export function lineSplitter(onLine: (line: string) => string | null, write: (text: string) => void) {
  let buffer = '';
  return {
    push(chunk: string): void {
      buffer += chunk;
      let index = buffer.indexOf('\n');
      while (index !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        const out = onLine(line);
        if (out !== null) write(`${out}\n`);
        index = buffer.indexOf('\n');
      }
    },
    /** Anything left without a trailing newline, at end of stream. */
    flush(): void {
      if (buffer !== '') {
        const out = onLine(buffer);
        if (out !== null) write(out);
        buffer = '';
      }
    },
  };
}

export interface GatewayRuntime {
  gateway: McpGateway;
  close(): void;
  agentId: string;
}

/** Open the store, load the key that will sign, and build the recorder. */
export function openGateway(opts: {
  store?: string;
  session?: string;
  run?: string;
  storeArgs?: boolean;
  sideEffectClass?: SideEffectClass | Record<string, SideEffectClass>;
}): GatewayRuntime {
  const storeDir = resolveStoreDir(opts.store);
  const keypair = loadKeypair(storeDir);
  const agentId = deriveAgentId(keypair.publicKey);
  const db = openDb(dbPath(storeDir));
  const agent = requireAgent(db, agentId);

  const gateway = createMcpGateway({
    db,
    agent: {
      agentId,
      agentVersion: agent.agentVersion,
      trustLevel: agent.trustLevel as TrustLevel,
      keyId: keypair.keyId,
      secretKey: keypair.secretKey,
    },
    sessionId: opts.session ?? crypto.randomUUID(),
    runId: opts.run,
    storeArgs: opts.storeArgs,
    sideEffectClass: opts.sideEffectClass,
  });

  return { gateway, agentId, close: () => closeDb(db) };
}

export async function runMcpGatewayCli(argv: string[]): Promise<number> {
  const opts = parseGatewayArgs(argv);
  if (opts.help) {
    process.stderr.write(USAGE);
    return 0;
  }
  if (opts.error !== undefined) {
    process.stderr.write(`lacre-mcp-gateway: ${opts.error}\n`);
    return 2;
  }
  if (opts.command.length === 0) {
    process.stderr.write('lacre-mcp-gateway: no server command. Put it after --, e.g.\n\n  lacre-mcp-gateway -- my-server --flag\n');
    return 2;
  }

  let runtime: GatewayRuntime;
  try {
    runtime = openGateway(opts);
  } catch (err) {
    process.stderr.write(`lacre-mcp-gateway: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  const { gateway, close } = runtime;
  const child = spawn(opts.command[0]!, opts.command.slice(1), { stdio: ['pipe', 'pipe', 'inherit'] });

  const toServer = lineSplitter(
    (line) => {
      const directive = gateway.fromAgent(line);
      // A refusal is written to stdout, the agent's own channel, before the
      // line is dropped -- so the agent gets an answer rather than a call that
      // silently never returns.
      if (directive.reply !== null) process.stdout.write(`${directive.reply}\n`);
      return directive.forward;
    },
    (text) => void child.stdin.write(text),
  );
  const toAgent = lineSplitter(
    (line) => gateway.fromServer(line),
    (text) => void process.stdout.write(text),
  );

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => toServer.push(chunk));
  process.stdin.on('end', () => {
    toServer.flush();
    child.stdin.end();
  });

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => toAgent.push(chunk));

  return await new Promise<number>((resolveExit) => {
    const finish = (code: number) => {
      toAgent.flush();
      // Anything still in flight ended when the server did. Recording it is the
      // point of being outside the agent: a call that was issued and never came
      // back is exactly what an in-agent recorder loses.
      const abandoned = gateway.abandon('failure');
      if (abandoned > 0) {
        process.stderr.write(`lacre-mcp-gateway: recorded ${abandoned} call(s) that never returned\n`);
      }
      close();
      resolveExit(code);
    };
    child.on('error', (err) => {
      process.stderr.write(`lacre-mcp-gateway: could not run '${opts.command[0]}': ${err.message}\n`);
      finish(1);
    });
    child.on('close', (code) => finish(code ?? 0));
  });
}
