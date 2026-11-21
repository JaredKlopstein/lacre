# Lacre receipts and the November 2026 agent-audit drafts

A gap note for #221. It is **not** a format change and **not** a conformance
claim. It extends [agent-audit-drafts-2026-10.md](agent-audit-drafts-2026-10.md)
(written for #41, checked 2026-10-22) to the drafts and guidance that moved
since, and answers the only question that matters for this pass: which of this
Lacre already satisfies, which it deliberately does not claim, and which fields
would make a later mapping cheap.

Checked 2026-11-21. Field names below were read from
`packages/core/src/receipt/schema.ts` at that date, not from memory.

## Nothing here is a conformance target

Every agent-receipt document cited is an **individual submission**. No IETF
working group has adopted one. SCITT itself is published (RFC 9942, RFC 9943);
the agent profiles of it are not. NIST's tenets are a blog post and guidance for
an upcoming NCCoE demonstration, not requirements. The W3C item is a discussion
paper proposing a direction, not a specification.

So none of them is a normative dependency of Lacre, and `AAT_DRAFT_VERSION` in
`schema.ts` stays pinned at `draft-sharif-agent-audit-trail-00` — the version
this schema was actually built against — so a future divergence is detectable
rather than silent. ADR 0002 already says we do not claim AAT conformance. That
stays true.

Individual drafts also expire. Treat every revision number below as "what was
read", not "what is current".

## What a Lacre receipt proves

Stated plainly, because several drafts in this space are read as promising more:

> A Lacre receipt shows **what was recorded, and that the record was not altered
> after it was issued**. It does not show that the action happened, that it
> happened as described, that it was authorized, that it was correct, or that
> every action was recorded.

`provenance_class` is the field that carries this distinction inside the record:
`attested` (vouched for by the party that performed it), `observed` (seen by the
issuer on the wire), `claimed` (reported to the issuer and not independently
seen). A receipt written by the agent's own SDK about its own action is
`claimed` or `attested` — never independent corroboration.

## The mapping

**covered**: the receipt already carries this, under the name given.
**partial**: the concept is there with different scope or granularity.
**absent**: not recorded.

### draft-sharif-agent-audit-trail (AAT), read at -09, 26 Oct 2026

The schema was built against AAT-00, so the core is close. What moved in -07
through -09 is the part that does not map.

| AAT -09 asks for | Lacre | Field |
|---|---|---|
| Agent identity | covered | `agent_id`, `agent_version` |
| Action class | covered | `action_type` (AAT enum, verbatim) |
| Outcome | covered | `outcome` (AAT enum, verbatim) |
| Trust level | covered | `trust_level` (AAT enum, verbatim) |
| SHA-256 hash chain over RFC 8785 | covered | `prev_hash`, canonicalized with JCS |
| Ed25519 as an optional `sig_alg` (added in -09) | covered | `lacre.signature_alg`, fixed to `ed25519` |
| **Authorizing principal, mandatory since -07** | **absent** | — |

The authorizing principal is the one real gap against AAT, and -07 making it
mandatory is the change that matters. Lacre records *which agent* acted and
*under which contract and approval* (`lacre.contract_id`,
`lacre.contract_result`, `lacre.approval_id`), but not *on whose authority* as a
first-class identity.

### draft-zambo-aer1 (AER-1), execution receipts

| AER-1 records | Lacre | Field |
|---|---|---|
| Execution id | covered | `record_id`, plus `lacre.run_id` / `turn_id` / `attempt_id` |
| Time | covered | `timestamp` (RFC 3339, explicit offset required) |
| Canonical output bytes | partial | `output_hash` is a digest, not the bytes |
| Tool and caller scope | partial | `lacre.action`, but no caller scope |
| Provenance class | covered | `lacre.provenance_class` |
| Stable URL | absent | — |
| Workflow receipts with a Merkle root | absent | the chain is linear, per agent |

AER-1 added workflow receipts and external anchoring explicitly *because a hash
chain does not catch a dropped tail*. That is the same limitation recorded below,
reached independently.

### draft-emirdag-scitt-ai-agent-execution (AIR), -01, 12 Oct 2026

Profiles SCITT: the operator signs an `AgentInteractionRecord` as a `COSE_Sign1`,
and an independent **Evidence Custodian** runs the transparency service. The
draft says the tamper-evidence guarantee is void if one entity plays both roles.

Lacre signs with Ed25519 over JCS JSON, not COSE, and runs no transparency
service. The structural point is the one worth keeping: in the free tier the
operator holds the signing key *and* the store, which is exactly the
one-entity-two-roles case. The paid tier's RFC 3161 anchor is what introduces a
party the operator does not control — see
[ADR 0003](adr/0003-anchoring.md) and the README's "What this is honestly worth".

### Permission and delegation receipts

`draft-izmaylov-agent-permission-receipts` and
`draft-nelson-agent-delegation-receipts` both record a grant — who authorized
what, to whom, within which limits — rather than an execution. Lacre records the
*check* (`lacre.contract_id`, `contract_result`, `approval_id`,
`lease_id`, `fencing_token`) but not the *grant*. Same absent principal as AAT.

`draft-raskar-scitt-agent-provenance` and the
`bofreq-kuhlewind-audit-agent-use-of-delegation-and-interaction-traceability`
BoF request are both about that chain of delegation. There is no BoF outcome to
act on.

### NIST, Design Tenets for Agent Identity Management Systems (27 Oct 2026)

A blog post, not a standard. Two tenets touch this product:

- **Tenet 10, Immutable Evidence** — an unbroken, tamper-evident, append-only
  record of agent identity, delegated intent and resulting actions, *held by
  logging infrastructure independent of the agent*. Lacre is append-only and
  tamper-evident. The independence half is the open one: `issuer_kind` already
  distinguishes `sdk` (the agent's own process) from `gateway` (an intermediary
  that saw the call on the wire), so the record says which it was, but the free
  tier does not provide an independent recorder.
- **Tenet 6** — cryptographically signed mandates from the task originator.
  Absent, same gap as the principal.

NIST itself says not all tenets are met by current standards.

### EU AI Act

Article 12 requires high-risk systems to be technically capable of automatic
event recording over their lifetime; Article 19 requires providers to keep logs
under their control for at least six months. Regulation (EU) 2026/1744, in force
27 July 2026, deferred application to **2 December 2027** for Annex III systems
and **2 August 2028** for Annex I products. Nothing was repealed.

These obligations fall on the *provider of a high-risk system*, not on Lacre.
Lacre can be part of how a provider meets them. It does not meet them for anyone,
and the Terms already say using Lacre does not by itself meet the requirements of
any law, regulation or standard.

One thing to note against Article 19's six months: Cloud's advertised retention
is 90 days, and nothing enforces it either way (see PROGRESS.md). A customer with
an Article 19 obligation cannot discharge it with a 90-day retention period.

### W3C

No W3C provenance or receipt standard for agent actions was published in this
window.

## The two properties a self-signed chain cannot provide

The recent drafts converge on these, and neither is a field that could be added:

1. **A recorder independent of the agent.** When the operator holds the signing
   key and the store, they can rebuild history and re-sign it. The Exhibit A demo
   on the home page shows exactly this: altering a receipt breaks the chain, and
   re-signing repairs it. Only the anchor disagrees afterwards.
2. **An external anchor or transparency-log receipt, so a dropped tail is
   detectable.** A hash chain detects a receipt removed from the *start or
   middle* of a range, because `lacre.seq` is monotonic. It does not detect
   receipts dropped from the *end*, after the last anchor.

The second is not a theoretical gap, and it is already recorded as such in the
verifier's own tests — `packages/verifier/test/truncation.test.ts`, under
"what this fix deliberately leaves alone":

- a tail truncated below the anchor downgrades rather than failing (open finding)
- an anchor with its proof stripped downgrades rather than failing (open finding)
- a bundle with no receipts still verifies (open finding)

## What this pass does not propose

Not in scope here, and deliberately so: implementing COSE / `COSE_Sign1`, SCITT
registration or a transparency service, ML-DSA, or a W3C Verifiable Credential
envelope. Each would be a format change made to match a document no working
group has adopted.

## The fields worth adding when one of these is adopted

Three, in the order they would pay off. None is proposed for this pass.

1. **An authorizing principal.** Required by AAT since -07, implied by NIST
   tenet 6, and the subject of both permission-receipt drafts. It is the single
   field that appears in every document read here.
2. **A mandate or grant reference** — an id for the signed authorization an
   action was taken under, so an execution receipt can be tied to the permission
   receipt that allowed it. `lacre.approval_id` is the nearest existing field and
   is an internal id, not a reference to a signed grant.
3. **A caller scope** for AER-1, naming the tool and the scope the call was made
   within. `lacre.action` carries the action name but not the scope.

Adding the first two would make a later mapping mechanical rather than a schema
revision. Neither should be added before a working group adopts something,
because the drafts still contradict each other on the basics: JWS vs COSE_Sign1
vs DSSE, Ed25519 vs ES256 vs ML-DSA, and one chain per store vs per job vs per
agent.
