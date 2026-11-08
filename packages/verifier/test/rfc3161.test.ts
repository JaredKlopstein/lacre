import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { X509Certificate } from 'node:crypto';
import { verifyTimestampToken } from '../src/rfc3161.js';
import { parseDer, DerError } from '../src/der.js';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const digest = new Uint8Array(readFileSync(join(FIX, 'probe_digest.bin')));
const token = (name: string) => new Uint8Array(readFileSync(join(FIX, `${name}.tst`)));

/**
 * These run against GENUINE tokens from three public timestamp authorities.
 *
 * Testing an RFC 3161 parser only against tokens from our own encoder would be
 * circular: a shared misreading of the specification would pass on both sides
 * and we would ship a verifier that rejects real evidence (or worse, accepts
 * bad evidence). These fixtures are the guard against that.
 */
describe('real timestamp tokens from public authorities', () => {
  for (const name of ['freetsa', 'digicert', 'sectigo']) {
    describe(name, () => {
      it('verifies cryptographically against the digest it timestamped', () => {
        const v = verifyTimestampToken(token(name), { expectedImprint: digest });
        expect(v.failures).toEqual([]);
        expect(v.ok).toBe(true);
        expect(v.proven_time).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        expect(v.signer).toBeTruthy();
      });

      it('rejects a different digest -- the token must bind OUR data', () => {
        const v = verifyTimestampToken(token(name), { expectedImprint: new Uint8Array(32).fill(7) });
        expect(v.ok).toBe(false);
        expect(v.failures.join(' ')).toMatch(/does not match the expected/);
      });

      it('is not trusted without an explicit trust list', () => {
        // A root inside a token proves nothing: anyone can mint a self-signed
        // root. Trust must come from the caller.
        const v = verifyTimestampToken(token(name), { expectedImprint: digest });
        expect(v.trusted).toBe(false);
      });

      it('becomes trusted when its chain top is pinned', () => {
        const base = verifyTimestampToken(token(name), { expectedImprint: digest });
        const pin = base.chain.root?.fingerprint_sha256 ?? base.chain.top!.fingerprint_sha256;
        const v = verifyTimestampToken(token(name), {
          expectedImprint: digest,
          trustedFingerprints: [pin],
        });
        expect(v.trusted).toBe(true);
      });

      it('stays untrusted under a wrong pin', () => {
        const v = verifyTimestampToken(token(name), {
          expectedImprint: digest,
          trustedFingerprints: ['00'.repeat(32)],
        });
        expect(v.ok).toBe(true); // still cryptographically sound
        expect(v.trusted).toBe(false); // but not vouched for
      });

      it('detects any single-byte corruption', () => {
        const t = token(name);
        // Walk a few positions through the signature-bearing tail.
        for (const offset of [t.length - 10, t.length - 40, t.length - 100]) {
          const bad = new Uint8Array(t);
          bad[offset] ^= 0xff;
          const v = verifyTimestampToken(bad, { expectedImprint: digest });
          expect(v.ok, `corruption at -${t.length - offset} went undetected`).toBe(false);
        }
      });
    });
  }

  it('distinguishes a token that embeds its root from one that does not', () => {
    // freetsa ships its self-signed root; the commercial authorities do not and
    // expect the verifier to hold it. Both are legitimate, and conflating them
    // would mean rejecting genuine DigiCert and Sectigo evidence.
    const free = verifyTimestampToken(token('freetsa'), { expectedImprint: digest });
    const dg = verifyTimestampToken(token('digicert'), { expectedImprint: digest });

    expect(free.chain.complete).toBe(true);
    expect(free.chain.root).not.toBeNull();

    expect(dg.chain.complete).toBe(false);
    expect(dg.chain.top).not.toBeNull();
    expect(dg.chain.reason).toMatch(/normal for a commercial timestamp authority/);
    // Crucially, an incomplete chain is NOT a cryptographic failure.
    expect(dg.ok).toBe(true);
  });

  it('completes a commercial chain when the root is supplied as a trust anchor', () => {
    const dg = verifyTimestampToken(token('digicert'), { expectedImprint: digest });
    // Use freetsa's root as a stand-in anchor that does NOT match: the chain
    // must stay incomplete rather than accept an unrelated anchor.
    const freeRootDer = findSelfSigned(token('freetsa'));
    const v = verifyTimestampToken(token('digicert'), {
      expectedImprint: digest,
      trustAnchors: freeRootDer ? [freeRootDer] : [],
    });
    expect(v.chain.complete).toBe(false);
    expect(v.chain.top?.subject).toBe(dg.chain.top?.subject);
  });
});

/**
 * RFC 5280 section 6.1.1(d): a trust anchor is a subject name plus a public key,
 * not the exact bytes of one certificate. A root CA can exist as more than one
 * certificate with the same name and key: DigiCert Trusted Root G4 is both a
 * self-signed root (the one DigiCert publishes and operating systems ship) and
 * a certificate cross-signed by DigiCert Assured ID Root CA (the one DigiCert's
 * timestamp tokens carry). Either must anchor the same chain, and nothing with
 * the right name but a different key may.
 *
 * Fixtures (see fixtures/README.md for provenance):
 *   digicert-trusted-root-g4.pem               self-signed, from cacerts.digicert.com
 *   digicert-trusted-root-g4-cross-signed.pem  cross-signed, as carried in digicert.tst
 *   impostor-trusted-root-g4.pem               same subject bytes, different key
 */
describe('trust anchors are matched by subject name plus public key (RFC 5280)', () => {
  const pem = (name: string) => new X509Certificate(readFileSync(join(FIX, name)));
  const selfSigned = pem('digicert-trusted-root-g4.pem');
  const crossSigned = pem('digicert-trusted-root-g4-cross-signed.pem');
  const impostor = pem('impostor-trusted-root-g4.pem');

  const SELF_SIGNED_FP = '552f7bdcf1a7af9e6ce672017f4f12abf77240c78e761ac203d1d9d20ac89988';
  const CROSS_SIGNED_FP = '33846b545a49c9be4903c60e01713c1bd4e4ef31ea65cd95d69e62794f30b941';

  it('uses the fixtures it claims to use', () => {
    // Guard against a fixture swap making every test below vacuous.
    expect(selfSigned.fingerprint256.replace(/:/g, '').toLowerCase()).toBe(SELF_SIGNED_FP);
    expect(selfSigned.checkIssued(selfSigned)).toBe(true);
    expect(crossSigned.fingerprint256.replace(/:/g, '').toLowerCase()).toBe(CROSS_SIGNED_FP);
    expect(crossSigned.issuer).toMatch(/DigiCert Assured ID Root CA/);
    for (const c of [crossSigned, impostor]) expect(c.subject).toBe(selfSigned.subject);
    expect(impostor.publicKey.equals(selfSigned.publicKey)).toBe(false);
    expect(crossSigned.publicKey.equals(selfSigned.publicKey)).toBe(true);
  });

  it('trusts the DigiCert chain when given the self-signed G4 root DigiCert publishes', () => {
    const v = verifyTimestampToken(token('digicert'), { expectedImprint: digest, trustAnchors: [selfSigned] });
    expect(v.failures).toEqual([]);
    expect(v.ok).toBe(true);
    expect(v.trusted).toBe(true);
    expect(v.chain.complete).toBe(true);
    expect(v.chain.root?.fingerprint_sha256).toBe(SELF_SIGNED_FP);
    expect(v.trusted_by?.fingerprint_sha256).toBe(SELF_SIGNED_FP);
  });

  it('trusts the same chain when given the cross-signed G4 as a PEM', () => {
    const v = verifyTimestampToken(token('digicert'), { expectedImprint: digest, trustAnchors: [crossSigned] });
    expect(v.ok).toBe(true);
    expect(v.trusted).toBe(true);
    expect(v.trusted_by?.fingerprint_sha256).toBe(CROSS_SIGNED_FP);
  });

  it('still trusts the chain when the cross-signed G4 is pinned by fingerprint', () => {
    // Uppercase with colons is how DigiCert and openssl print it.
    const colons = CROSS_SIGNED_FP.toUpperCase().match(/../g)!.join(':');
    const v = verifyTimestampToken(token('digicert'), { expectedImprint: digest, trustedFingerprints: [colons] });
    expect(v.trusted).toBe(true);
    expect(v.trusted_by?.fingerprint_sha256).toBe(CROSS_SIGNED_FP);
  });

  it('does NOT trust a certificate with the G4 subject but a different key', () => {
    const v = verifyTimestampToken(token('digicert'), { expectedImprint: digest, trustAnchors: [impostor] });
    expect(v.ok).toBe(true); // the token itself is still sound...
    expect(v.trusted).toBe(false); // ...but the impostor vouches for nothing
    expect(v.trusted_by).toBeNull();
    expect(v.chain.complete).toBe(false);
    expect(v.chain.root).toBeNull();
  });

  it('does not let an impostor anchor displace the real one', () => {
    const v = verifyTimestampToken(token('digicert'), {
      expectedImprint: digest,
      trustAnchors: [impostor, selfSigned],
    });
    expect(v.trusted).toBe(true);
    expect(v.trusted_by?.fingerprint_sha256).toBe(SELF_SIGNED_FP);
  });

  it('cannot match a fingerprint of a certificate the verifier never sees', () => {
    // DigiCert tokens omit the self-signed root, so its fingerprint alone has
    // nothing to match against. Trusting it would mean trusting a hash of bytes
    // nobody checked. The fix is to supply the certificate itself.
    const v = verifyTimestampToken(token('digicert'), { expectedImprint: digest, trustedFingerprints: [SELF_SIGNED_FP] });
    expect(v.trusted).toBe(false);
  });

  it('still checks every link: a corrupted intermediate is not rescued by the real root', () => {
    const t = token('digicert');
    const intermediate = extractCerts(t).find((c) => /TimeStamping RSA4096 SHA256 2025 CA1/.test(c.subject))!;
    expect(intermediate).toBeTruthy();
    const raw = new Uint8Array(intermediate.raw);
    const at = Buffer.from(t).indexOf(Buffer.from(raw));
    expect(at).toBeGreaterThan(0);
    const bad = new Uint8Array(t);
    bad[at + raw.length - 1] ^= 0xff; // last byte of the intermediate's own signature

    const v = verifyTimestampToken(bad, { expectedImprint: digest, trustAnchors: [selfSigned] });
    expect(v.trusted).toBe(false);
    expect(v.chain.complete).toBe(false);
    expect(v.chain.reason).toMatch(/does not verify under its stated issuer/);
  });
});

describe('a malformed fingerprint is rejected, not silently ignored', () => {
  const bad: { value: string; why: RegExp }[] = [
    { value: 'nonsense', why: /64 hexadecimal characters/ },
    { value: 'zz', why: /64 hexadecimal characters/ },
    { value: '00'.repeat(31), why: /got 62/ },
    { value: '00'.repeat(33), why: /got 66/ },
    { value: 'g'.repeat(64), why: /not hexadecimal/ },
    // A SHA-1 thumbprint is the commonest wrong value to paste.
    { value: 'DD:FB:16:CD:49:31:C9:73:A2:03:7D:3F:C8:3A:4D:7D:77:5D:05:E4', why: /SHA-1/ },
  ];
  for (const b of bad) {
    it(`rejects '${b.value.slice(0, 24)}'`, () => {
      expect(() =>
        verifyTimestampToken(token('digicert'), { expectedImprint: digest, trustedFingerprints: [b.value] }),
      ).toThrow(b.why);
    });
  }
});

function extractCerts(tokenBytes: Uint8Array): X509Certificate[] {
  const out: X509Certificate[] = [];
  const stack = [parseDer(tokenBytes)];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.cls === 2 && n.tagNumber === 0 && n.constructed) {
      for (const c of n.children ?? []) {
        try { out.push(new X509Certificate(Buffer.from(c.full))); } catch { /* not a cert */ }
      }
    }
    for (const c of n.children ?? []) stack.push(c);
  }
  return out;
}

function findSelfSigned(tokenBytes: Uint8Array): X509Certificate | null {
  const root = parseDer(tokenBytes);
  const stack = [root];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.cls === 2 && n.tagNumber === 0 && n.constructed) {
      for (const c of n.children ?? []) {
        try {
          const cert = new X509Certificate(Buffer.from(c.full));
          if (cert.checkIssued(cert)) return cert;
        } catch {
          /* not a cert */
        }
      }
    }
    for (const c of n.children ?? []) stack.push(c);
  }
  return null;
}

describe('DER parser hardening', () => {
  it('rejects a lying length header instead of over-reading', () => {
    const bad = Uint8Array.from([0x30, 0x7f, 0x02, 0x01, 0x01]); // claims 127 bytes, has 3
    expect(() => parseDer(bad)).toThrow(DerError);
  });

  it('rejects indefinite-length encoding, which is BER but not DER', () => {
    // Accepting it would let two encodings of the same value both verify.
    expect(() => parseDer(Uint8Array.from([0x30, 0x80, 0x00, 0x00]))).toThrow(/indefinite length/);
  });

  it('rejects trailing bytes after a complete structure', () => {
    expect(() => parseDer(Uint8Array.from([0x02, 0x01, 0x01, 0xff]))).toThrow(/trailing bytes/);
  });

  it('rejects truncated input', () => {
    expect(() => parseDer(Uint8Array.from([0x30]))).toThrow(DerError);
    expect(() => parseDer(Uint8Array.from([0x30, 0x05, 0x01]))).toThrow(DerError);
  });

  it('caps nesting depth rather than blowing the stack', () => {
    // 40 nested SEQUENCEs. Kept under 63 levels so every length stays in DER
    // short form -- otherwise the parser would reject it on the length header
    // and we would not actually be exercising the depth cap.
    let buf = Uint8Array.from([0x05, 0x00]);
    for (let i = 0; i < 40; i++) {
      buf = Uint8Array.from([0x30, buf.length, ...buf]);
    }
    expect(buf.length).toBeLessThan(128);
    expect(() => parseDer(buf)).toThrow(/nesting deeper/);
  });

  it('never throws out of verifyTimestampToken on adversarial input', () => {
    // A verifier that crashes on hostile input is a denial-of-service vector and
    // an excuse to skip verification.
    const inputs = [
      new Uint8Array(0),
      Uint8Array.from([0x30, 0x80]),
      new Uint8Array(64).fill(0xff),
      crypto.getRandomValues(new Uint8Array(512)),
    ];
    for (const bad of inputs) {
      expect(() => verifyTimestampToken(bad, { expectedImprint: digest })).not.toThrow();
      expect(verifyTimestampToken(bad, { expectedImprint: digest }).ok).toBe(false);
    }
  });
});
