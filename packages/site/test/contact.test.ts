import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { POST } from '../app/api/contact/route.js';
import EnterprisePage, { generateMetadata } from '../app/enterprise/page.js';
import { CONTACT_IP_LIMIT, UNKNOWN_CONTACT_IP_BUCKET } from '../src/auth/rate-limit.js';
import { usedTokenSchema } from '../src/auth/used-tokens.js';
import { BRAND } from '../src/brand.js';
import { CONTACT_CODES, CONTACT_OUTCOMES, FLEET_SIZES, HONEYPOT_FIELD } from '../src/contact.js';
import { LEGAL } from '../src/legal.js';
import { AnnounceOutcome, KeepFields, keepFields, type KeepOptions } from '../src/form-outcome.js';
import { browser, propsOf } from './page-tree.js';

/**
 * The enterprise contact route emails one submission to LEGAL.contactEmail
 * through the provider the EMAIL_API_* variables configure. fetch is mocked
 * throughout: nothing here touches the network, and no value below is a real
 * credential. The rate limit's Postgres is PGlite, in process, behind the Neon
 * driver's drizzle().
 */

const pgHolder = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('drizzle-orm/neon-serverless', () => ({ drizzle: vi.fn(() => pgHolder.db) }));

const RATE_MIGRATION = new URL('../migrations/0001_magic_link_rate.sql', import.meta.url);
const DATABASE_URL = ['postgresql:', '', 'test-user:test-password@db.site.test', 'site'].join('/');
const EMAIL_API_URL = 'https://provider.example.test/emails';
/** Not a credential: a fixture, checked below for never leaving the process. */
const EMAIL_API_KEY = 'fixture-not-a-real-key-0000';
const EMAIL_FROM = 'site@site.test';
/** The three variables a send needs, as the route reads them. */
const EMAIL_ENV = { EMAIL_API_URL, EMAIL_API_KEY, EMAIL_FROM } as const;
const VALID = {
  name: 'Ada Lovelace',
  email: 'ada@example.com',
  company: 'Analytical Engines Ltd',
  fleetSize: '11-100',
  need: 'Contracted retention for receipts from our support agents.',
};

let pg: PGlite;
let fetchMock: Mock;
let logged: string[];

beforeAll(async () => {
  pg = await PGlite.create();
  await pg.exec(readFileSync(RATE_MIGRATION, 'utf8'));
  pgHolder.db = drizzle({ client: pg, schema: usedTokenSchema });
});
afterAll(async () => {
  await pg.close();
});

beforeEach(async () => {
  await pg.exec('TRUNCATE site_magic_link_rate');
  fetchMock = vi.fn(async () => new Response('ok', { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  logged = [];
  for (const level of ['error', 'warn', 'log', 'info'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(' '));
    });
  }
  for (const [name, value] of Object.entries(EMAIL_ENV)) vi.stubEnv(name, value);
  vi.stubEnv('DATABASE_URL', DATABASE_URL);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const postJson = (body: unknown, headers: Record<string, string> = {}) =>
  POST(
    new Request('http://site.test/api/contact', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  );

const postForm = (fields: Record<string, string>, headers: Record<string, string> = {}) =>
  POST(
    new Request('http://site.test/api/contact', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
      body: new URLSearchParams(fields).toString(),
    }),
  );

/** The response body, its headers and every log line: everywhere a value could leak. */
async function exposed(res: Response): Promise<string> {
  return [await res.clone().text(), JSON.stringify([...res.headers]), ...logged].join('\n');
}

/** The body the route handed the provider, parsed. */
function sendBody(call = 0): { from: string; to: string; subject: string; text: string } {
  const [, init] = fetchMock.mock.calls[call] as [string, RequestInit];
  return JSON.parse(String(init.body));
}

describe('valid submission', () => {
  it('emails the fields to the contact address through the provider and answers 200', async () => {
    const res = await postJson(VALID);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(EMAIL_API_URL);
    expect(init.method).toBe('POST');
    // The key travels in the Authorization header, which is where the provider
    // documents it and the only place it may appear.
    expect(new Headers(init.headers)).toEqual(
      new Headers({ 'content-type': 'application/json', authorization: `Bearer ${EMAIL_API_KEY}` }),
    );

    const sent = sendBody();
    expect(sent.from).toBe(EMAIL_FROM);
    // The address the Privacy Policy publishes, not one invented here.
    expect(sent.to).toBe(LEGAL.contactEmail);
    expect(sent).not.toHaveProperty(HONEYPOT_FIELD);
  });

  it('carries all five fields and the timestamp in the message', async () => {
    await postJson(VALID);
    const { subject, text } = sendBody();
    // Findable in a mailbox list from the subject alone: what it is, who from, how big.
    expect(subject).toContain(BRAND.name);
    expect(subject).toContain(VALID.company);
    expect(subject).toContain(VALID.fleetSize);
    for (const value of Object.values(VALID)) expect(text, value).toContain(value);
    // The submitted-at line is an ISO instant, and the message says where to reply.
    expect(text).toMatch(/^Submitted: \d{4}-\d{2}-\d{2}T[\d:.]+Z$/m);
    expect(text).toContain(`Reply to ${VALID.email}.`);
  });

  it('keeps a typed newline out of the subject, so no header can be injected', async () => {
    await postJson({ ...VALID, company: 'Analytical\r\nBcc: spy@example.test\nEngines' });
    const { subject, text } = sendBody();
    expect(subject).not.toMatch(/[\r\n]/);
    expect(subject).toContain('Analytical Bcc: spy@example.test Engines');
    // The body is a body: it may hold what was typed, newlines and all.
    expect(text).toContain('Bcc: spy@example.test');
  });

  it('shortens an over-long company in the subject but keeps it whole in the body', async () => {
    const company = 'C'.repeat(200);
    await postJson({ ...VALID, company });
    const { subject, text } = sendBody();
    expect(subject.length).toBeLessThan(200);
    expect(subject).toContain('\u2026');
    expect(text).toContain(company);
  });

  it('accepts every fleet size the form offers', async () => {
    for (const fleetSize of FLEET_SIZES) {
      expect((await postJson({ ...VALID, fleetSize })).status, fleetSize).toBe(200);
    }
    expect(fetchMock).toHaveBeenCalledTimes(FLEET_SIZES.length);
  });

  it('redirects a native form post back to the page with the outcome', async () => {
    const res = await postForm({ ...VALID, [HONEYPOT_FIELD]: '' });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/enterprise?contact=sent');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  /**
   * The route now holds a credential where it held none: EMAIL_API_KEY. It
   * belongs in exactly one place, the Authorization header of the send, and
   * nowhere a visitor or a log reader can see it.
   */
  it('never puts the provider key in a response, a header or a log line', async () => {
    const responses = [
      await postJson(VALID),
      await postJson({ email: 'nope' }),
      await postJson({ ...VALID, [HONEYPOT_FIELD]: 'filled' }),
      await postForm(VALID),
    ];
    fetchMock.mockRejectedValueOnce(new TypeError(`fetch failed: ${EMAIL_API_URL} key=${EMAIL_API_KEY}`));
    responses.push(await postJson(VALID));
    fetchMock.mockResolvedValueOnce(new Response(`rejected key ${EMAIL_API_KEY}`, { status: 401 }));
    responses.push(await postJson(VALID));
    for (const res of responses) {
      expect(await exposed(res)).not.toContain(EMAIL_API_KEY);
    }
    // And the send did carry it, so the assertion above is not vacuous.
    expect(JSON.stringify(fetchMock.mock.calls)).toContain(EMAIL_API_KEY);
  });
});

describe('invalid submission', () => {
  it('names every missing required field and forwards nothing', async () => {
    const res = await postJson({ email: VALID.email });
    expect(res.status).toBe(400);
    const { error } = await res.json();
    expect(error.code).toBe('INVALID_INPUT');
    expect(error.message).toContain('name, company, fleetSize, need');
    expect(error.fix.note).toContain('fleetSize');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('treats whitespace-only fields as missing', async () => {
    const res = await postJson({ ...VALID, company: '   ' });
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toContain('company');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['ada', 'ada@', '@example.com', 'ada@example', 'ada lovelace@example.com', 'ada@@example.com'])(
    'rejects the email %j',
    async (email) => {
      const res = await postJson({ ...VALID, email });
      expect(res.status).toBe(400);
      expect((await res.json()).error.message).toContain('email');
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('rejects a fleet size the form does not offer', async () => {
    const res = await postJson({ ...VALID, fleetSize: 'lots' });
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toContain('fleetSize must be one of');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects an over-long field', async () => {
    const res = await postJson({ ...VALID, name: 'a'.repeat(201) });
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a body that is not a JSON object', async () => {
    for (const body of ['not json', '[1,2]', 'null']) {
      const res = await postJson(body);
      expect(res.status, body).toBe(400);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects an oversized body', async () => {
    const res = await postJson({ ...VALID, need: 'x'.repeat(20 * 1024) });
    expect(res.status).toBe(413);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('redirects an invalid form post back with contact=invalid and the fields that failed', async () => {
    const res = await postForm({ ...VALID, email: 'not-an-email' });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/enterprise?contact=invalid&fields=email');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('names every failing field, by key and in form order, and nothing typed (persona review, Sam 8)', async () => {
    const location = async (fields: Record<string, string>) => (await postForm(fields)).headers.get('location');
    expect(await location({ ...VALID, company: '  ', fleetSize: 'lots', name: 'n'.repeat(201) })).toBe(
      '/enterprise?contact=invalid&fields=name,company,fleetSize',
    );
    expect(await location({ email: 'ada@example.com' })).toBe('/enterprise?contact=invalid&fields=name,company,fleetSize,need');
    // An oversized body is the message field's fault.
    expect(await location({ ...VALID, need: 'x'.repeat(20 * 1024) })).toBe('/enterprise?contact=invalid&fields=need');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('honeypot', () => {
  it('answers a filled honeypot like a success and forwards nothing', async () => {
    const res = await postJson({ ...VALID, [HONEYPOT_FIELD]: 'https://spam.example' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does the same for a form post, even when the other fields are junk', async () => {
    const res = await postForm({ name: 'x', [HONEYPOT_FIELD]: 'filled' });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/enterprise?contact=sent');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('the email provider is not configured', () => {
  /** The response body and headers only, without the log. */
  const answered = async (res: Response) => [await res.clone().text(), JSON.stringify([...res.headers])].join('\n');

  /** The request id the response carries, after checking the log names `blamed` under it. */
  const requestIdLogged = (res: Response, blamed: string) => {
    const requestId = res.headers.get('x-request-id');
    expect(requestId).toBeTruthy();
    expect(logged.some((line) => line.includes(String(requestId)) && line.includes(blamed))).toBe(true);
    return requestId;
  };

  it('returns a generic 503 with a request id and sends nothing', async () => {
    vi.stubEnv('EMAIL_API_KEY', '');
    const res = await postJson(VALID);
    expect(res.status).toBe(503);
    const requestId = requestIdLogged(res, 'EMAIL_API_KEY');
    const body = await res.clone().json();
    expect(body.requestId).toBe(requestId);
    expect(body.error.code).toBe(CONTACT_CODES.notConfigured);
    expect(body.error.message).toBe('This site cannot take messages yet. Nothing was sent.');
    // Not retryable, and the code says which of the two 503s this is, so the
    // waitlist can tell them apart from the answer alone.
    expect(body.error.retryable).toBe(false);
    expect(body.error.fix.note).toContain(BRAND.repository);
    expect(body.error.fix.note).toContain(String(requestId));
    // The answer names no variable, and above all no value.
    for (const name of Object.keys(EMAIL_ENV)) expect(await answered(res)).not.toContain(name);
    expect(await exposed(res)).not.toContain(EMAIL_API_KEY);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  /**
   * Any one of the three missing is enough, in both directions: a key set with
   * the endpoint missing is as unsendable as the reverse. Each is driven on its
   * own, and the log names the ones that are actually missing.
   */
  it.each(Object.keys(EMAIL_ENV))('refuses when only %s is unset, and blames just that one', async (name) => {
    vi.stubEnv(name, '');
    const res = await postJson(VALID);
    expect(res.status).toBe(503);
    expect((await res.clone().json()).error.code).toBe(CONTACT_CODES.notConfigured);
    requestIdLogged(res, name);
    for (const other of Object.keys(EMAIL_ENV)) {
      if (other !== name) expect(logged.join('\n'), other).not.toContain(other);
    }
    expect(await answered(res)).not.toContain(name);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(Object.keys(EMAIL_ENV))('treats %s missing the same as empty', async (name) => {
    delete process.env[name];
    const res = await postJson(VALID);
    expect(res.status).toBe(503);
    requestIdLogged(res, name);
    expect(await answered(res)).not.toContain(name);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses when all three are unset and names all three', async () => {
    for (const name of Object.keys(EMAIL_ENV)) vi.stubEnv(name, '');
    const res = await postJson(VALID);
    expect(res.status).toBe(503);
    const requestId = requestIdLogged(res, 'EMAIL_API_URL');
    for (const name of Object.keys(EMAIL_ENV)) {
      expect(logged.some((line) => line.includes(String(requestId)) && line.includes(name)), name).toBe(true);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('redirects a form post back with contact=not_configured and a request id', async () => {
    delete process.env.EMAIL_API_URL;
    const res = await postForm(VALID);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/enterprise?contact=not_configured');
    requestIdLogged(res, 'EMAIL_API_URL');
    expect(await answered(res)).not.toContain('EMAIL_API_URL');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['http://provider.example.test/emails', 'ftp://provider.example.test/emails', 'javascript:alert(1)', 'provider.example.test/emails'])(
    'treats the endpoint %j as unset, without logging the value',
    async (value) => {
      vi.stubEnv('EMAIL_API_URL', value);
      const res = await postJson(VALID);
      expect(res.status).toBe(503);
      expect(fetchMock).not.toHaveBeenCalled();
      const requestId = requestIdLogged(res, 'EMAIL_API_URL');
      // The log says what is wrong with it, by variable name only.
      expect(logged.join('\n')).toContain('is not an https URL');
      expect((await res.clone().json()).requestId).toBe(requestId);
      expect(await answered(res)).not.toContain('EMAIL_API_URL');
      expect(await exposed(res)).not.toContain(value);
    },
  );

  it('answers a form post the same way when the endpoint is not https', async () => {
    vi.stubEnv('EMAIL_API_URL', 'javascript:alert(1)');
    const res = await postForm(VALID);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/enterprise?contact=not_configured');
    requestIdLogged(res, 'EMAIL_API_URL');
    expect(await answered(res)).not.toContain('EMAIL_API_URL');
    expect(await exposed(res)).not.toContain('alert');
  });

  /**
   * The destination is a fact in src/legal.ts, not a variable, and it is typed
   * `string | null`. A deployment that has not published a contact address has
   * nowhere to send a submission, which is the same dead end as an unset
   * variable and must get the same not-retryable answer rather than a 500.
   */
  it('refuses the same way when there is no contact address to send to', async () => {
    const facts = LEGAL as { -readonly [K in keyof typeof LEGAL]: (typeof LEGAL)[K] };
    const before = facts.contactEmail;
    facts.contactEmail = null;
    try {
      const res = await postJson(VALID);
      expect(res.status).toBe(503);
      const body = await res.clone().json();
      expect(body.error.code).toBe(CONTACT_CODES.notConfigured);
      expect(body.error.retryable).toBe(false);
      requestIdLogged(res, 'contactEmail');
      expect(fetchMock).not.toHaveBeenCalled();

      const formRes = await postForm(VALID);
      expect(formRes.headers.get('location')).toBe('/enterprise?contact=not_configured');
    } finally {
      facts.contactEmail = before;
    }
  });
});

describe('rate limit', () => {
  const VERCEL_IP = (ip: string) => ({ 'x-vercel-forwarded-for': ip });
  const buckets = async () =>
    (await pg.query<{ bucket: string; count: number }>('SELECT bucket, count FROM site_magic_link_rate')).rows;
  /** The response body and headers only, without the log. */
  const answered = async (res: Response) => [await res.clone().text(), JSON.stringify([...res.headers])].join('\n');

  it(`forwards ${CONTACT_IP_LIMIT} submissions from one IP in a window and refuses the next with 429`, async () => {
    for (let i = 0; i < CONTACT_IP_LIMIT; i++) {
      expect((await postJson(VALID, VERCEL_IP('203.0.113.7'))).status).toBe(200);
    }
    expect(fetchMock).toHaveBeenCalledTimes(CONTACT_IP_LIMIT);

    const res = await postJson(VALID, VERCEL_IP('203.0.113.7'));
    expect(res.status).toBe(429);
    const { error } = await res.json();
    expect(error).toMatchObject({ code: 'RATE_LIMITED', retryable: true });
    expect(error.message).toContain('Nothing was sent.');
    expect(error.fix.note).toBe('Please try again in a few minutes.');
    expect(fetchMock).toHaveBeenCalledTimes(CONTACT_IP_LIMIT);
  });

  it('redirects an over-limit form post back with contact=rate_limited and forwards nothing', async () => {
    for (let i = 0; i < CONTACT_IP_LIMIT; i++) await postForm(VALID, VERCEL_IP('203.0.113.7'));
    const res = await postForm(VALID, VERCEL_IP('203.0.113.7'));
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/enterprise?contact=rate_limited');
    expect(fetchMock).toHaveBeenCalledTimes(CONTACT_IP_LIMIT);
  });

  it('counts each IP separately', async () => {
    for (let i = 0; i < CONTACT_IP_LIMIT; i++) await postJson(VALID, VERCEL_IP('203.0.113.7'));
    expect((await postJson(VALID, VERCEL_IP('198.51.100.1'))).status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(CONTACT_IP_LIMIT + 1);
  });

  it('does not let a spoofed x-forwarded-for reset the IP bucket', async () => {
    for (let i = 0; i <= CONTACT_IP_LIMIT; i++) {
      await postJson(VALID, { ...VERCEL_IP('203.0.113.7'), 'x-forwarded-for': `192.0.2.${i}` });
    }
    expect(fetchMock).toHaveBeenCalledTimes(CONTACT_IP_LIMIT);
  });

  it('pools requests without a trusted IP header into one shared bucket', async () => {
    for (let i = 0; i <= CONTACT_IP_LIMIT; i++) await postJson(VALID, { 'x-forwarded-for': `192.0.2.${i}` });
    expect(fetchMock).toHaveBeenCalledTimes(CONTACT_IP_LIMIT);
    expect((await buckets()).map((r) => r.bucket)).toEqual([UNKNOWN_CONTACT_IP_BUCKET]);
  });

  it('does not count honeypot or invalid submissions against the bucket', async () => {
    for (let i = 0; i < CONTACT_IP_LIMIT * 2; i++) {
      await postJson({ ...VALID, [HONEYPOT_FIELD]: 'filled' }, VERCEL_IP('203.0.113.7'));
      await postJson({ ...VALID, email: 'not-an-email' }, VERCEL_IP('203.0.113.7'));
    }
    expect(await buckets()).toEqual([]);
    expect((await postJson(VALID, VERCEL_IP('203.0.113.7'))).status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('fails closed with a generic retryable 503 when DATABASE_URL is unset', async () => {
    vi.stubEnv('DATABASE_URL', '');
    const res = await postJson(VALID);
    expect(res.status).toBe(503);
    const requestId = res.headers.get('x-request-id');
    const body = await res.clone().json();
    expect(body.requestId).toBe(requestId);
    expect(body.error).toMatchObject({ code: 'CONTACT_UNAVAILABLE', retryable: true });
    expect(body.error.message).toContain("We couldn't take your message right now. Please try again in a few minutes.");
    expect(await answered(res)).not.toContain('DATABASE_URL');
    expect(logged.some((line) => line.includes(String(requestId)) && line.includes('DATABASE_URL'))).toBe(true);

    const formRes = await postForm(VALID);
    expect(formRes.status).toBe(303);
    expect(formRes.headers.get('location')).toBe('/enterprise?contact=unavailable');
    expect(await answered(formRes)).not.toContain('DATABASE_URL');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails closed with a generic retryable 503 when the limiter store errors', async () => {
    await pg.exec('ALTER TABLE site_magic_link_rate RENAME TO site_magic_link_rate_moved');
    try {
      const res = await postJson(VALID);
      expect(res.status).toBe(503);
      const requestId = res.headers.get('x-request-id');
      expect((await res.clone().json()).error).toMatchObject({ code: 'CONTACT_UNAVAILABLE', retryable: true });
      expect(logged.some((line) => line.includes(String(requestId)) && line.includes('42P01'))).toBe(true);
      for (const name of ['DATABASE_URL', 'site_magic_link_rate', 'migrations']) {
        expect(await answered(res)).not.toContain(name);
      }

      const formRes = await postForm(VALID);
      expect(formRes.headers.get('location')).toBe('/enterprise?contact=unavailable');
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      await pg.exec('ALTER TABLE site_magic_link_rate_moved RENAME TO site_magic_link_rate');
    }
  });
});

describe('send failure', () => {
  it('returns 502 when the provider rejects, without echoing or logging the endpoint', async () => {
    fetchMock.mockResolvedValueOnce(new Response(`bad request to ${EMAIL_API_URL}`, { status: 400 }));
    const res = await postJson(VALID);
    expect(res.status).toBe(502);
    const body = await res.clone().json();
    expect(body.error).toMatchObject({ code: 'CONTACT_FORWARD_FAILED', retryable: true });
    expect(logged.join('\n')).toContain('HTTP 400');
    expect(logged.join('\n')).toContain('contact:');
    expect(await exposed(res)).not.toContain('provider.example.test');
  });

  it('returns 502 when fetch throws, even if the error message carries the endpoint', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError(`fetch failed: ${EMAIL_API_URL}`));
    const res = await postJson(VALID);
    expect(res.status).toBe(502);
    expect(logged.join('\n')).toContain('TypeError');
    expect(await exposed(res)).not.toContain('provider.example.test');
  });

  it('redirects a form post back with contact=failed', async () => {
    fetchMock.mockRejectedValueOnce(new Error('down'));
    const res = await postForm(VALID);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/enterprise?contact=failed');
  });
});

describe('enterprise page', () => {
  const render = async (contact?: string) =>
    renderToStaticMarkup(await EnterprisePage({ searchParams: Promise.resolve(contact ? { contact } : {}) }));

  it('posts a form with every required field to the contact route', async () => {
    const html = await render();
    expect(html).toContain('action="/api/contact"');
    expect(html).toContain('method="post"');
    // React does not keep attribute order, so find each element and then check it.
    const field = (name: string) =>
      new RegExp(`<(input|select|textarea)\\b[^>]*\\bname="${name}"[^>]*>`).exec(html)?.[0] ?? '';
    for (const name of ['name', 'email', 'company', 'fleetSize', 'need']) {
      expect(field(name), name).toContain('required=""');
    }
    expect(field('email')).toContain('type="email"');
    for (const size of FLEET_SIZES) expect(html).toContain(`value="${size}"`);
  });

  it('carries an off-screen honeypot that is not marked required', async () => {
    const html = await render();
    const honeypot = new RegExp(`<input[^>]*name="${HONEYPOT_FIELD}"[^>]*>`).exec(html)?.[0];
    expect(honeypot).toBeDefined();
    expect(honeypot).toContain('tabindex="-1"');
    expect(honeypot).not.toContain('required');
    expect(html).toMatch(/aria-hidden="true" style="position:absolute;left:-10000px/);
  });

  it('says when the team will reply', async () => {
    expect(await render()).toContain('We reply within two business days.');
  });

  it('shows no dollar figure', async () => {
    expect(await render()).not.toMatch(/\$\s*\d|USD|per month|\/mo\b/i);
  });

  it('takes brand text from BRAND', async () => {
    const metadata = await generateMetadata({ searchParams: Promise.resolve({}) });
    expect(metadata.title).toBe('Enterprise');
    expect(metadata.description).toContain(BRAND.name);
  });

  it('shows the outcome a form post redirected back with, and nothing for an unknown one', async () => {
    expect(await render('sent')).toContain(
      `<p id="contact-outcome" role="status" tabindex="-1" data-outcome="sent">Thanks. The ${BRAND.name} team has your message`,
    );
    expect(await render('unavailable')).toContain('unavailable right now, so nothing was sent. Try again in a few minutes');
    expect(await render('not_configured')).toContain('not able to send messages yet, so nothing was sent');
    expect(await render('rate_limited')).toContain('Please try again in a few minutes.');
    for (const outcome of ['invalid', 'not_configured', 'unavailable', 'failed', 'rate_limited']) {
      expect(await render(outcome), outcome).toMatch(/<p id="contact-outcome" role="alert" tabindex="-1"/);
    }
    expect(await render('<script>')).not.toMatch(/role="(status|alert)"/);
    expect(await render()).not.toMatch(/role="(status|alert)"/);
  });

  it('links the public repository when the form cannot take a message, and invents no email (persona review, Marcus 7)', async () => {
    for (const outcome of ['not_configured', 'unavailable', 'failed']) {
      const html = await render(outcome);
      expect(html, outcome).toContain(`<a href="${BRAND.repository}">the ${BRAND.name} GitHub repository</a>`);
      expect(html, outcome).not.toMatch(/mailto:/);
    }
  });

  const tree = (params: Record<string, string>) => EnterprisePage({ searchParams: Promise.resolve(params) });
  const FIELD_IDS = ['contact-name', 'contact-email', 'contact-company', 'contact-fleet', 'contact-need'];

  it('keeps every typed value through a failed send, and none after a sent one (persona review, Marcus 7)', async () => {
    for (const [outcome, kept] of [['not_configured', true], ['unavailable', true], ['invalid', true], ['failed', true], ['rate_limited', true], ['sent', false]] as const) {
      const storage = new Map<string, string>();
      const [first] = propsOf<KeepOptions>(await tree({}), KeepFields);
      expect(first).toEqual({ formId: 'contact-form', fieldIds: FIELD_IDS, storageKey: 'contact-fields', restore: false });
      const before = browser(storage, first!.formId, first!.fieldIds);
      keepFields(before.doc, before.storage, first!);
      const typed = ['Ada', 'ada@example.com', 'Analytical Engines', '11-100', 'A long message.'];
      FIELD_IDS.forEach((id, i) => (before.fields[id]!.value = typed[i]!));
      before.submit();

      const [next] = propsOf<KeepOptions>(await tree({ contact: outcome }), KeepFields);
      const after = browser(storage, next!.formId, next!.fieldIds);
      keepFields(after.doc, after.storage, next!);
      expect(FIELD_IDS.map((id) => after.fields[id]!.value), outcome).toEqual(kept ? typed : ['', '', '', '', '']);
      expect(storage.size, outcome).toBe(0);
    }
    // The honeypot is never kept.
    expect(FIELD_IDS).not.toContain('contact-website');
  });

  it('focuses the outcome and puts it first in the title (persona review, Sam 1)', async () => {
    expect(propsOf(await tree({ contact: 'unavailable' }), AnnounceOutcome)).toEqual([{ targetId: 'contact-outcome' }]);
    expect(propsOf(await tree({}), AnnounceOutcome)).toEqual([]);
    const title = async (params: Record<string, string>) => (await generateMetadata({ searchParams: Promise.resolve(params) })).title;
    expect(await title({ contact: 'unavailable' })).toBe('Contact form unavailable · Enterprise');
    expect(await title({ contact: 'invalid', fields: 'email' })).toBe('Error: check the marked fields · Enterprise');
    expect(await title({ contact: 'sent' })).toBe('Message sent · Enterprise');
    expect(await title({ contact: '<script>' })).toBe('Enterprise');
  });
});

/**
 * The invariant behind the fix, checked against both sides' real output rather
 * than against a table typed here.
 *
 * Before it, the form and the JSON API disagreed about the same event: the JSON
 * answer for an unconfigured sender said `retryable: false`, and the page
 * the form post landed on said "Try again in a few minutes". The cause is an
 * unset variable, so a visitor could retry for as long as they were willing and
 * never be heard -- and no signup existed anywhere to show they had tried.
 *
 * So: for each failure the route can produce, take the outcome a form post is
 * redirected to and the retryable flag the JSON answer carries, from the route
 * itself, then render the page at that outcome. The page may offer a retry only
 * where the route says retrying can work.
 */
describe('the page offers a retry only where the route says one can work', () => {
  const render = async (contact: string) =>
    renderToStaticMarkup(await EnterprisePage({ searchParams: Promise.resolve({ contact }) }))
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ');

  /** One scenario, driven both ways: what a form post lands on, and what the JSON answer claims. */
  async function bothWays(): Promise<{ outcome: string; retryable: boolean }> {
    const body = await (await postJson(VALID)).json();
    const location = (await postForm(VALID)).headers.get('location');
    const outcome = new URL(location!, 'http://site.test').searchParams.get('contact');
    expect(CONTACT_OUTCOMES, location!).toContain(outcome);
    return { outcome: outcome!, retryable: body.error.retryable === true };
  }

  const SCENARIOS: Record<string, () => void | Promise<void>> = {
    'the email provider is not configured': () => void vi.stubEnv('EMAIL_API_KEY', ''),
    'the send endpoint is not an https URL': () => void vi.stubEnv('EMAIL_API_URL', 'http://provider.example.test/emails'),
    'the rate limiter cannot count': () => void vi.stubEnv('DATABASE_URL', ''),
    'the provider rejects the send': () => void fetchMock.mockResolvedValue(new Response('no', { status: 400 })),
  };

  it.each(Object.keys(SCENARIOS))('%s', async (name) => {
    await SCENARIOS[name]!();
    const { outcome, retryable } = await bothWays();
    const shown = await render(outcome);
    expect(/try again|retry/i.test(shown), `${outcome} (retryable=${retryable}): ${shown}`).toBe(retryable);
    if (!retryable) {
      // Something has to be offered instead of a retry, or the visitor is simply stuck.
      expect(shown).toContain('will not change that');
      expect(shown).toContain(`the ${BRAND.name} GitHub repository`);
    }
  });

  it('covers both of the route\'s 503 reasons, and they are not the same outcome', async () => {
    vi.stubEnv('EMAIL_API_KEY', '');
    const unconfigured = await bothWays();
    vi.stubEnv('EMAIL_API_KEY', EMAIL_API_KEY);
    vi.stubEnv('DATABASE_URL', '');
    const limiter = await bothWays();
    expect(unconfigured.outcome).not.toBe(limiter.outcome);
    expect(unconfigured.retryable).toBe(false);
    expect(limiter.retryable).toBe(true);
    expect(Object.values(CONTACT_CODES)).toHaveLength(2);
  });
});
