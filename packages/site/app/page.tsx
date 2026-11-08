import type { Metadata } from 'next';
import Link from 'next/link';
import { BRAND } from '../src/brand';
import {
  BUNDLE_DELIVERY_BUSINESS_DAYS,
  BUNDLE_TODAY_ID,
  EARLY_ACCESS_LABEL,
  GETTING_STARTED_URL,
  OFF_SALE_PLANS,
  WAITLIST_HREF,
  priceCards,
} from '../src/plans';
import { PROOF_TABLE } from '../src/proof-table';
import { ExhibitChain } from '../src/exhibit-chain';
import { StandardsStrip } from '../src/standards-strip';
import styles from '../src/hero.module.css';

export const metadata: Metadata = {
  description: `${BRAND.name}: tamper-evident receipts for AI agents.`,
};

const PROOF_POINTS = [
  {
    title: 'Signed, hash-chained receipts',
    body: 'Each receipt is canonicalized with RFC 8785, chained with SHA-256 and signed with Ed25519, so altering or removing one breaks the chain at that receipt.',
  },
  {
    title: 'RFC 3161 anchoring',
    body: 'When you anchor (with an evidence bundle), the chain head is timestamped by an RFC 3161 timestamp authority the operator does not control, so the record up to that point cannot be quietly rewritten or backdated.',
  },
  {
    title: 'Free offline verifier',
    body: 'The verifier is MIT-licensed, needs no network and no account, and lets anyone check an evidence bundle on their own machine.',
  },
] as const;

/** The bundle's price exactly as the pricing card shows it, from plans.ts rather than typed in. */
const BUNDLE_PRICE = priceCards('monthly').find((card) => card.id === 'bundle')!.price;

export default function HomePage() {
  return (
    <>
      <section aria-labelledby="hero-title" className={styles.hero}>
        <div className={styles.copy}>
          <span className="eyebrow">For teams running AI agents that touch money, mail or customer data</span>
          <h1 id="hero-title">Your agent says it refunded $42.50. Prove it.</h1>
          <p className={styles.lede}>
            Every consequential action gets a signed, hash-chained receipt. Anchor the chain with a timestamp from
            an authority you don’t control, and anyone can verify the record offline, without trusting you.
          </p>
          {/* Links styled as buttons through this wrapper, so the anchors themselves stay plain. */}
          <p className={styles.ctas}>
            <a href={GETTING_STARTED_URL}>Start free</a> <Link href="/pricing">See pricing</Link>
          </p>
          <p className={styles.note}>Open source (MIT). Packages are not on npm yet: run from source.</p>
        </div>
        {/* Exhibit A: three receipts, hashed in the browser (src/exhibit-chain.tsx). */}
        <div data-slot="exhibit" className={styles.slot}>
          <ExhibitChain />
          <p className={styles.note}>
            The anchor row compares the recomputed head with the head that was timestamped. The timestamp
            token and the agent’s public key are not on this page, so the anchor and the signatures can’t be
            checked here. To check a DigiCert anchor yourself, verify the sample bundle in the repository, a
            separate three-receipt chain, with the offline verifier: <Link href="/verify">Verify a bundle</Link>.
          </p>
        </div>
      </section>
      <StandardsStrip />
      <section aria-label="Proof points">
        <ul>
          {PROOF_POINTS.map((point) => (
            <li key={point.title}>
              <h2>{point.title}</h2>
              <p>{point.body}</p>
            </li>
          ))}
        </ul>
      </section>
      <section aria-labelledby="proof-table-title">
        <h2 id="proof-table-title">Once anchored, history up to the anchor can’t be rewritten: not by your agents, and not by you.</h2>
        <p>
          Before an anchor, a chain is self-attested: it proves internal consistency, not that history was left
          alone. The table shows exactly where the line falls.
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
          <Link href="/security">What each row means</Link>
        </p>
      </section>
      <section aria-labelledby="today-title">
        <h2 id="today-title">What you can get today</h2>
        <p>
          <strong>{BRAND.name} Core: free.</strong> Record, chain and verify receipts on your own machine, and check
          evidence bundles with the offline verifier. MIT-licensed. Run it from source: the packages are not on npm
          yet.
        </p>
        <p>
          <strong>Evidence bundle: {BUNDLE_PRICE}.</strong> We timestamp the head of your chain with a public RFC 3161
          authority and email the bundle back within {BUNDLE_DELIVERY_BUSINESS_DAYS} business days. It is made by
          hand today (<Link href={`/pricing#${BUNDLE_TODAY_ID}`}>how a bundle is made</Link>), and it proves the chain
          existed when it was anchored, not earlier.
        </p>
        {OFF_SALE_PLANS.has('cloud') ? (
          <p>
            <strong>Cloud: {EARLY_ACCESS_LABEL.toLowerCase()}.</strong> Continuous anchoring is planned, not available
            yet. <Link href={WAITLIST_HREF}>Join the waitlist</Link>.
          </p>
        ) : null}
        <p className={styles.ctas}>
          <a href={GETTING_STARTED_URL}>Getting started (GitHub)</a> <Link href="/verify">Verify a bundle</Link>
        </p>
      </section>
    </>
  );
}
