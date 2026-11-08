/**
 * The words the PDF and HTML evidence reports share.
 *
 * Both reports are read by people who are not going to run code: auditors,
 * reviewers, regulators. If the two used different words for the same state, or
 * one overclaimed where the other did not, a reader could not cite either. So
 * the headline is the verifier's own verdict name (`BundleVerdict.verdict`) and
 * everything below it comes from here.
 */
import type { BundleVerdict } from '@lacre/verifier';

/**
 * Where the from-source verification steps live. They are the same steps as the
 * site's Verify page. This stays the right place to send a reader after the
 * verifier is published, because the guide covers both.
 */
export const VERIFY_GUIDE_URL = 'https://github.com/JaredKlopstein/lacre/blob/main/docs/getting-started.md';

/** The verifier command, by the name of its executable. `lacre-verify` is what
 *  @lacre/verifier installs, and what the source checkout runs as
 *  `node packages/verifier/bin/lacre-verify.mjs`. */
export function verifyCommand(file: string): string {
  return `lacre-verify ${file} --trust <authority-root.pem>`;
}

/** The paragraphs around the command, in reading order. */
export const VERIFY_STEPS = {
  before:
    'The evidence is the JSON bundle this report was generated from. To check it independently, without ' +
    'trusting whoever operates this system and without a network connection, run the open-source Lacre ' +
    'verifier, lacre-verify (package @lacre/verifier), on that file:',
  after:
    `<authority-root.pem> is the timestamp authority's root certificate, obtained from the authority itself ` +
    `and never taken from the bundle. For DigiCert it is DigiCert Trusted Root G4, which DigiCert publishes ` +
    `on its own site. To run the verifier from a source checkout, follow the steps in ${VERIFY_GUIDE_URL}. ` +
    `Someone technical you trust can run it for you; ask them for the full output.`,
  independence:
    'The verifier is MIT licensed, makes no network connections, and shares no code with the software ' +
    'that produced this bundle. It re-derives every hash and re-checks every signature from the bundle ' +
    'contents alone.',
} as const;

export type Tone = 'ok' | 'warn' | 'bad';

/** Colour of the headline. Only a trusted anchor is good news. */
export function verdictTone(v: BundleVerdict): Tone {
  if (!v.ok) return 'bad';
  return v.verdict === 'VERIFIED / ANCHORED' ? 'ok' : 'warn';
}

/** The time the verdict's anchor proves, for display next to the receipt dates. */
export function anchorTime(v: BundleVerdict): string | null {
  const ev = v.anchors.filter((a) => a.is_evidence && a.proven_time);
  if (ev.length === 0) return null;
  return ev.reduce((best, a) => (a.seq > best.seq ? a : best)).proven_time;
}

export interface Bullet {
  text: string;
  /** Whether the bullet carries the report's warning. */
  emphasis: Tone | null;
}

/** "What this does and does not establish", for every verdict state. */
export function establishes(v: BundleVerdict): Bullet[] {
  const out: Bullet[] = [
    {
      text:
        'It establishes that the receipts in the bundle are internally consistent and were signed by the ' +
        'agent public keys included in this bundle. Those keys come from the bundle itself: nothing here ' +
        'ties a key to a particular system, person or organization, so ask the producer to show you, ' +
        'separately, which system holds each key.',
      emphasis: null,
    },
  ];

  const when = anchorTime(v);
  if (!v.ok) {
    out.push({
      text: 'It does NOT establish that the history is unaltered: verification failed. See the failures above.',
      emphasis: 'bad',
    });
  } else if (!v.anchored) {
    out.push({
      text:
        'It does NOT establish that the history is unaltered. With no external anchor, the operator could have ' +
        'rebuilt everything and it would still verify exactly like this.',
      emphasis: 'warn',
    });
  } else if (v.anchor_authority_trusted) {
    out.push({
      text:
        `It establishes, via a timestamp authority you have told this tool to trust, that this exact history ` +
        `existed at ${when} and has not been altered since ${when}. It does not establish that the history was ` +
        `left alone before that time: until then, whoever held the chain could have rewritten it. Compare ` +
        `${when} with the receipt dates above and with the dates of the actions you are auditing.`,
      emphasis: 'ok',
    });
  } else {
    out.push({
      text:
        'It does not yet establish that the history is unaltered. A timestamp token is present and ' +
        'cryptographically sound, but the authority that signed it is not in your trust list, so nothing ' +
        'here rules out that the signer was chosen by whoever produced this bundle. Get the authority\'s ' +
        'root certificate from the authority itself and run the verifier again with --trust.',
      emphasis: 'warn',
    });
  }

  out.push(
    {
      text:
        'It does not establish that the actions happened as recorded, or that every action was recorded. ' +
        'Receipts are what the agents chose to record about themselves.',
      emphasis: null,
    },
    {
      text:
        'It does not make anyone compliant with any regulation. Lacre produces tamper-evident records that ' +
        'support logging obligations. This is not legal advice.',
      emphasis: null,
    },
  );
  return out;
}
