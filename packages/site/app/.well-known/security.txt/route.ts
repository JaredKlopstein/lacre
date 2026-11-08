/**
 * /.well-known/security.txt (RFC 9116): where to report a security issue.
 *
 * The Contact is GitHub private vulnerability reporting on the source repository
 * (SECURITY_REPORT_URL), which needs no owner-supplied address. Once the owner
 * sets LEGAL.securityEmail it is listed first, as the preferred contact; nothing
 * is published in its place while it is null. Canonical and Policy need the
 * site's own https origin, so they appear only once BRAND.domain is set.
 * Expires is required by the RFC and is set 180 days after the build, so each
 * deploy renews it.
 */
import { BRAND } from '../../../src/brand';
import { LEGAL, SECURITY_REPORT_URL } from '../../../src/legal';

/** How long a published security.txt stays valid. RFC 9116 advises under a year. */
const VALID_DAYS = 180;

/** The site's https origin, or null while no domain is attached. */
function siteOrigin(): string | null {
  const host = BRAND.domain;
  return host && URL.canParse(`https://${host}`) ? new URL(`https://${host}`).origin : null;
}

export function GET(): Response {
  const expires = new Date(Date.now() + VALID_DAYS * 24 * 60 * 60 * 1000);
  const origin = siteOrigin();
  const lines = [
    ...(LEGAL.securityEmail ? [`Contact: mailto:${LEGAL.securityEmail}`] : []),
    `Contact: ${SECURITY_REPORT_URL}`,
    `Expires: ${expires.toISOString().replace(/\.\d{3}Z$/, 'Z')}`,
    ...(origin
      ? [`Canonical: ${origin}/.well-known/security.txt`, `Policy: ${origin}/security#report-a-vulnerability`]
      : []),
    'Preferred-Languages: en',
    '',
  ];
  return new Response(lines.join('\n'), { headers: { 'content-type': 'text/plain; charset=utf-8' } });
}
