# Real timestamp-token fixtures

These are **genuine RFC 3161 TimeStampTokens** fetched from three public
timestamp authorities on 2026-09-03, each timestamping
`SHA-256("provenant-tsa-probe")` (see `probe_digest.bin`).

They are committed deliberately. Testing an RFC 3161 parser only against tokens
produced by our own encoder is circular: a shared misreading of the spec would
pass on both sides. These prove the parser handles what real authorities
actually emit — including the awkward parts:

- **freetsa** embeds its self-signed root, so the chain completes inside the token.
- **digicert** and **sectigo** deliberately omit the root and ship only up to an
  intermediate, expecting the verifier to hold the root. That is normal
  commercial PKI practice and is why chain completeness is reported separately
  from cryptographic soundness.

They do not expire as tests: certificate validity is checked against the token's
own attested time, not against the wall clock.

## Trust-anchor certificates

These show that a trust anchor is matched the way RFC 5280 defines one (subject
name plus public key), not by the bytes of one certificate.

- **`digicert-trusted-root-g4.pem`**: the self-signed DigiCert Trusted Root G4,
  downloaded from `https://cacerts.digicert.com/DigiCertTrustedRootG4.crt` on
  2026-11-08. SHA-256
  `552f7bdcf1a7af9e6ce672017f4f12abf77240c78e761ac203d1d9d20ac89988`, which is
  the value DigiCert lists for this root at
  https://knowledge.digicert.com/general-information/digicert-trusted-root-authority-certificates.
- **`digicert-trusted-root-g4-cross-signed.pem`**: the DigiCert Trusted Root G4
  certificate cross-signed by DigiCert Assured ID Root CA, extracted unchanged
  from `digicert.tst`. SHA-256
  `33846b545a49c9be4903c60e01713c1bd4e4ef31ea65cd95d69e62794f30b941`. It has the
  same subject and public key as the self-signed root, but a different issuer.
- **`impostor-trusted-root-g4.pem`**: synthetic. The real root re-signed with a
  newly generated RSA key (`openssl x509 -in digicert-trusted-root-g4.pem -key
  <new key>`), so its subject bytes are identical to DigiCert's and only the key
  differs. It must never anchor anything. The private key was discarded.
