import { BRAND } from './brand';

/**
 * The facts the Terms, the Privacy Policy, the footer and security.txt need,
 * which only the owner can supply. Every value starts null and is set only from
 * what the owner has supplied; nothing here is invented. While any required value is null, /terms and /privacy say they are a
 * draft not yet in effect and show a bracketed placeholder in each gap, and
 * /.well-known/security.txt lists only SECURITY_REPORT_URL rather than publish a
 * placeholder contact.
 *
 * The page text describes only what the site actually does with data (see the
 * Privacy Policy). Owner and counsel review it before it takes effect.
 */
export interface LegalFacts {
  /** The legal entity that runs the service, e.g. "Example Labs LLC". */
  readonly entityName: string | null;
  /** Its form and jurisdiction, e.g. "a Texas limited liability company". */
  readonly entityJurisdiction: string | null;
  /** Public contact address for customers. */
  readonly contactEmail: string | null;
  /** Address for security reports, used by security.txt. */
  readonly securityEmail: string | null;
  /** Optional postal address, shown in the Terms and Privacy Policy when set. */
  readonly postalAddress: string | null;
  /** When the Terms and Privacy Policy take effect, as YYYY-MM-DD. */
  readonly effectiveDate: string | null;
  /** Days after purchase in which a refund can be requested, or 0 for none. */
  readonly refundWindowDays: number | null;
  /** Governing law and venue, e.g. "the laws of the State of Texas". */
  readonly governingLaw: string | null;
  /** The email provider that delivers sign-in links, named in the Privacy Policy. */
  readonly emailProvider: string | null;
  /** How long contact-form messages are kept, e.g. "12 months". */
  readonly contactRetention: string | null;
  /** How long a bundle buyer's chain file and the bundle made from it are kept, e.g. "12 months". */
  readonly bundleRetention: string | null;
  /** The mailbox provider whose inbox receives chain files by email, named in the Privacy Policy. */
  readonly mailboxProvider: string | null;
  /**
   * Whoever receives a forwarded contact message, if that is not the mailbox
   * provider above: the service CONTACT_FORWARD_URL points at. Optional, because
   * a deployment that cannot send has nobody to name -- but a deployment that
   * can and leaves this null is processing people's details through a company
   * the policy does not disclose. test/privacy-contact.test.ts fails in exactly
   * that state rather than letting it ship quietly.
   */
  readonly contactProcessor: string | null;
}

/**
 * Where to report a vulnerability privately: GitHub private vulnerability
 * reporting on the source repository. It is not an owner-supplied fact and names
 * no person, so it lives outside LEGAL and works while LEGAL.securityEmail is null.
 */
export const SECURITY_REPORT_URL = `${BRAND.repository}/security/advisories/new`;

export const LEGAL: LegalFacts = {
  // Supplied by the owner on 2026-11-10. mailboxProvider hosts the inbox the owner
  // named for chain files (contact@frontierforge.tech); the owner confirmed it.
  entityName: 'Ascella Studios LLC',
  entityJurisdiction: 'a Wisconsin limited liability company',
  contactEmail: 'contact@frontierforge.tech',
  securityEmail: 'contact@frontierforge.tech',
  postalAddress: '408 N Votech Drive, Watertown, WI 53098',
  effectiveDate: '2026-11-14',
  refundWindowDays: 30,
  governingLaw: 'the laws of the State of Wisconsin',
  emailProvider: 'Resend',
  contactRetention: '90 days',
  bundleRetention: '90 days',
  mailboxProvider: 'Microsoft 365 (Exchange Online)',
  // Null while CONTACT_FORWARD_URL is unset, which is production today: no
  // message is forwarded, so there is no recipient to disclose. Whoever it is
  // set to has to be named here in the same change.
  contactProcessor: null,
};

/**
 * Facts the documents cannot take effect without. The postal address is
 * optional, and so is contactProcessor: there is nobody to name until the owner
 * points CONTACT_FORWARD_URL somewhere, and a required fact left null would put
 * a bracketed placeholder on a page that is in effect.
 */
export const REQUIRED_FACTS = [
  'entityName',
  'entityJurisdiction',
  'contactEmail',
  'securityEmail',
  'effectiveDate',
  'refundWindowDays',
  'governingLaw',
  'emailProvider',
  'contactRetention',
  'bundleRetention',
  'mailboxProvider',
] as const satisfies readonly (keyof LegalFacts)[];

export const TERMS_PATH = '/terms';
export const PRIVACY_PATH = '/privacy';

/** The required facts still missing, by name. Empty once the owner has filled them all. */
export function missingFacts(facts: LegalFacts = LEGAL): (keyof LegalFacts)[] {
  return REQUIRED_FACTS.filter((key) => facts[key] === null);
}

/** A fact's value, or a bracketed placeholder naming what the owner must supply. */
export function fact(key: keyof LegalFacts, facts: LegalFacts = LEGAL): string {
  const value = facts[key];
  return value === null ? `[${PLACEHOLDERS[key]}]` : String(value);
}

const PLACEHOLDERS: Record<keyof LegalFacts, string> = {
  entityName: 'legal entity name: owner to supply',
  entityJurisdiction: 'entity form and jurisdiction: owner to supply',
  contactEmail: 'contact email: owner to supply',
  securityEmail: 'security contact email: owner to supply',
  postalAddress: 'postal address: optional, owner to supply',
  effectiveDate: 'effective date: owner to supply',
  refundWindowDays: 'refund window in days: owner to supply',
  governingLaw: 'governing law and venue: owner to supply',
  emailProvider: 'sign-in email provider: owner to supply',
  contactRetention: 'contact message retention: owner to supply',
  bundleRetention: 'chain file and bundle retention: owner to supply',
  mailboxProvider: 'mailbox provider for chain files: owner to supply',
  contactProcessor: 'service that receives contact messages: owner to supply',
};
