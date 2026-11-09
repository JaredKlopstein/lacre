/**
 * lacre-verify -- verify an evidence bundle offline.
 *
 * Exit codes are the contract for CI and scripts:
 *   0  verified
 *   1  verification FAILED (tampering, forgery, or a broken chain), or, only
 *      with --require-trusted, no anchor from an authority you trust
 *   2  the bundle could not be read at all, or the arguments were invalid
 *
 * Under --json every outcome is JSON on stdout: the verdict for 0 and 1, and
 * { ok: false, error: { code, message } } for 2.
 *
 * The human output is written for someone during an incident who has to decide,
 * quickly, whether they can rely on this. It says what was established and --
 * just as importantly -- what was not.
 */
import { readFileSync } from 'node:fs';
import { X509Certificate } from 'node:crypto';
import { verifyBundle, type BundleVerdict, type VerifyOptions } from './bundle.js';
import { checkRun, type RunReport } from './run.js';
import { fingerprintProblem } from './rfc3161.js';

export interface VerifyIO {
  out(s: string): void;
  err(s: string): void;
}

const defaultIO: VerifyIO = {
  out: (s) => process.stdout.write(s + '\n'),
  err: (s) => process.stderr.write(s + '\n'),
};

const HELP = `lacre-verify -- verify a Lacre evidence bundle, offline

USAGE
  lacre-verify <bundle.json> [options]

OPTIONS
  --json              Machine-readable verdict on stdout
  --trust <file>      PEM file of timestamp-authority certificates you trust,
                      usually the authority's root as it publishes it. May be
                      repeated. Matched by subject name plus public key, so a
                      root and a cross-signed copy of it are the same anchor.
                      Without it the token is still checked cryptographically,
                      but reported as untrusted -- because a root embedded in
                      the bundle proves nothing on its own.
  --trust-fingerprint <sha256>
                      Pin a certificate the token carries by its SHA-256
                      fingerprint (64 hex characters, colons allowed). To trust
                      a root the token omits, pass the root with --trust.
  --require-trusted   Exit 1 unless the bundle verifies AND at least one anchor
                      is from an authority you trust. Without it, exit 0 means
                      the bundle verified, not that you trust who timestamped
                      it. Use it with --trust in scripts and CI gates.
  --backdate-tolerance-ms <n>
                      Clock skew allowed before a post-anchor receipt claiming
                      an earlier time is treated as backdating (default 300000).
  --help

EXIT CODES
  0 verified   1 verification failed   2 bundle unreadable or bad arguments
  0  The bundle verified. Without --require-trusted this does not mean you
     trust the authority that timestamped it.
  1  A VERIFICATION FAILED verdict saying why, including for valid JSON that
     is not a bundle. With --require-trusted, also an anchor from an
     authority outside your trust list.
  2  No verdict. The bundle could not be read or is not JSON
     (BUNDLE_UNREADABLE), a --trust file could not be read or holds no
     certificate (TRUST_FILE_UNREADABLE), or an option was wrong (USAGE).

This tool makes no network connections and shares no code with the Lacre
server or the commercial package. Everything it needs is in the bundle.`;

export function runVerify(argv: string[], io: VerifyIO = defaultIO): number {
  if (argv[0] === 'run') return runCheck(argv.slice(1), io);
  const json = argv.includes('--json');
  if (argv.length === 0 || argv.includes('--help')) {
    io.out(HELP);
    return argv.length === 0 ? 2 : 0;
  }

  // A usage error must never fall through to a verdict: a mistyped flag that
  // silently did nothing (say, --trusted for --trust) would report a result
  // checked under options the caller never got.
  const fail2 = (code: string, message: string): number => {
    io.err(`lacre-verify: ${message}`);
    if (json) io.out(JSON.stringify({ ok: false, error: { code, message } }, null, 2));
    return 2;
  };
  const usage = (message: string): number => fail2('USAGE', message);

  const opts: VerifyOptions = {};
  const trustFiles: string[] = [];
  const fingerprints: string[] = [];
  let file: string | null = null;
  let requireTrusted = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--json') continue;
    if (a === '--require-trusted') {
      requireTrusted = true;
      continue;
    }
    if (a === '--trust' || a === '--trust-fingerprint' || a === '--backdate-tolerance-ms') {
      const v = argv[i + 1];
      if (v === undefined || v === '' || v.startsWith('--')) return usage(`${a} needs a value. Try --help.`);
      i++;
      if (a === '--trust') trustFiles.push(v);
      else if (a === '--trust-fingerprint') {
        const problem = fingerprintProblem(v);
        if (problem) return usage(`--trust-fingerprint ${problem}`);
        fingerprints.push(v);
      }
      else if (!/^\d+$/.test(v) || !Number.isSafeInteger(Number(v))) {
        return usage(`--backdate-tolerance-ms must be a non-negative integer of milliseconds, got '${v}'.`);
      } else opts.backdateToleranceMs = Number(v);
    } else if (a.startsWith('--')) {
      return usage(
        `unknown option '${a}'. Options are --json, --trust, --trust-fingerprint, --require-trusted, --backdate-tolerance-ms and --help.`,
      );
    } else if (file === null) file = a;
    else return usage(`unexpected argument '${a}'; give exactly one bundle file.`);
  }

  if (!file) return usage('no bundle file given. Try --help.');

  let bundle: unknown;
  try {
    bundle = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    return fail2('BUNDLE_UNREADABLE', `could not read '${file}': ${String(err)}`);
  }

  const anchors: X509Certificate[] = [];
  for (const f of trustFiles) {
    try {
      const raw = readFileSync(f);
      const blocks = raw.toString('utf8').match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? [];
      if (blocks.length) {
        for (const block of blocks) anchors.push(new X509Certificate(block));
      } else {
        // Not PEM. Authorities often serve roots as DER (.crt, .cer), so try that
        // before reporting that the file holds no certificate at all. Silently
        // trusting nothing would read as "the authority is untrusted".
        try {
          anchors.push(new X509Certificate(raw));
        } catch {
          return fail2(
            'TRUST_FILE_UNREADABLE',
            `trust file '${f}' holds no certificate: expected a PEM file with a -----BEGIN CERTIFICATE----- ` +
              `block, or a single DER certificate. Download the authority's root certificate from the authority itself.`,
          );
        }
      }
    } catch (err) {
      return fail2('TRUST_FILE_UNREADABLE', `could not read trust file '${f}': ${String(err)}`);
    }
  }
  if (anchors.length) opts.trustAnchors = anchors;
  if (fingerprints.length) opts.trustedFingerprints = fingerprints;

  const verdict = verifyBundle(bundle, opts);

  // Opt-in, so the default exit code never changes under existing callers.
  const requirement = requireTrusted ? trustedRequirement(verdict) : null;

  if (json) io.out(JSON.stringify(requirement ? { ...verdict, require_trusted: requirement } : verdict, null, 2));
  else io.out(render(verdict, { trustFiles: trustFiles.length > 0, fingerprints: fingerprints.length > 0 }, requirement));

  if (!verdict.ok) return 1;
  return requirement && !requirement.met ? 1 : 0;
}

interface TrustedRequirement {
  met: boolean;
  reason: string | null;
}

function trustedRequirement(v: BundleVerdict): TrustedRequirement {
  if (!v.ok) return { met: false, reason: 'the bundle did not verify.' };
  if (!v.anchored) {
    return { met: false, reason: 'the bundle has no external anchor, so no authority vouches for it at all.' };
  }
  if (!v.anchor_authority_trusted) {
    return {
      met: false,
      reason:
        'no anchor is from an authority in your trust list. Get the authority\'s root certificate from the ' +
        'authority itself and pass it with --trust.',
    };
  }
  return { met: true, reason: null };
}

/** Why an anchor is not trusted, in terms of what the caller actually passed. */
function untrustedReason(given: { trustFiles: boolean; fingerprints: boolean }): string[] {
  if (!given.trustFiles && !given.fingerprints) return ['NO -- pass --trust or --trust-fingerprint'];
  const L = ['NO -- nothing you passed anchors this chain'];
  if (given.trustFiles) {
    L.push('no --trust certificate has the subject name and public key of a certificate on this chain');
  }
  if (given.fingerprints) {
    L.push(
      'your --trust-fingerprint pin matched no certificate on this chain. A fingerprint can only',
      'match a certificate the verifier holds. If you pinned a root this token does not carry,',
      'pass the root certificate itself with --trust.',
    );
  }
  return L;
}

function render(
  v: BundleVerdict,
  given: { trustFiles: boolean; fingerprints: boolean },
  requirement: TrustedRequirement | null,
): string {
  const L: string[] = [];
  const rule = '-'.repeat(72);

  L.push(rule);
  L.push(v.verdict);
  L.push(rule);
  L.push('');
  L.push(v.conclusion);
  L.push('');
  L.push(`chain      ${v.chain_id ?? 'unknown'}`);
  if (v.range) L.push(`range      seq ${v.range.from_seq} to ${v.range.to_seq} (${v.receipts_checked} receipts)`);
  if (v.receipt_time_range) L.push(`dated      ${v.receipt_time_range.first} to ${v.receipt_time_range.last}`);

  if (v.anchors.length) {
    L.push('');
    L.push('ANCHORS');
    for (const a of v.anchors) {
      L.push(`  seq ${a.seq}  [${a.backend}]  ${a.is_evidence ? 'EVIDENCE' : 'not evidence'}`);
      if (a.proven_time) L.push(`    attested time : ${a.proven_time}`);
      if (a.timestamp?.signer) L.push(`    authority     : ${a.timestamp.signer}`);
      if (a.timestamp?.chain.top) {
        L.push(`    chain top     : ${a.timestamp.chain.top.subject}`);
        L.push(`    issued by     : ${a.timestamp.chain.top.issuer}`);
        L.push(`    fingerprint   : ${a.timestamp.chain.top.fingerprint_sha256}`);
      }
      const by = a.timestamp?.trusted_by;
      if (a.timestamp?.trusted && by) {
        L.push(`    trusted by you: yes -- anchored at your certificate '${by.subject}'`);
        L.push(`    your anchor   : ${by.fingerprint_sha256}`);
      } else {
        const [first, ...rest] = untrustedReason(given);
        L.push(`    trusted by you: ${first}`);
        for (const r of rest) L.push(`                    ${r}`);
      }
      L.push(`    ${a.note}`);
    }
  }

  if (v.failures.length) {
    L.push('');
    L.push(`FAILURES (${v.failures.length})`);
    for (const f of v.failures) {
      L.push(`  ${f.seq === null ? 'bundle' : `seq ${f.seq}`}  ${f.kind}`);
      L.push(`    ${f.message}`);
      if (f.expected) L.push(`    expected: ${f.expected}`);
      if (f.actual) L.push(`    actual  : ${f.actual}`);
    }
    L.push('');
    L.push(`STILL PROVABLY INTACT: ${v.intact_ranges.map((r) => `seq ${r.from_seq}-${r.to_seq}`).join(', ') || 'nothing'}`);
  }

  if (v.warnings.length) {
    L.push('');
    L.push('WARNINGS');
    for (const w of v.warnings) L.push(`  - ${w}`);
  }

  if (requirement && !requirement.met) {
    L.push('');
    const reason = requirement.reason ?? '';
    L.push(`REQUIREMENT NOT MET: --require-trusted. ${reason.charAt(0).toUpperCase()}${reason.slice(1)} Exit 1.`);
  }

  L.push('');
  L.push(rule);
  return L.join('\n');
}

const RUN_HELP = `lacre-verify run -- check one agent run's receipts, offline

USAGE
  lacre-verify run RECEIPTS --keys KEYS [--json]

ARGUMENTS
  RECEIPTS            JSON array of signed receipts in stored form, in chain
                      order (ascending seq).
  --keys <file>       JSON object mapping each lacre.key_id to its public
                      key as an Ed25519 JWK. Include every key the run was
                      signed under, rotated ones too.
  --json              Machine-readable report on stdout
  --help

REPORTS
  broken links        prev_hash mismatch, failed signature, or unknown key_id
  gaps                seq not contiguous from 0, or a first record whose
                      prev_hash is not null
  duplicate attempts  the same action, input_hash and turn_id under more than
                      one attempt_id. Reported, not a failure.

EXIT CODES
  0 intact   1 broken links or gaps   2 input unreadable`;

function runCheck(argv: string[], io: VerifyIO): number {
  if (argv.includes('--help')) {
    io.out(RUN_HELP);
    return 0;
  }

  let json = false;
  let keysFile: string | null = null;
  let file: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--json') json = true;
    else if (a === '--keys') keysFile = argv[++i] ?? null;
    else if (a.startsWith('--')) {
      io.err(`lacre-verify run: unknown option '${a}'. Options are --keys, --json and --help.`);
      return 2;
    } else if (file === null) file = a;
    else {
      io.err(`lacre-verify run: unexpected argument '${a}'; give exactly one RECEIPTS file.`);
      return 2;
    }
  }

  if (!file || !keysFile) {
    io.err(`lacre-verify run: ${!file ? 'no RECEIPTS file' : 'no --keys file'} given. Usage: lacre-verify run RECEIPTS --keys KEYS`);
    return 2;
  }

  let receipts: unknown;
  let keys: unknown;
  try {
    receipts = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    io.err(`lacre-verify run: could not read '${file}': ${String(err)}`);
    return 2;
  }
  if (!Array.isArray(receipts)) {
    io.err(`lacre-verify run: '${file}' must hold a JSON array of receipts.`);
    return 2;
  }
  try {
    keys = JSON.parse(readFileSync(keysFile, 'utf8'));
  } catch (err) {
    io.err(`lacre-verify run: could not read keys file '${keysFile}': ${String(err)}`);
    return 2;
  }
  if (keys === null || typeof keys !== 'object' || Array.isArray(keys)) {
    io.err(`lacre-verify run: keys file '${keysFile}' must hold a JSON object of key_id to public JWK.`);
    return 2;
  }

  const report = checkRun(receipts, keys as Record<string, unknown>);
  if (json) io.out(JSON.stringify(report, null, 2));
  else io.out(renderRun(report, file));
  return report.ok ? 0 : 1;
}

function renderRun(r: RunReport, file: string): string {
  const L: string[] = [];
  const rule = '-'.repeat(72);
  const where = (x: { seq: number | null; index: number }) => (x.seq === null ? `#${x.index}` : `seq ${x.seq}`);

  L.push(rule);
  L.push(r.ok ? 'RUN INTACT' : 'RUN BROKEN');
  L.push(rule);
  L.push('');
  L.push(`receipts   ${r.receiptsChecked} from ${file}`);

  if (r.brokenLinks.length) {
    L.push('');
    L.push(`BROKEN LINKS (${r.brokenLinks.length})`);
    for (const b of r.brokenLinks) {
      L.push(`  ${where(b)}  ${b.kind}`);
      L.push(`    ${b.message}`);
      if (b.expected) L.push(`    expected: ${b.expected}`);
      if (b.actual) L.push(`    actual  : ${b.actual}`);
    }
  }

  if (r.gaps.length) {
    L.push('');
    L.push(`GAPS (${r.gaps.length})`);
    for (const g of r.gaps) {
      L.push(`  ${where(g)}`);
      L.push(`    ${g.message}`);
    }
  }

  if (r.duplicateAttempts.length) {
    L.push('');
    L.push(`DUPLICATE ATTEMPTS (${r.duplicateAttempts.length}) -- reported, not a failure`);
    for (const d of r.duplicateAttempts) {
      L.push(`  ${d.action}  turn ${d.turnId}  input_hash ${d.inputHash}`);
      for (const a of d.attempts) {
        L.push(`    attempt ${a.attemptId}  at ${a.seqs.map((s) => (s === null ? '?' : `seq ${s}`)).join(', ')}`);
      }
    }
  }

  L.push('');
  L.push(
    r.ok
      ? 'Every record links to the one before it and verifies under the key it names. ' +
        'This proves internal consistency only: it cannot show that records were not cut ' +
        'from the end, or that the operator did not rewrite and re-sign the run. ' +
        'Only an anchored head binds the operator.'
      : 'Do not rely on records at or after the first broken link or gap without further evidence.',
  );
  L.push(rule);
  return L.join('\n');
}
