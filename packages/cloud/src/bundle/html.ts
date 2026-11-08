/**
 * Human-readable evidence report as a single self-contained HTML file.
 *
 * This is the primitive behind the hosted verifier page (Starter and Team).
 * Same framing rule as the PDF, and it is stated on the page itself: this
 * document is NOT the evidence. The JSON bundle is. HTML carries no
 * cryptography and anyone can edit it.
 *
 * Self-contained on purpose -- no external CSS, fonts, scripts or images. An
 * evidence report that phones out to a CDN is an evidence report that stops
 * rendering when the CDN dies, leaks the reader's identity to a third party,
 * and cannot be opened in the air-gapped room where audits actually happen.
 *
 * Everything is escaped. Receipt content is attacker-controlled in the threat
 * model that matters: an agent chooses its own action names and detail, and a
 * hosted verifier page renders bundles uploaded by strangers.
 */
import type { Bundle } from '@lacre/verifier';
import { verifyBundle, type VerifyOptions, type BundleVerdict } from '@lacre/verifier';
import { VERIFY_STEPS, verifyCommand, verdictTone, anchorTime, establishes } from './report-copy.js';

export interface HtmlOptions extends VerifyOptions {
  title?: string;
  organization?: string;
}

/** Escape for HTML text and attribute contexts. */
function esc(v: unknown): string {
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function bundleToHtml(bundle: Bundle, opts: HtmlOptions = {}): string {
  const v = verifyBundle(bundle, opts);
  const title = opts.title ?? 'Lacre Evidence Report';
  // The headline is the verifier's own verdict name, so the CLI, this page, the
  // PDF and /verify all call each state the same thing. An anchor whose
  // authority the reader does not trust has its own name and is never shown as
  // good news.
  const state = verdictTone(v);
  const heading = v.verdict;
  const anchoredAt = anchorTime(v);

  const s = bundle.summary as Record<string, unknown> | undefined;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
  :root {
    color-scheme: light dark;
    --bg:#fbfbfa; --panel:#fff; --ink:#1a1a1a; --muted:#5c5c5c; --line:#e3e3e0;
    --ok-bg:#e7f5ec; --ok-ink:#14653a; --warn-bg:#fff6e5; --warn-ink:#7a4f00;
    --bad-bg:#fdeaea; --bad-ink:#96131b;
    --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg:#151516; --panel:#1d1d1f; --ink:#ececec; --muted:#a2a2a2; --line:#333;
      --ok-bg:#123324; --ok-ink:#6ee7a8; --warn-bg:#332714; --warn-ink:#f5c26b;
      --bad-bg:#3a1618; --bad-ink:#f79a9a;
    }
  }
  * { box-sizing:border-box; }
  body {
    margin:0; background:var(--bg); color:var(--ink);
    font:15px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
    padding:32px 20px;
  }
  main { max-width:820px; margin:0 auto; }
  h1 { font-size:24px; margin:0 0 4px; letter-spacing:-.01em; }
  h2 { font-size:13px; text-transform:uppercase; letter-spacing:.07em;
       color:var(--muted); margin:32px 0 10px; font-weight:600; }
  .sub { color:var(--muted); font-size:13px; margin:0 0 24px; }
  .verdict { border-radius:8px; padding:16px 18px; margin:0 0 20px; }
  .verdict.ok   { background:var(--ok-bg);   color:var(--ok-ink); }
  .verdict.warn { background:var(--warn-bg); color:var(--warn-ink); }
  .verdict.bad  { background:var(--bad-bg);  color:var(--bad-ink); }
  .verdict strong { display:block; font-size:16px; margin-bottom:6px; }
  .verdict p { margin:0; font-size:14px; }
  .panel { background:var(--panel); border:1px solid var(--line); border-radius:8px;
           padding:4px 18px; }
  dl { display:grid; grid-template-columns:minmax(120px,auto) 1fr; gap:0 18px; margin:14px 0; }
  dt { color:var(--muted); font-size:13px; padding:5px 0; }
  dd { margin:0; padding:5px 0; font-family:var(--mono); font-size:13px; word-break:break-all; }
  .anchor { border-top:1px solid var(--line); padding:14px 0; }
  .anchor:first-child { border-top:0; }
  .tag { display:inline-block; font-size:11px; font-weight:600; padding:2px 8px;
         border-radius:99px; letter-spacing:.03em; }
  .tag.ev  { background:var(--ok-bg);  color:var(--ok-ink); }
  .tag.no  { background:var(--warn-bg); color:var(--warn-ink); }
  .fail { border-left:3px solid var(--bad-ink); padding:8px 0 8px 14px; margin:14px 0; }
  .fail .k { font-family:var(--mono); font-size:12px; color:var(--bad-ink); font-weight:600; }
  .fail p { margin:4px 0 0; font-size:14px; }
  pre { background:var(--panel); border:1px solid var(--line); border-radius:6px;
        padding:12px 14px; overflow-x:auto; font-family:var(--mono); font-size:13px; margin:10px 0; }
  .note { font-size:13.5px; color:var(--muted); }
  .note b { color:var(--ink); }
  ul { padding-left:20px; margin:10px 0; font-size:14px; }
  li { margin:6px 0; }
  footer { margin-top:36px; padding-top:16px; border-top:1px solid var(--line);
           font-size:12.5px; color:var(--muted); }
</style>
</head>
<body>
<main>
  <h1>${esc(title)}</h1>
  <p class="sub">${opts.organization ? esc(opts.organization) + ' &middot; ' : ''}generated ${esc(new Date().toISOString())}</p>

  <div class="verdict ${state}">
    <strong>${esc(heading)}</strong>
    <p>${esc(v.conclusion)}</p>
  </div>

  <h2>Scope</h2>
  <div class="panel"><dl>
    <dt>Chain</dt><dd>${esc(bundle.chain_id ?? 'unknown')}</dd>
    <dt>Receipts</dt><dd>${esc(v.receipts_checked)}</dd>
    ${v.range ? `<dt>Positions</dt><dd>seq ${esc(v.range.from_seq)} &ndash; ${esc(v.range.to_seq)}</dd>` : ''}
    ${v.receipt_time_range ? `<dt>Receipts dated</dt><dd>${esc(v.receipt_time_range.first)} &rarr; ${esc(v.receipt_time_range.last)}</dd>` : ''}
    ${anchoredAt ? `<dt>Anchor time</dt><dd>${esc(anchoredAt)}</dd>` : ''}
    ${s ? `<dt>Agents</dt><dd>${esc(s.agent_count ?? '—')}</dd>` : ''}
    ${s ? `<dt>Irreversible</dt><dd>${esc(s.irreversible_actions ?? 0)}</dd>` : ''}
  </dl></div>

  <h2>External attestations</h2>
  ${renderAnchors(v)}

  ${v.failures.length ? `<h2>Failures</h2>${renderFailures(v)}` : ''}

  ${s?.by_action ? `<h2>Activity</h2><div class="panel"><dl>${
    Object.entries(s.by_action as Record<string, number>)
      .slice(0, 20)
      .map(([a, n]) => `<dt>${esc(a)}</dt><dd>${esc(n)}</dd>`)
      .join('')
  }</dl></div>` : ''}

  <h2>Verify this yourself</h2>
  <p class="note">
    <b>This page is a summary, not the evidence.</b> It carries no cryptography and
    anyone can edit it. ${esc(VERIFY_STEPS.before)}
  </p>
  <pre>${esc(verifyCommand('bundle.json'))}</pre>
  <p class="note">${esc(VERIFY_STEPS.after)}</p>
  <p class="note">${esc(VERIFY_STEPS.independence)}</p>

  <h2>What this does and does not establish</h2>
  <ul>
    ${establishes(v).map((b) => `<li>${b.emphasis && b.emphasis !== 'ok' ? `<b>${esc(b.text)}</b>` : esc(b.text)}</li>`).join('\n    ')}
  </ul>

  <footer>
    Lacre &middot; bundle format ${esc(v.format)} &middot; ${esc(v.verdict)}
  </footer>
</main>
</body>
</html>`;
}

function renderAnchors(v: BundleVerdict): string {
  if (v.anchors.length === 0) {
    return `<div class="panel"><p class="note" style="padding:14px 0">
      <b>None.</b> Nothing in this bundle is externally anchored, so it shows only that the
      records are internally consistent with each other. The operator could have produced
      all of it.</p></div>`;
  }
  return `<div class="panel">${v.anchors.map((a) => `
    <div class="anchor">
      <span class="tag ${a.is_evidence ? 'ev' : 'no'}">${a.is_evidence ? 'EVIDENCE' : 'NOT EVIDENCE'}</span>
      <dl>
        <dt>Position</dt><dd>seq ${esc(a.seq)}</dd>
        ${a.proven_time ? `<dt>Attested</dt><dd>${esc(a.proven_time)}</dd>` : ''}
        ${a.timestamp?.signer ? `<dt>Authority</dt><dd>${esc(a.timestamp.signer)}</dd>` : ''}
        ${a.timestamp?.chain.top ? `<dt>Chain top</dt><dd>${esc(a.timestamp.chain.top.subject)}</dd>
        <dt>Issued by</dt><dd>${esc(a.timestamp.chain.top.issuer)}</dd>
        <dt>Fingerprint</dt><dd>${esc(a.timestamp.chain.top.fingerprint_sha256)}</dd>` : ''}
        ${a.timestamp?.trusted_by ? `<dt>Your trust anchor</dt><dd>${esc(a.timestamp.trusted_by.subject)}</dd>
        <dt>Its fingerprint</dt><dd>${esc(a.timestamp.trusted_by.fingerprint_sha256)}</dd>` : ''}
        <dt>In your trust list</dt><dd>${a.timestamp?.trusted ? 'yes' : 'NO — confirm independently'}</dd>
      </dl>
      <p class="note">${esc(a.note)}</p>
    </div>`).join('')}</div>`;
}

function renderFailures(v: BundleVerdict): string {
  const shown = v.failures.slice(0, 50);
  return `<div class="panel" style="padding:14px 18px">
    ${shown.map((f) => `
      <div class="fail">
        <div class="k">${f.seq === null ? 'bundle' : `seq ${esc(f.seq)}`} &middot; ${esc(f.kind)}</div>
        <p>${esc(f.message)}</p>
        ${f.expected ? `<p class="note">expected <code>${esc(f.expected)}</code></p>` : ''}
        ${f.actual ? `<p class="note">actual <code>${esc(f.actual)}</code></p>` : ''}
      </div>`).join('')}
    ${v.failures.length > shown.length ? `<p class="note">&hellip; and ${v.failures.length - shown.length} more; see the JSON bundle.</p>` : ''}
    <p class="note"><b>Still provably intact:</b> ${
      v.intact_ranges.map((r) => `seq ${r.from_seq}&ndash;${r.to_seq}`).join(', ') || 'nothing'
    }</p>
  </div>`;
}
