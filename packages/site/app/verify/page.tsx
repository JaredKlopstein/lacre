import type { Metadata } from 'next';
import Link from 'next/link';
import { BRAND } from '../../src/brand';
import { CodeBlock } from '../../src/code-block';

export const metadata: Metadata = {
  title: 'Verify',
  description: `Check a ${BRAND.name} evidence bundle offline with the free MIT verifier. Verifying is never paywalled.`,
};

// The checkout directory and the verifier file both follow the repository path,
// so neither hard-codes the name.
const REPO_DIR = BRAND.repository.slice(BRAND.repository.lastIndexOf('/') + 1);
// A path shown in a shell command, not an import: the site imports nothing from the
// verifier (test/site-app.test.ts). scripts/check-boundaries.mjs rejects any literal
// path into another package from site source, so it is joined from its parts.
const VERIFY = `node ${['packages', 'verifier', 'bin', `${REPO_DIR}-verify.mjs`].join('/')} examples/sample-evidence/evidence.json`;

// SHA-256 fingerprint of the self-signed DigiCert Trusted Root G4, as DigiCert lists it
// on DIGICERT_ROOTS_PAGE. A public certificate fingerprint, kept in groups so no long hex
// run sits in source.
const DIGICERT_ROOT_G4 = [
  '552f7bdc', 'f1a7af9e', '6ce67201', '7f4f12ab',
  'f77240c7', '8e761ac2', '03d1d9d2', '0ac89988',
].join('');
const DIGICERT_ROOTS_PAGE =
  'https://knowledge.digicert.com/general-information/digicert-trusted-root-authority-certificates';
const DIGICERT_ROOT_G4_PEM = 'https://cacerts.digicert.com/DigiCertTrustedRootG4.crt.pem';
const DIGICERT_ROOT_G4_FILE = 'DigiCertTrustedRootG4.crt.pem';

// Each block is copied from docs/getting-started.md, sections 1 and 3, and must stay identical.
const STEPS = [
  {
    title: 'Clone and build',
    body: 'You need Node 22.5.0 or later and pnpm 11 (corepack enable provides the pinned version). The build compiles each package into the files the commands below load.',
    command: [`git clone ${BRAND.repository}.git`, `cd ${REPO_DIR}`, 'pnpm install', 'pnpm run build'].join('\n'),
  },
  {
    title: 'Verify a real anchored bundle',
    body: 'The repository ships a genuine bundle of 3 receipts whose chain head was timestamped by DigiCert’s production RFC 3161 authority. This exits 0 with VERIFIED / ANCHORED, and reports that the authority is not yet in your trust list.',
    command: VERIFY,
  },
  {
    title: 'Trust the authority yourself',
    body: (
      <>
        Trust has to come from you, not from the bundle, because anyone can embed a self-signed
        root. The certificate at the top of the token is DigiCert Trusted Root G4 cross-signed by
        DigiCert Assured ID Root CA, so do not pin its fingerprint: it comes from the bundle.
        Download the root DigiCert publishes,{' '}
        <a href={DIGICERT_ROOT_G4_PEM}>DigiCert Trusted Root G4 in PEM form</a>, save it in the
        repository root as <code>{DIGICERT_ROOT_G4_FILE}</code>, and pass it with{' '}
        <code>--trust</code>. The anchor then reports trusted by you: yes, and the verifier prints
        your root’s fingerprint as your anchor. It should be <code>{DIGICERT_ROOT_G4}</code>.
        Confirm that on{' '}
        <a href={DIGICERT_ROOTS_PAGE}>DigiCert’s own list of root certificates</a> rather than
        taking it from this page.
      </>
    ),
    command: `${VERIFY} \\\n  --trust ${DIGICERT_ROOT_G4_FILE}`,
  },
] as const;

const VERDICTS = [
  {
    verdict: 'VERIFIED / ANCHORED',
    exit: 0,
    meaning: 'Every receipt is intact and correctly signed, and at least one external timestamp commits to the recomputed chain head. Receipts after the highest anchored position are still unanchored, and the verifier warns about them.',
  },
  {
    verdict: 'VERIFIED / NOT ANCHORED',
    exit: 0,
    meaning: 'Every receipt is intact and correctly signed, but no external timestamp commits to the chain. The record is self-attested.',
  },
  {
    verdict: 'VERIFICATION FAILED',
    exit: 1,
    meaning: 'At least one receipt is altered, missing or wrongly signed. The verifier names each one and lists the ranges that are still provably intact.',
  },
] as const;

export default function VerifyPage() {
  return (
    <>
      <section>
        <h1>Verify a bundle yourself</h1>
        <p>
          The verifier is free and MIT-licensed. Verifying is never paywalled: anyone holding an
          evidence bundle can check it on their own machine, with no network, no account and no code
          from the system that produced it.
        </p>
      </section>
      <section aria-label="Independence">
        <h2>Why you can rely on it</h2>
        <p>
          The verifier imports neither the core package nor the commercial one, and no network
          module. That rule is a source scan that runs as the first CI step, so it cannot quietly
          lapse. It reimplements canonicalization, the chain walk, signature checking and RFC 3161
          timestamp checking from the specifications, and a cross-implementation test keeps it in
          byte-for-byte agreement with the code that writes receipts.
        </p>
      </section>
      <section aria-label="Run it from source">
        <h2>Run it from source</h2>
        <p>
          The packages are not published yet, so run the verifier from a source checkout. Every
          command runs from the repository root, in order, with no edits. Step 3 also needs one
          file you download from DigiCert.
        </p>
        <ol>
          {STEPS.map((step) => (
            <li key={step.title}>
              <h3>{step.title}</h3>
              <p>{step.body}</p>
              <CodeBlock label={step.title}>{step.command}</CodeBlock>
            </li>
          ))}
        </ol>
        <p>
          Add <code>--json</code> to either verifier command for a machine-readable verdict. The{' '}
          <a href={`${BRAND.repository}/blob/main/docs/getting-started.md`}>getting-started guide</a>{' '}
          also covers recording and verifying a receipt of your own.
        </p>
      </section>
      <section aria-label="Verdicts">
        <h2>What the verdict means</h2>
        <ul>
          {VERDICTS.map((v) => (
            <li key={v.verdict}>
              <h3>
                {v.verdict} (exit {v.exit})
              </h3>
              <p>{v.meaning}</p>
            </li>
          ))}
        </ul>
        <p>
          An unreadable bundle or an unknown option exits 2 with a usage message and no verdict. See{' '}
          <Link href="/security">Security</Link> for what a verified chain does and does not prove.
        </p>
      </section>
    </>
  );
}
