import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { BRAND } from '../../src/brand';
import { LEGAL, SECURITY_REPORT_URL } from '../../src/legal';
import { CLOUD_MAX_ANCHOR_MINUTES, EARLY_ACCESS_LABEL } from '../../src/plans';
import { PROOF_TABLE } from '../../src/proof-table';

export const metadata: Metadata = {
  title: 'Security',
  description: `The standards ${BRAND.name} is built on, the open-core boundary, what a self-hosted chain does and does not prove, how agent keys are handled, and how to report a vulnerability.`,
};

const STANDARDS = [
  {
    name: 'RFC 8785',
    body: 'JSON Canonicalization Scheme. Every receipt is canonicalized before it is hashed or signed, so the same receipt always produces the same bytes. The verifier implements it separately from the code that writes receipts.',
  },
  {
    name: 'SHA-256',
    body: 'Each receipt carries the SHA-256 hash of the complete receipt before it. Changing any receipt changes its hash, every link after it, and the chain head.',
  },
  {
    name: 'Ed25519',
    body: 'Each receipt is signed with the recording agent’s own key, created locally. The verifier checks every signature against the public keys carried in the bundle.',
  },
  {
    name: 'RFC 9421',
    body: 'HTTP Message Signatures authenticate an agent to the collector with the same key that signs its receipts: method, authority, path and creation time are always covered, a body is covered by its digest, and replays are rejected by a 60-second window and a nonce cache. Receipt submission over HTTP is not built yet; only this authentication layer is.',
  },
  {
    name: 'RFC 3161',
    body: 'Trusted timestamps from an authority the operator does not control anchor the chain head when you buy an evidence bundle, and, once Cloud is available, continuously. The verifier checks the full token offline and reports whether the authority is in your trust list separately from whether the token is sound, because a bundle can embed a self-signed root.',
  },
] as const;

/** The CLI and its store are named after the brand, as on /verify. */
const CLI = BRAND.name.toLowerCase();

/**
 * Where agent keys live and who vouches for them, as packages/core does it today:
 * src/actions/identity.ts (init, keygen, agent register), src/config.ts (the
 * store directory) and src/agents/store.ts (trust on first use).
 */
const KEYS: readonly { readonly name: string; readonly body: ReactNode }[] = [
  {
    name: 'Where the signing key lives',
    body: (
      <>
        <code>{CLI} init</code> creates an Ed25519 key pair and writes it to <code>agent.key.json</code> in the
        store directory: <code>./.{CLI}</code> if that directory exists, otherwise <code>~/.{CLI}</code>, unless{' '}
        <code>--store</code> or <code>{CLI.toUpperCase()}_HOME</code> names another. The file is written with mode
        0600 and holds the secret key unencrypted. There is no HSM or KMS support yet, so protect that file as you
        would any credential.
      </>
    ),
  },
  {
    name: 'It never leaves the machine',
    body: 'Receipts are signed locally. The secret key is never sent or logged: what leaves the machine is signatures and public keys. A bundle is made from your chain file, which holds receipts and public keys, and we never ask for the key.',
  },
  {
    name: 'Registration: trust on first use',
    body: (
      <>
        <code>init</code> registers this machine’s agent against its public key. By default the agent id is derived
        from the key (<code>urn:{CLI}:agent:</code> followed by its RFC 7638 thumbprint), so a different key gives a
        different id. <code>agent register</code> can bind a chosen id, or enrol a remote agent from a public key
        you were given out of band. The first key bound to an id stays bound to it: registering the same id with a
        different key is refused.
      </>
    ),
  },
  {
    name: 'Rotation and revocation',
    body: (
      <>
        Neither exists yet. <code>keygen --force</code> archives the old key file and writes a new key, which is a
        new identity: receipts already written still verify under the old key, but the old id cannot be rebound.
        There is no way to revoke a key. Anyone who holds the key file can sign new receipts as that agent and,
        with database access, rebuild history that is not yet anchored; a rewrite of history already anchored
        still fails verification.
      </>
    ),
  },
  {
    name: 'Who vouches for the public keys in a bundle',
    body: (
      <>
        Only the bundle. The verifier checks each signature against the public key the bundle carries for that
        agent, so a bundle someone built with keys of their own verifies too. Pin your agents’ keys out of band:
        note each key id when you enrol an agent (<code>{CLI} agent list</code> shows it, and every receipt names
        its key in <code>{CLI}.key_id</code>) and compare them with the bundle, the same way you pin the timestamp
        authority’s fingerprint.
      </>
    ),
  },
];

export default function SecurityPage() {
  return (
    <>
      <section>
        <h1>Security</h1>
        <p>
          The standards the receipts are built on, the boundary that keeps verification independent,
          and the honest limits of what a chain proves.
        </p>
      </section>
      <section aria-label="Standards">
        <h2>Standards</h2>
        <ul>
          {STANDARDS.map((s) => (
            <li key={s.name}>
              <h3>{s.name}</h3>
              <p>{s.body}</p>
            </li>
          ))}
        </ul>
        <p>
          The receipt shape aligns with draft-sharif-agent-audit-trail, an individual draft with no
          IETF standing, and departs from it where documented: notably Ed25519 where the draft
          specifies ECDSA P-256. We claim alignment with that draft, nothing more.
        </p>
      </section>
      <section aria-label="Open-core boundary">
        <h2>The open-core boundary</h2>
        <p>
          The code is split into three packages. Core (MIT) records, chains and verifies receipts
          locally. The verifier (MIT) checks evidence bundles offline. The Cloud package (commercial) holds
          the anchoring and bundle export. Core never imports Cloud. The verifier imports neither Core nor Cloud, and
          no network module, so checking the paid tier’s output never requires the paid tier, and it
          runs on an air-gapped machine. These rules are a source scan that runs as the first CI
          step, not a convention.
        </p>
      </section>
      <section aria-label="What a self-hosted chain proves">
        <h2>What a self-hosted chain does and does not prove</h2>
        <p>
          A self-hosted chain is self-attested. It proves internal consistency: every receipt is
          intact, correctly signed and linked to the one before it. It does not prove the operator
          left history alone. An operator with database access and the agents’ signing keys can
          rebuild the whole chain, and local verification will pass. A test in the codebase does
          exactly that, then confirms the anchored bundle still fails, because the one thing the
          operator cannot forge is the timestamp authority’s signature. The local append-only
          database triggers stop application bugs and accidents, not a determined operator.
        </p>
        <table>
          <thead>
            <tr>
              <th scope="col">Property</th>
              <th scope="col">Local chain</th>
              <th scope="col">Anchored chain</th>
            </tr>
          </thead>
          <tbody>
            {PROOF_TABLE.map((row) => (
              <tr key={row.property}>
                <th scope="row">{row.property}</th>
                <td>{row.local}</td>
                <td>{row.anchored}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p>
          The last row is why Cloud ({EARLY_ACCESS_LABEL.toLowerCase()}, not available yet) is planned to
          anchor continuously: new receipts would be batched and the chain head anchored at most every{' '}
          {CLOUD_MAX_ANCHOR_MINUTES} minutes, which bounds the window in which a truncation goes undetected. Receipts also describe only what an agent chose to record; they make recorded
          behavior tamper-evident, not unrecorded behavior visible.
        </p>
        <p>
          <Link href="/verify">Verify a bundle yourself</Link>
        </p>
      </section>
      <section aria-labelledby="keys-and-identity">
        <h2 id="keys-and-identity">Keys and identity</h2>
        <p>
          A receipt’s signature says which key signed it, not who holds that key. This is how agent keys
          are handled today.
        </p>
        <ul>
          {KEYS.map((k) => (
            <li key={k.name}>
              <h3>{k.name}</h3>
              <p>{k.body}</p>
            </li>
          ))}
        </ul>
      </section>
      <section aria-labelledby="report-a-vulnerability">
        <h2 id="report-a-vulnerability">Report a vulnerability</h2>
        <p>
          Report security issues privately through GitHub private vulnerability reporting:{' '}
          <a href={SECURITY_REPORT_URL}>report a vulnerability on GitHub</a>. The report stays private between
          you and the maintainers until an advisory is published. Please do not open a public issue for a
          vulnerability.
          {LEGAL.securityEmail ? (
            <>
              {' '}
              You can also email <a href={`mailto:${LEGAL.securityEmail}`}>{LEGAL.securityEmail}</a>.
            </>
          ) : null}
        </p>
        <p>
          In scope: the code in the source repository, which is Core, the verifier, the Cloud package and this site.
          Anything that lets an altered or forged receipt, chain or bundle verify matters most. The same
          contact is published in <a href="/.well-known/security.txt">/.well-known/security.txt</a>.
        </p>
      </section>
    </>
  );
}
