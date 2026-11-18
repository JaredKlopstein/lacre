# PROGRESS — Lacre

Updated: 2026-11-18 (second pass, after #261 merged) · `main` at `e1759a8` · verified against origin: **yes**
Checkout when written: branch `docs/progress-2026-11-18` at `fdc62e1`, 0 behind `origin/main`, 1 ahead (this file).

## What "live" means for this product

A stranger can buy a $5 evidence bundle on lacre.dev and see the purchase recorded on
`/account`. The bundle sale is still gated shut. `/account` now does recognise a bundle
purchase (#261, merged and deployed) — but **no one can sign in to production at all**, so
no customer can reach the page that recognises it. See "The sign-in door is shut". The
product underneath — CLI, chain, offline verifier — does what the site claims, including
catching a forged bundle and a truncated one.

## Live now

- lacre.dev serves current `main`. Production deploys are git-triggered from `ref=main`
  — `e1759a8` deployed 2026-11-18 21:06 UTC, production, state READY, with no manual
  step. *VERIFIED LIVE from the deployment record, which carries the commit SHA*
- **`/account` shows bundles bought** instead of telling a paying customer "No plan
  recorded for this account yet". Merged as #261 → `e1759a8`. *VERIFIED BY TEST on the
  merge commit: `pnpm run ci` green, 74 files / 1,578 tests, plus 194 offline* —
  **not verified live**, because sign-in is shut (below), so the page is unreachable.
- **The sign-in door is shut, and this was not previously recorded.** Production holds
  **exactly one** environment variable, `DATABASE_URL` (`hiddenProductionEnvCount: 0`).
  `SESSION_SECRET` is set for *development* and *preview* only. Both auth routes call
  `authConfig()`, which needs `SESSION_SECRET` **and** all three `EMAIL_*`, and
  `/api/auth/magic-link` additionally requires `MAGIC_LINK_ENABLED=1`. So every sign-in
  attempt answers 503 "Email sign-in is not configured on this server yet."
  *VERIFIED BY READ of the production env list (names only) and of both route files*
- **The contact form sends nothing.** The form at `/enterprise` is live and submittable
  (it posts to `/api/contact`); the three `EMAIL_*` variables are unset, so a submission
  comes back saying nothing was sent. The code to send landed in #250; only config is
  missing. *VERIFIED BY READ; the form's presence VERIFIED LIVE*
- The bundle sale is **closed**, correctly: since #232, `checkoutConfigured` requires
  `STRIPE_WEBHOOK_SECRET` to be set and well-formed. *VERIFIED BY READ*

## What sign-in actually needs, surface by surface

Recorded because the previous pass named only the three `EMAIL_*` variables and called
that "what makes the front door work". It makes the **contact form** work. It does not
make **sign-in** work, and `/account` is behind sign-in.

| surface | needs | in production |
|---|---|---|
| `/api/contact` | `EMAIL_API_URL`, `EMAIL_API_KEY`, `EMAIL_FROM` | none set |
| `/api/auth/magic-link` | `MAGIC_LINK_ENABLED=1`, `SESSION_SECRET`, the three `EMAIL_*`, `DATABASE_URL`, and the table from `packages/site/migrations/0001_magic_link_rate.sql` | `DATABASE_URL` only |
| `/api/auth/callback` | `SESSION_SECRET`, the three `EMAIL_*`, `DATABASE_URL`, and the table from `packages/site/migrations/0000_magic_link_used.sql` | `DATABASE_URL` only |

`SESSION_SECRET` must be at least 32 characters; shorter is logged and treated as unset.
Whether the two `packages/site/migrations/` tables are applied to Neon is **unverified** —
it cannot be checked from here without database access, and the routes' 503 is generic,
so the logs are the only tell.

## Landed recently

| # | date | what | confidence |
|---|---|---|---|
| #261 | 11-18 | `/account` shows the bundles someone bought | BY TEST |
| #250 | 11-15 | Contact sends as email through the provider the policy names | BY TEST |
| #243 | 11-15 | Privacy says which retention periods a system enforces | BY TEST |
| #242 | 11-15 | Privacy describes the contact flow that happens | BY TEST |
| #246 | 11-14 | Drop the withdrawn package's description, keep its refund clause | BY READ |
| #245 | 11-14 | CI typechecks `packages/site`, which it never did | BY TEST |
| #244 | 11-14 | Sign-in API stops calling a config gap a moment to wait | BY TEST |
| #241 | 11-14 | Record a free first bundle, so "one per customer" is checkable | BY TEST |
| #235 | 11-14 | Withdraw the 90-day evidence package from sale | BY READ |
| #232 | 11-13 | The bundle sale cannot open until a payment can be recorded | BY READ |

## Open PRs

| # | head | vs main | state | what it needs |
|---|---|---|---|---|
| #225 | `67fcbc4` | **behind 20, diverged** | draft **on purpose** | a rebase before it is ever considered, and 1.0.0 published first. Its docs say the packages are on npm, false until then |

The previous pass recorded #225 as "behind main 0". That was **wrong when written**: `main`
has moved one commit since, so it was already behind 19. Re-measure a PR's divergence from
the API against the current `main` before trusting any number in this file.

## Blocked on Jared

Listed in the order that unblocks the most for the least work. We work these one at a
time, not as a batch.

1. **Set `SESSION_SECRET` in Vercel production**, marked Sensitive, 32+ random characters.
   No external dependency, no deploy needed. Required by both auth routes, whatever email
   provider is chosen later. It is set for development and preview but not production.
2. **Set `EMAIL_API_URL` = `https://api.resend.com/emails`, `EMAIL_API_KEY`, `EMAIL_FROM`**
   in Vercel production, marked Sensitive. Needs a Resend-verified sending domain first.
   This alone makes the contact form work end to end.
3. **Apply `packages/site/migrations/0000_magic_link_used.sql` and `0001_magic_link_rate.sql`**
   to Neon, if they are not already applied — then `MAGIC_LINK_ENABLED=1` can go on and
   sign-in works. Flipping that flag before the rate-limit table exists only changes which
   503 is returned, so the migrations come first.
4. **Apply `packages/cloud/migrations/0003_free_bundles.sql`** to Neon. Nothing calls it
   yet, so applying it late costs nothing.
5. **Issue #29 — the Stripe account, products, restricted keys, webhook, Vercel vars.** The
   order matters and is not the obvious one: set keys and prices first (safe, they no longer
   open the sale), and set **`STRIPE_WEBHOOK_SECRET` last**, because since #232 that one
   variable is the switch that opens the sale. Stripe stays in test mode.
6. **npm publish 1.0.0 from `main`** (not from a 1.0.1 branch), then #225 can merge. `npm` is
   not logged in. Packaging itself is verified safe.
7. **Make the retention periods real** — a written monthly step would do it. Then #243's
   hedged wording can go back to promising 90 days flatly.

## Next three steps to live

1. ~~Merge #261~~ — **done**, `e1759a8`, deployed and green on `main`.
2. **Set `SESSION_SECRET` in production.** Yours. Cheapest item on the critical path to
   `/account`, and nothing else about sign-in can be tested until it is set.
3. **Then the three `EMAIL_*` variables**, then the two site migrations, then
   `MAGIC_LINK_ENABLED=1`. Yours, with me verifying each step after it.

## Known stale or unverified

- Whether the `packages/site/migrations/` tables are applied to Neon: **unverified**, see
  above.
- The **GitHub Pages mirror** (`docs/index.html` → jaredklopstein.github.io/lacre/) loads
  Google Fonts, so a visitor's IP reaches Google, while the Privacy Policy says "no tracking
  across sites" and does not list Google. lacre.dev itself self-hosts correctly. Fix: self-host
  the three IBM Plex families in `docs/` — they are OFL and the app already ships them.
- **Advisories: quote the production number, not the total.** `pnpm audit` reports 18
  including 3 criticals; `pnpm audit --prod` reports **3** — one high in `source-map-js`, two
  moderate in `next`. Every critical is dev tooling (vitest, vite, esbuild, tinypool).
- Never commit or publish `internal/`, `.env.local`, `.vercel/`, `~/.lacre`.
- Run `pnpm run ci`, not `npm test`: the test command alone does not typecheck, and that
  gap once let a deleted import pass tests locally and fail in CI.
- **Watch the test count.** `main` is now **1,578** (plus 194 offline). #261's first attempt
  was cut from an already-squashed branch and read 1,544 — a suite shrinking while tests
  were being added was the only signal that the base was wrong. Every check was green on it.
