# Getting started from source

`@lacre/core` and `@lacre/verifier` are not published to npm yet, so
`npx @lacre/...` and a global `lacre` command will not work. Until they
are, run everything from a source checkout. Every command below runs from the
repository root, in order, with no edits.

You need Node 22.5.0 or later and pnpm 11. On Node 22 to 24, `corepack enable`
provides the pinned version. Node 25 and later no longer bundle corepack, so
install pnpm directly instead with `npm i -g pnpm@11.15.1`.

## 1. Clone and build

```bash
git clone https://github.com/JaredKlopstein/lacre.git
cd lacre
pnpm install
pnpm run build
```

`pnpm run build` compiles each package into its `dist/` directory, which is
what the `bin/*.mjs` entry points load. Skip it and the commands below fail
with a module-not-found error. It also builds the website package, which leaves
build output (`packages/site/.next/`, `next-env.d.ts`) that git reports as
untracked. To build only the two CLIs, run
`pnpm --filter @lacre/core --filter @lacre/verifier run build` instead.

## 2. Record and verify a receipt locally

By default Lacre keeps its store in `~/.lacre`. To keep this
walkthrough out of your home directory, point it at a store inside the checkout
(`.lacre/` is gitignored):

```bash
export LACRE_HOME="$PWD/.lacre"
```

Create a signing key and register this agent:

```bash
node packages/core/bin/lacre.mjs init --json
```

The response has `"ok": true`, your new `agent_id`, the store path and a
`next_actions` list suggesting what to call next.

Record one receipt:

```bash
node packages/core/bin/lacre.mjs record --action refund.issue \
  --action-detail '{"customer_id":"c_8812","amount_usd":42.50}' \
  --side-effect-class irreversible \
  --idempotency-key refund-c_8812-0001 --json
```

The response holds the signed receipt (`seq` 0, `prev_hash` null because it
is the first in the chain) and its `self_hash`. Run the same command again and
you get the original receipt back with `"replayed": true`. Nothing new is
written.

Record refusals too. When a consequential action is refused, by a policy, a
person or the agent itself, record it with `--outcome denied`, so the chain
shows the control working and not only what went through. `--outcome` also
takes `failure`, `timeout` and `escalated`; the default is `success`.

Verify the chain:

```bash
node packages/core/bin/lacre.mjs chain verify --json
```

Expect `"ok": true`, `"failures": []` and `"anchored": false`, together with an
`anchor_note` saying the chain is self-attested. That note is the honest limit
of a local chain: it proves internal consistency, not that the operator left
history alone. See "What this is honestly worth" in the
[README](../README.md#what-this-is-honestly-worth).

## 3. Verify a real anchored evidence bundle, offline

[`examples/sample-evidence/evidence.json`](../examples/sample-evidence/README.md)
is a genuine bundle of 3 receipts whose chain head was timestamped by DigiCert's
production RFC 3161 authority. The verifier needs no network access and no code
from `core` or `cloud`:

```bash
node packages/verifier/bin/lacre-verify.mjs examples/sample-evidence/evidence.json
```

It exits `0` and prints:

```
------------------------------------------------------------------------
VERIFIED / ANCHORED
------------------------------------------------------------------------
...
ANCHORS
  seq 2  [tsa]  EVIDENCE
    attested time : 2026-09-03T18:42:30.000Z
    authority     : C=US, O=DigiCert\, Inc., CN=DigiCert SHA256 RSA4096 Timestamp Responder 2026 1
    chain top     : C=US, O=DigiCert Inc, OU=www.digicert.com, CN=DigiCert Trusted Root G4
    fingerprint   : 33846b545a49c9be4903c60e01713c1bd4e4ef31ea65cd95d69e62794f30b941
    trusted by you: NO -- pass --trust or --trust-fingerprint
```

The mathematics checks out, but the authority is **not in your trust list**.
Trust has to come from you, not from the bundle, because anyone can embed a
self-signed root. To close that loop, pin DigiCert Trusted Root G4 by its
fingerprint:

```bash
node packages/verifier/bin/lacre-verify.mjs examples/sample-evidence/evidence.json \
  --trust-fingerprint 33846b545a49c9be4903c60e01713c1bd4e4ef31ea65cd95d69e62794f30b941
```

It still exits `0` with `VERIFIED / ANCHORED`, and the anchor now reports
`trusted by you: yes`. Confirm that fingerprint with DigiCert directly rather
than taking it from this file. A repository is exactly where an attacker would
plant a fingerprint they wanted you to trust.

Add `--json` to either command for a machine-readable verdict.

## What each verdict line means

The first line of the verifier's output is the verdict:

| Verdict | Exit | Meaning |
|---|---|---|
| `VERIFIED / ANCHORED` | 0 | Every receipt is intact and correctly signed, and at least one external timestamp commits to the chain head that was recomputed. Receipts after the highest anchored `seq` are still unanchored; the verifier warns about them. |
| `VERIFIED / NOT ANCHORED` | 0 | Every receipt is intact and correctly signed, but no external timestamp commits to the chain. The record is self-attested, the same guarantee as a local `chain verify`. |
| `VERIFICATION FAILED` | 1 | At least one receipt is altered, missing or wrongly signed. `FAILURES` names each one by `seq` (for example `HASH_MISMATCH`, `SIGNATURE_INVALID`), and `STILL PROVABLY INTACT` lists the ranges you can still rely on. |
| *(usage message on stderr)* | 2 | The bundle could not be read, or an option was unknown or malformed. No verdict is given. |

Each entry under `ANCHORS` reports:

- `EVIDENCE` or `not evidence`: whether this anchor actually constrains the
  operator, meaning its timestamp verifies **and** commits to the chain head
  the verifier recomputed.
- `attested time`: when the authority says the chain had reached this `seq`.
- `authority` and `chain top`: who signed the timestamp, and the top of the
  certificate chain that was found.
- `trusted by you`: whether a certificate in that chain matched `--trust` or
  `--trust-fingerprint`. Soundness and trust are reported separately and never
  merged.

To see a failure, edit any value inside a `canonical_json` string in a copy of
`evidence.json` and run the verifier on the copy. It names the exact receipt
and exits `1`.

## 4. Wire receipts into a tool

Put the `record` call in the tool itself, right after the action it describes,
and record what actually happened: `--outcome success`, `failure`, `timeout`,
`denied` or `escalated`. A receipt for a failure is worth as much as one for a
success.

An idempotency key names **one attempt and its result**, not the whole business
operation. A replay with the same key and the same arguments returns the
original receipt (`"replayed": true`). The same key with different arguments,
including a different `--outcome`, is refused with `IDEMPOTENCY_MISMATCH`, and
nothing is written. So:

- **Retrying the `record` call itself** (the process crashed or timed out
  before you saw the response): reuse the same key and the identical
  arguments. You get the original receipt back, never a duplicate.
- **The action failed and a retry of the action succeeded**: these are two
  attempts, so give them two keys and record both. Derive each key from the
  operation and the attempt number:

```bash
# attempt 1: the payment provider timed out
node packages/core/bin/lacre.mjs record --action refund.issue \
  --action-detail '{"order_id":"o_5521","amount_cents":4250}' \
  --side-effect-class irreversible --outcome timeout \
  --idempotency-key refund-o_5521-attempt-1 --json

# attempt 2: the retry went through
node packages/core/bin/lacre.mjs record --action refund.issue \
  --action-detail '{"order_id":"o_5521","amount_cents":4250}' \
  --side-effect-class irreversible --outcome success \
  --idempotency-key refund-o_5521-attempt-2 --json
```

- **The action succeeded but `record` failed**: retry `record` with the same
  key and arguments until it succeeds. Do not repeat the action to get a
  receipt.

Two more rules from real integrations:

- Store money as integer minor units (`"amount_cents":4250`). Receipts are
  canonicalized, so `42.50` is stored as `42.5`.
- Branch on the exit code. `0` is success and the JSON is on stdout. Anything
  else is a typed error on stderr, `{"ok": false, "error": {...}}`, whose `fix`
  says whether anything was written and what to do next.

The [reference clients](../examples/reference_client.ts) wrap all of this in
about 40 lines each ([Python](../examples/reference_client.py)). Copied into
another project, set `LACRE_BIN` to the path of `packages/core/bin/lacre.mjs`
in your Lacre checkout.

## 5. Make it evidence

A local chain is self-attested, and so is `lacre anchor now`. The open-source
build ships only the `noop` anchor backend, which records an anchor that
proves nothing. It has no RFC 3161 timestamp authority. A real anchor is an RFC
3161 timestamp from an authority you do not control. That is Lacre Cloud's
job, and Cloud is in early access and not on sale. What you can buy today is a
single anchored evidence bundle, from the pricing page on the Lacre website.
After checkout you are asked for your **chain file**. Its chain head is
timestamped by a public RFC 3161 authority, and you get back a bundle that you,
or anyone, can check offline as in section 3. The timestamp proves the chain
existed when it was anchored, not earlier.

The chain file is `lacre.db` in your store directory: `$LACRE_HOME`, or
`~/.lacre` by default. It holds your receipts and your agents' public keys.

- **Never send `agent.key.json`.** It sits in the same directory and holds the
  agent's private signing key. Anyone who has it can sign receipts as your
  agent. Do not zip up the whole store directory.
- **Do not copy `lacre.db` on its own while agents may be writing.** The store
  runs in SQLite WAL mode, so recent receipts can sit in the `lacre.db-wal`
  and `lacre.db-shm` side files, and a plain copy of `lacre.db` can miss them.
  Take a consistent snapshot with the `sqlite3` command-line shell instead,
  then check the snapshot before you send it:

```bash
mkdir -p lacre-export
sqlite3 "$LACRE_HOME/lacre.db" ".backup 'lacre-export/lacre.db'"
node packages/core/bin/lacre.mjs chain verify --store lacre-export --json
```

Send `lacre-export/lacre.db`, and nothing else from the store.

## Once the packages are published

When `@lacre/core` and `@lacre/verifier` are on npm, `npx
@lacre/verifier` replaces `node packages/verifier/bin/lacre-verify.mjs`,
and an installed `lacre` command replaces `node
packages/core/bin/lacre.mjs`. The arguments stay the same.
