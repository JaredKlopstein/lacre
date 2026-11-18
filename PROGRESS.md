# PROGRESS — Lacre

Updated: 2026-11-18, third pass · `main` at `e1759a8` · verified against origin: **yes**
Checkout when written: branch `docs/progress-2026-11-18`, 0 behind `origin/main`, ahead by
this file only. It is open as **PR #262** and is not on `main` yet.

Every claim below carries how it was checked. Re-check before acting: this pass found two
entries in the previous one that were wrong, not merely stale.

## What "live" means for this product

A stranger can buy a $5 evidence bundle on lacre.dev and see the purchase recorded on
`/account`. Where that stands:

- The bundle sale is **shut**. *VERIFIED LIVE: `/checkout` says "not open yet, so nothing
  can be bought or charged here today."*
- `/account` **does** now recognise a bundle purchase (#261). *VERIFIED BY TEST*
- **No one can sign in**, so no customer can reach `/account` at all. One variable short.

The product underneath — CLI, chain, offline verifier — does what the site claims,
including catching a forged bundle and a truncated one. *VERIFIED BY TEST: 194 offline
verifier tests, which run with no network and no code from core or cloud.*

## Live now

- lacre.dev serves current `main`. Production deploys are git-triggered from `ref=main`:
  `e1759a8` deployed 2026-11-18 21:06 UTC, production, READY, no manual step.
  *VERIFIED LIVE from the deployment record, which carries the commit SHA.*
- **`/account` shows bundles bought** instead of telling a paying customer "No plan
  recorded for this account yet". #261 → `e1759a8`. *VERIFIED BY TEST on the merge commit:
  `pnpm run ci` green, 74 files / 1,578 tests, plus 194 offline.* **Not verified live** —
  the page is behind sign-in, which is shut.
- The GitHub Pages mirror **self-hosts its fonts correctly**. *VERIFIED LIVE: no Google
  origin in the served HTML, `docs/fonts/` holds 6 woff2 files plus `OFL.txt` at `e1759a8`,
  and the live `ibm-plex-sans-400-600.woff2` returns HTTP 200 as `font/woff2`.* The
  previous pass listed this as an open privacy contradiction; that was **stale** — the fix
  landed 2026-11-15. No visitor IP reaches Google.

## Production environment

It held **one** variable this morning. It now holds **four**. *VERIFIED by reading the
project's variables names-only; no value was decrypted, and `SESSION_SECRET` was generated
and piped straight to Vercel so it was never displayed, logged or written to disk.*

| key | type | set by |
|---|---|---|
| `DATABASE_URL` | Secret | pre-existing |
| `SESSION_SECRET` | Secret | Claude, 2026-11-18, on Jared's explicit word |
| `EMAIL_API_KEY` | Secret | Jared, 2026-11-18 |
| `EMAIL_API_URL` | **Config** | Claude, 2026-11-18 — `https://api.resend.com/emails` |
| `EMAIL_FROM` | — | **missing. This is the blocker.** |

`EMAIL_API_URL` is Config rather than Secret deliberately: it is Resend's public documented
endpoint, the value `.env.example` names, so marking it Sensitive would buy no secrecy and
would make a typo in it permanently unreadable. The two real secrets stay Secret.

**An environment change needs a redeploy.** Vercel applies it to new deployments only;
"existing deployments keep their previous environment variables" (Vercel docs). So nothing
set today is reaching traffic yet. Set `EMAIL_FROM`, then redeploy **once**.

## What each surface needs

| surface | needs | has |
|---|---|---|
| `/api/contact` | the three `EMAIL_*`. **Not** gated by `MAGIC_LINK_ENABLED` (`.env.example`) | all but `EMAIL_FROM` |
| `/api/auth/magic-link` | `MAGIC_LINK_ENABLED=1`, `SESSION_SECRET`, the three `EMAIL_*`, `DATABASE_URL`, and the table from `packages/site/migrations/0001_magic_link_rate.sql` | all but `EMAIL_FROM`, the flag, and the table |
| `/api/auth/callback` | `SESSION_SECRET`, the three `EMAIL_*`, `DATABASE_URL`, and the table from `packages/site/migrations/0000_magic_link_used.sql` | all but `EMAIL_FROM` and the table |

So **`EMAIL_FROM` plus one redeploy makes the contact form work end to end** — a whole
surface live, without opening sign-in. Sign-in needs the flag and the migrations after that.

`SESSION_SECRET` must be 32+ characters; shorter is logged and treated as unset.

## Outstanding owner steps

Only Jared can do these. In order; each one is verified before the next.

1. **`EMAIL_FROM` — the one thing blocking a live surface.** It must be "a verified sender
   at a domain the provider accepts" (`.env.example:51`). **Which domain is verified is
   recorded nowhere in this repository**, and it cannot be inferred: the site is lacre.dev
   while `LEGAL.contactEmail` and `securityEmail` are both `contact@frontierforge.tech`
   (`legal.ts:68-69`), which is also where the contact form sends each submission. Our code
   does no format validation on it, so a wrong value fails at Resend with a 502 in front of
   a real visitor rather than at configuration time. **Tell Claude the address and it will
   set it**, or set it in Vercel directly: Production, Sensitive not required.
2. **One redeploy of `main`.** Needed for steps 1 and everything above to reach traffic.
   Claude will not deploy without Jared's word.
3. **Confirm the two `packages/site/migrations/` tables are applied to Neon** — 
   `0000_magic_link_used.sql` and `0001_magic_link_rate.sql`. **Unverified and
   unverifiable from here** without database access, and the routes' 503 is deliberately
   generic, so the server log is the only tell. Then `MAGIC_LINK_ENABLED=1` can go on and
   sign-in works.
4. **Apply `packages/cloud/migrations/0003_free_bundles.sql`** to Neon. Nothing calls it
   yet, so applying it late costs nothing.
5. **Issue #29 — Stripe account, products, restricted keys, webhook, Vercel vars.** The
   order is not the obvious one: keys and prices first (safe, they no longer open the sale),
   and **`STRIPE_WEBHOOK_SECRET` last**, because since #232 that one variable is the switch
   that opens the sale. **Stripe stays in test mode.**
6. **npm publish 1.0.0 from `main`**, then #225 can merge. *De-risked 2026-11-18:*
   `pnpm run release:dry` passes, `tsc -b` runs clean as prepublish, both packages are at
   1.0.0, `@lacre/cloud` is `private: true` and correctly excluded, and neither package
   exists on the registry yet (`npm view` → 404), so this is a clean first publish with no
   version conflict. Tarballs contain only `LICENSE`, `README.md`, `bin/` and `dist/` —
   **0** entries matching `internal/`, `.env`, `.vercel`, `.lacre` or `secret`. Core is
   116.8 kB packed, verifier 50.3 kB. The one thing missing is auth: **`npm whoami` reports
   not logged in.** *VERIFIED BY TEST*
7. **Decide the retention question** (below). Not blocking anything while Cloud is off sale.
8. **Merge PR #262**, this file, whenever convenient.

## Decision waiting on Jared: the retention claim

`/pricing` advertises "90-day retention" as a Cloud plan feature, live right now.
*VERIFIED LIVE.* It comes from `retentionDays: 90` in `packages/cloud/src/pricing.ts:83`,
rendered by `packages/site/src/plans.ts:206`. **Nothing enforces it** — no purge job, no
TTL, no scheduled delete; the only crons in the codebase are the anchor scheduler and the
collector. *VERIFIED BY READ.*

This is the same defect #243 fixed in the Privacy Policy, left standing on the pricing
page. Two ways out, and it is Jared's call, which is why Claude did not simply change the
copy:

- **Make it real** — a written monthly deletion step would do it. Then #243's hedged
  privacy wording can go back to promising 90 days flatly, and `/pricing` is already true.
- **Soften the page** — state what is actually enforced, as the Privacy Policy now does.

Cloud is off sale and behind a waitlist, so nothing is being sold on this claim today. But
a waitlist signup is still a decision someone makes on it.

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

#235 and #246 are intact: the only "90-day" left on `/pricing` is the retention bullet
above, not the withdrawn package. *VERIFIED LIVE.*

## Open PRs

| # | head | vs main | state | what it needs |
|---|---|---|---|---|
| #262 | this file | 0 behind | open, CI green locally | a merge, whenever |
| #225 | `67fcbc4` | **behind 20, diverged** | draft **on purpose** | a rebase, and 1.0.0 published first |

#225's docs say the packages are on npm. That is **false**: both return 404 on the
registry. *VERIFIED LIVE.* The previous pass recorded #225 as "behind main 0" — that was
**wrong when written**, since `main` has moved only one commit since, so it was already
behind 19. Re-measure divergence from the API against the current `main`.

## Known stale or unverified

- Whether the two `packages/site/migrations/` tables are applied to Neon: **unverified**.
- **Advisories: quote the production number, not the total.** `pnpm audit --prod` reports
  **3** — 1 high, 2 moderate. *VERIFIED BY TEST, re-run 2026-11-18.* The full `pnpm audit`
  reports 18 including 3 criticals, but every critical is dev tooling (vitest, vite,
  esbuild, tinypool) and reaches no user.
- Never commit or publish `internal/`, `.env.local`, `.vercel/`, `~/.lacre`.
- Run `pnpm run ci`, not `npm test`: the test command alone does not typecheck, and that
  gap once let a deleted import pass tests locally and fail in CI.
- **Watch the test count.** `main` is **1,578** plus 194 offline. #261's first attempt was
  cut from an already-squashed branch and read 1,544 — a suite shrinking while tests were
  being added was the only signal the base was wrong, and every check was green on it.
