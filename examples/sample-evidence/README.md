# A real anchored evidence bundle

`evidence.json` is a genuine Lacre bundle (`lacre-bundle-v1`): 3 receipts,
hash-chained and Ed25519-signed, with the chain head timestamped by
**DigiCert's production RFC 3161 authority** on 2026-10-27.

Nothing here is mocked. You can check it yourself, offline, right now:

```bash
node packages/verifier/bin/lacre-verify.mjs examples/sample-evidence/evidence.json
```

Run it from the root of a source checkout after `pnpm install && pnpm run build`
(see [Getting started from source](../../docs/getting-started.md)).
`npx @lacre/verifier` works in its place once the package is published to npm.

It will report `VERIFIED / ANCHORED` and print DigiCert as the attesting
authority, while also telling you the authority is **not in your trust list**,
because trust has to come from you, not from the bundle.

The certificate at the top of the token's chain is DigiCert Trusted Root G4
**cross-signed by DigiCert Assured ID Root CA**. Its fingerprint comes from the
bundle, so do not pin it. To close the loop, download the root DigiCert
publishes, <https://cacerts.digicert.com/DigiCertTrustedRootG4.crt.pem>, save it
in the repository root as `DigiCertTrustedRootG4.crt.pem`, and pass it:

```bash
node packages/verifier/bin/lacre-verify.mjs examples/sample-evidence/evidence.json \
  --trust DigiCertTrustedRootG4.crt.pem
```

The verdict stays `VERIFIED / ANCHORED`, and the anchor now reports `trusted by
you: yes`. The verifier matches the anchor by subject name plus public key (RFC
5280), which is why the self-signed root anchors the cross-signed copy in the
token. (Again, `npx @lacre/verifier` works in place of the `node` path once the
package is published to npm.)

The verifier prints the SHA-256 fingerprint of the root you supplied as `your
anchor`. For DigiCert Trusted Root G4 it is
`552f7bdcf1a7af9e6ce672017f4f12abf77240c78e761ac203d1d9d20ac89988`. Confirm it
against DigiCert's own list,
<https://knowledge.digicert.com/general-information/digicert-trusted-root-authority-certificates>,
rather than taking it from this file. A repository is exactly the kind of place
an attacker would put a fingerprint they wanted you to trust.

## Try to break it

The point of the bundle is that tampering is detectable. Edit any value inside a
`canonical_json` string and re-run the verifier: it will name the exact receipt,
report `HASH_MISMATCH` and `SIGNATURE_INVALID`, and still prove which receipts
around it remain intact.

For the harder attack — rebuilding the whole chain with valid signatures, which
defeats local verification entirely — see
`packages/cloud/test/forgery.test.ts`. The anchor is what catches that one.

## evidence.pdf and evidence.html

The human-readable summaries. Both say on their own face that they are **not**
the evidence: neither carries cryptography and anyone can edit them. They exist
so an auditor can understand what the bundle says and how to check it themselves.

`evidence.html` is the primitive behind the hosted verifier page. It is fully
self-contained — no scripts, no CDN, no external fonts or images — because an
evidence report that phones out to a third party cannot be opened in the
air-gapped room where audits actually happen, and would leak the reader's
identity if it could.
