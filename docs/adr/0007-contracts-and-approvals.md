# ADR 0007 — Contracts and approvals: the decision before the call

Status: accepted · 2026-11-24 · Supersedes nothing · Builds on
[0004](0004-tool-call-receipts.md) and [0006](0006-gateway-recorder.md)

## Context

The receipt schema has declared `contract_id`, `contract_result` and
`approval_id` since [ADR 0002](0002-receipt-shape.md). Grepping for writers
found none: the data model described a governance product that did not exist.

Recording is after the fact. The strongest published objection to hash-chained
agent logs is not about the cryptography — it is that a record never stopped
anything. A log tells an auditor what the agent did; it does not stop the agent
doing it. Every competing implementation in this space records. The decision
*before* the call is the part the market actually buys, and
[ADR 0006](0006-gateway-recorder.md) already put Lacre on the wire, which is
the only place that decision can be made and still be trustworthy.

## Decision

The MCP gateway evaluates a **contract set** before forwarding a call. A
contract matches on tool name, side-effect class and argument predicates, and
carries one of three effects: `allow`, `deny`, `require_approval`.

### The most restrictive matching contract wins

Not the first match. With first-match-wins, an `allow` written above a `deny`
silently disables it — the classic firewall footgun. Severity ordering is
`deny` > `require_approval` > `allow`, and ties break by declaration order so
the winning rule is still predictable. Rule order cannot weaken a refusal.

### Fail-closed by default

A contract whose predicates cannot be evaluated — an invalid regex, an operator
this build does not recognise — is a **deny** unless the operator writes
`onError: 'fail_open'`. A gate that fails open is not a gate. The escape hatch
exists because a bug that stops real work is a real cost, but it has to be
chosen deliberately and it is visible in the configuration.

`errored` is reported on every verdict, so an operator can alert on rules that
are quietly not working rather than discovering it during an incident.

### Predicates are data, not functions

A contract is a plain object, so a contract set can later come from a file or a
table without this module changing. That is also why an unknown operator is an
error rather than a non-match: configuration written by a newer build must not
degrade into an allow on an older one.

### Dry run forwards everything

`dryRun: true` evaluates the rules, records the verdict it *would* have
reached, and forwards the call regardless. The receipt then carries
`contract_result: 'rejected'` beside `outcome: 'success'`, with
`action_detail.contract.dry_run: true` so the two can never be confused. A rule
can be proven against real traffic before it is allowed to break anything.
`dry_run` is written only when it is true, so its absence on an older receipt
cannot be read as a claim that the gate was live.

### An approval is bound to one action, not one tool

The approval key is `SHA-256` over the RFC 8785 canonicalization of
`{ tool, arguments }` — the same function the receipt uses for `input_hash`.
Approving `delete_file` on `/tmp/scratch` does not authorise `delete_file` on
`/`. Argument key order does not matter; any value difference does.

### "Hold" means refused now, retriable once answered

The gateway sits on a synchronous line-in/line-out wire. It does not park a
request and resume it. A `require_approval` contract with no recorded answer
refuses the call with a retriable JSON-RPC error (`-32002`), records
`outcome: 'escalated'`, and registers the request for a person to answer. The
agent's next attempt at the identical call finds the decision and proceeds or
is refused.

This is a real limitation, not a detail: **an agent that never retries never
runs the approved call.** Parking the request would mean holding the wire open
across a human's response time, with a timeout policy, a buffered line and a
resumption path — more machinery and more ways to lose a call. Retry was chosen
because it is the behaviour MCP clients already have for transient errors.

A grant may expire; an expired grant escalates again. An expired *denial* still
stands, because letting a refusal lapse into permission is the wrong direction
to fail in.

A `require_approval` contract with no approval store configured can never be
satisfied, so it denies, and the error names the fix.

### Error codes

JSON-RPC reserves `-32000..-32099` for implementation-defined server errors.
Lacre uses `-32001` for a refusal and `-32002` for "waiting on a person" —
distinct, so an agent or a human reading a transcript can tell "never allowed"
from "not yet".

### `fromAgent` returns a directive, not a string

A gateway that can refuse has two outputs: what to forward, and what to answer
the agent. The signature changed from `string` to `{ forward, reply }` rather
than gaining a second method, so every caller had to be updated by the compiler
instead of silently forwarding a call the gate refused.

## What this does not do

- **A deny is not egress control.** It stops the call *through this proxy*. An
  agent holding its own API keys can reach the service directly, and the
  gateway will neither see it nor stop it. This belongs in the README in those
  words, because a reader who believes otherwise is worse off than one who
  never heard of it.
- **A notification is not gated.** A `tools/call` with no JSON-RPC id expects
  no response, so there is no channel on which to refuse it. It is forwarded
  unchanged and nothing is recorded.
- **The approval store that ships is in-memory.** A gateway restart forgets
  every pending request and every grant. The interface is public so a durable
  store can live with the operator's own review queue; the one in this package
  is for tests and short-lived processes.
- **Nothing here is a policy language.** There are three effects and four
  predicate operators. Anything more belongs behind the `ApprovalStore`
  interface or in a later ADR, with its own threat model.

## Consequences

`contract_id`, `contract_result` and `approval_id` are now written by something.
`lease_id` and `fencing_token` still are not — that is Phase 4, and it is the
one item on the roadmap where a bug is a correctness bug rather than a missing
feature.

A receipt written without a contract set keeps its exact pre-0007 bytes: all
three fields are omitted rather than set to null, as the absent-vs-null
invariant in `receipt/hash.ts` requires.
