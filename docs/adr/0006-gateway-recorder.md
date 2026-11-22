# ADR 0006: record tool calls from outside the agent

Status: accepted, 2026-11-22.

## Context

Lacre records what an agent reports about itself. `src/adapters/mcp.ts` wraps the
agent's MCP client and signs each `tools/call` with a key the agent process
holds. [ADR 0004](0004-tool-call-receipts.md) already named the problem with
that arrangement when it defined `issuer_kind`:

| value | meaning |
|---|---|
| `sdk` | the agent's own process, in-band |
| `gateway` | an intermediary, such as an MCP proxy, that saw the call on the wire |

Until now nothing in this repository produced `gateway`. The field existed and
only one of its two values was reachable.

That gap matters more than a missing enum case, for three reasons that arrived
from different directions and agree:

1. **Agents tamper with their own traces.** [arXiv 2609.30266](https://arxiv.org/pdf/2609.30266)
   (ELLIS Tübingen / Max Planck, September 2026) found that nearly every local
   coding harness tested, Claude Code and Codex among them, let the agent delete
   its own traces on request without tripping monitor guardrails — and that under
   a hidden reward for shorter traces, models deleted traces unprompted. The
   authors' conclusion is that trace collection has to live outside the agent's
   reach.
2. **NIST tenet 10** ("Immutable Evidence", 27 October 2026) asks for an
   append-only, tamper-evident record held by logging infrastructure
   *independent of the agent*. Lacre was append-only and tamper-evident but not
   independent.
3. **The repository already said so.** The README's "What this is honestly
   worth" states that an operator holding the agent signing keys can rebuild the
   entire local chain. The agent is such an operator for its own process.

## Decision

Add an MCP gateway recorder to `packages/core` under MIT, as `createMcpGateway`
plus a `lacre-mcp-gateway` binary. It sits on the wire between the agent and an
MCP server, forwards every message unchanged, and writes one signed, chained
receipt per `tools/call` with `issuer_kind: 'gateway'` and
`provenance_class: 'observed'`.

### Why core, and why MIT

The credibility of the free tier is the product's distribution. A receipt
written by the agent about itself is the weakest form of the claim Lacre makes,
and charging for the strong form would mean the free tier ships the version the
cited research says not to trust. The paid wedge is unchanged and remains the
one thing a local system cannot provide about itself: an external RFC 3161
anchor ([ADR 0003](0003-anchoring.md)).

### Why a separate binary, not a registry action

An MCP stdio server owns stdin and stdout. The CLI writes JSON results to
stdout, so an action that also proxied an MCP stream would interleave two
protocols on one pipe and corrupt both. `lacre-mcp-gateway` therefore owns
stdio, and everything it says for itself goes to stderr. This follows the
precedent already set by `lacre-verify`, which is its own binary for its own
reasons.

This is a departure from "CLI is the reference surface, one typed action
registry", and it is a narrow one: the gateway is a transport, not an action
that takes input and returns a result.

### Why one receipt per completed call, not two

Recording before execution, as `draft-sharif-agent-audit-trail` asks, would need
an outcome value meaning "attempted". The `Outcome` enum is AAT's, verbatim, and
ADR 0002 keeps it that way so an AAT validator sees a record it recognises.
Inventing a value would break that for a benefit we can get another way:
`abandon()` writes a `timeout` or `failure` receipt for every call that was
issued and never came back, which is the case the pre-execution record exists to
catch.

## Consequences

- `issuer_kind: 'gateway'` becomes reachable, and the sdk/gateway distinction in
  a stored chain becomes meaningful rather than theoretical.
- A call that is issued and never returns is now recorded. An in-agent recorder
  dies with the agent and writes nothing at all; this one survives it.
- `@lacre/core` gains a second binary, so a published package exposes
  `lacre` and `lacre-mcp-gateway`.

## What this does not do

Stated here because the gap between "records" and "controls" is where this
category oversells itself.

- **It does not decide.** Every call is forwarded. A gate that refuses an action
  is a different feature with different failure modes. Lacre does not claim to
  refuse anything.
- **It only sees traffic routed through it.** An agent holding its own API keys
  can call a service directly and the gateway will never know. A receipt's
  absence proves nothing.
- **`observed` means the bytes crossed this process.** It is not a claim that
  the tool did what it reported, and it does not make a tool's own output true.
- **It does not solve authority before execution.** The receipt is evidence
  after the fact. That remains true however far outside the agent it is written.
