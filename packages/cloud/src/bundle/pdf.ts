/**
 * Human-readable evidence report.
 *
 * IMPORTANT FRAMING, and it is stated on the document itself: the PDF is NOT
 * the evidence. The JSON bundle is. A PDF can be edited by anyone with a text
 * editor and carries no cryptography. This document exists so a human -- an
 * auditor, a security reviewer, a regulator -- can understand what the evidence
 * says and how to check it themselves, not so it can be waved around as proof.
 *
 * Selling a beautiful PDF that people mistake for proof would be the dishonest
 * version of this product.
 */
import PDFDocument from 'pdfkit';
import type { Bundle } from '@lacre/verifier';
import { verifyBundle, type VerifyOptions } from '@lacre/verifier';
import { VERIFY_STEPS, verifyCommand, verdictTone, anchorTime, establishes, type Tone } from './report-copy.js';

const INK: Record<Tone, string> = { ok: '#1a7f45', warn: '#8a5a00', bad: '#a11' };
const FILL: Record<Tone, string> = { ok: '#e7f5ec', warn: '#fff6e5', bad: '#fdeaea' };

export interface PdfOptions extends VerifyOptions {
  title?: string;
  organization?: string;
}

export function bundleToPdf(bundle: Bundle, opts: PdfOptions = {}): Promise<Buffer> {
  const verdict = verifyBundle(bundle, opts);
  // Same rule as the HTML report: the headline is the verifier's own verdict
  // name, and an anchor from an authority the reader has not vouched for has
  // its own name and is never shown as good news.
  const tone = verdictTone(verdict);
  const anchoredAt = anchorTime(verdict);
  const doc = new PDFDocument({ size: 'LETTER', margin: 54 });
  const chunks: Buffer[] = [];

  return new Promise((resolve, reject) => {
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const H = (t: string, size = 13) =>
      doc.moveDown(0.8).font('Helvetica-Bold').fontSize(size).fillColor('#111').text(t);
    const P = (t: string, color = '#333') =>
      doc.font('Helvetica').fontSize(9.5).fillColor(color).text(t, { align: 'left' });
    const KV = (k: string, v: string) => {
      doc.font('Helvetica-Bold').fontSize(9).fillColor('#555').text(k, { continued: true });
      doc.font('Courier').fontSize(9).fillColor('#111').text('  ' + v);
    };

    // ---- header ----
    doc.font('Helvetica-Bold').fontSize(20).fillColor('#111').text(opts.title ?? 'Lacre Evidence Report');
    doc.font('Helvetica').fontSize(9).fillColor('#666')
      .text(`${opts.organization ? opts.organization + ' — ' : ''}generated ${new Date().toISOString()}`);
    doc.moveDown(0.5);
    doc.moveTo(54, doc.y).lineTo(558, doc.y).strokeColor('#ddd').stroke();

    // ---- verdict banner ----
    doc.moveDown(0.8);
    const bannerY = doc.y;
    doc.rect(54, bannerY, 504, 26).fill(FILL[tone]);
    doc.fillColor(INK[tone]).font('Helvetica-Bold').fontSize(11).text(verdict.verdict, 62, bannerY + 8, { width: 488 });
    doc.x = 54;
    doc.y = bannerY + 26;
    doc.moveDown(0.6);
    P(verdict.conclusion, '#222');

    // ---- scope ----
    H('Scope');
    KV('Chain', bundle.chain_id ?? 'unknown');
    KV('Receipts', String(verdict.receipts_checked));
    if (verdict.range) KV('Positions', `seq ${verdict.range.from_seq} through ${verdict.range.to_seq}`);
    const s = bundle.summary as Record<string, unknown> | undefined;
    if (verdict.receipt_time_range) {
      KV('Receipts dated', `${verdict.receipt_time_range.first} to ${verdict.receipt_time_range.last}`);
    }
    if (anchoredAt) KV('Anchor time', anchoredAt);
    if (s) {
      KV('Agents', String(s.agent_count ?? '—'));
      KV('Irreversible actions', String(s.irreversible_actions ?? 0));
    }

    // ---- anchors ----
    H('External attestations');
    if (verdict.anchors.length === 0) {
      P('None. Nothing in this bundle is externally anchored, so it proves only that the records are internally consistent with each other. The operator could have produced all of it.', '#8a5a00');
    } else {
      for (const a of verdict.anchors) {
        doc.moveDown(0.3);
        KV('Position', `seq ${a.seq}`);
        KV(
          'Status',
          !a.is_evidence
            ? 'not evidence'
            : a.timestamp?.trusted
              ? 'EVIDENCE — constrains the operator from the attested time on'
              : 'EVIDENCE only once you trust the authority',
        );
        if (a.proven_time) KV('Attested time', a.proven_time);
        if (a.timestamp?.signer) KV('Authority', a.timestamp.signer);
        if (a.timestamp?.chain.top) {
          KV('Chain top', a.timestamp.chain.top.subject);
          KV('  issued by', a.timestamp.chain.top.issuer);
          KV('  fingerprint', a.timestamp.chain.top.fingerprint_sha256);
        }
        if (a.timestamp?.trusted_by) {
          KV('Your trust anchor', a.timestamp.trusted_by.subject);
          KV('  fingerprint', a.timestamp.trusted_by.fingerprint_sha256);
        }
        KV('In your trust list', a.timestamp?.trusted ? 'yes' : 'NO — confirm independently');
        P(a.note, '#555');
      }
    }

    // ---- failures ----
    if (verdict.failures.length) {
      H('Failures');
      for (const f of verdict.failures.slice(0, 40)) {
        doc.moveDown(0.2);
        doc.font('Helvetica-Bold').fontSize(9).fillColor('#a11')
          .text(`${f.seq === null ? 'bundle' : `seq ${f.seq}`} — ${f.kind}`);
        P(f.message, '#333');
        if (f.expected) P(`expected: ${f.expected}`, '#666');
        if (f.actual) P(`actual:   ${f.actual}`, '#666');
      }
      if (verdict.failures.length > 40) P(`… and ${verdict.failures.length - 40} more. See the JSON bundle.`, '#666');
      H('Still provably intact', 11);
      P(verdict.intact_ranges.map((r) => `seq ${r.from_seq}–${r.to_seq}`).join(', ') || 'nothing', '#333');
    }

    // ---- activity ----
    if (s?.by_action) {
      H('Activity by action');
      for (const [action, count] of Object.entries(s.by_action as Record<string, number>).slice(0, 15)) {
        KV(action, String(count));
      }
    }

    // ---- how to check ----
    H('How to verify this yourself');
    P(
      'This PDF is a summary, not the evidence. It has no cryptographic value and anyone can edit it. ' +
      VERIFY_STEPS.before,
      '#222',
    );
    doc.moveDown(0.4);
    doc.font('Courier').fontSize(9).fillColor('#111').text('  ' + verifyCommand('bundle.json'));
    doc.moveDown(0.4);
    P(VERIFY_STEPS.after, '#333');
    doc.moveDown(0.3);
    P(VERIFY_STEPS.independence, '#555');

    H('What this does and does not establish', 11);
    for (const b of establishes(verdict)) P('• ' + b.text, b.emphasis ? INK[b.emphasis] : '#333');

    doc.end();
  });
}
