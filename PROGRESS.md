# PROGRESS — Lacre

Updated: 2026-11-21 · `main` at `32c4f18` · verified against origin: **yes**
Checkout when written: on `main`, 0 behind `origin/main`.

Every claim below carries how it was checked. Re-check before acting. This file has
twice carried entries that were wrong rather than merely stale, so treat it as a
starting hypothesis.

Seven PRs landed on 20–21 November (#262, #264, #265, #266, #268, #269, #270) and nine
issues closed. The backlog is down to **one open PR and two open issues**, both of which
need a decision from Jared rather than more work.

## What "live" means for this product

A stranger can buy a $5 evidence bundle on lacre.dev and see the purchase recorded on
`/account`. Where that stands:

- The bundle sale is **shut**. *VERIFIED LIVE: `/checkout` says "not open yet, so nothing
  can be bought or charged here today."*
- `/account` **does** now recognise a bundle purchase (#261). *VERIFIED BY TEST.* Still
  **not verified live**, because the page is behind sign-in.
- **No one can sign in.** One variable short: `EMAIL_FROM`. See below.

The product underneath — CLI, chain, offline verifier — does what the site claims,
including catching a forged bundle and a truncated one. *VERIFIED BY TEST: 194 offline
verifier tests, which run with no network and no code from core or cloud.*

## Live now

- lacre.dev serves current `main`; production deploys are git-triggered from `ref=main`.
- **The site no longer overclaims.** The homepage headline is "Your agent says it refunded
  $42.50. Get a signed, tamper-evident record of what it reported." *VERIFIED LIVE.* The
  legal review's four homepage overclaims and five on the Pages landing are gone (#255,
  #259 → #266), and a sweep of eleven patterns across every public surface fails CI if any
  returns.
- **One brand.** Every public contact point reads `hello@lacre.dev`. *VERIFIED LIVE.*
- **`/robots.txt`, `/sitemap.xml`, `/favicon.ico`, `/apple-icon.png` all return 200**, with
  the right content types. All four were 404 yesterday. *VERIFIED LIVE.*
- **Every public page carries one canonical** on lacre.dev. *VERIFIED LIVE on /pricing.*
- **Prices no longer read as buyable.** The not-on-sale status now comes before the figure
  and the figure reads "Planned: $49/mo". *VERIFIED LIVE.*
- **No known dependency advisories.** `pnpm audit --prod` → "No known vulnerabilities
  found", down from 8 (#265). *VERIFIED LOCALLY on `main`.*
- `pnpm run ci` on `main`: **1,613 tests + 194 offline**, green. *VERIFIED LOCALLY on the
  merge commit, not on a branch.*

## Production environment

Four variables, all `production`, names only. *VERIFIED LIVE from the Vercel project.*

| Name | Kind | State |
|---|---|---|
| `DATABASE_URL` | Secret | set |
| `SESSION_SECRET` | Secret | set |
| `EMAIL_API_KEY` | Secret | set |
| `EMAIL_API_URL` | Config (plain, auditable) | set — `https://api.resend.com/emails` |
| **`EMAIL_FROM`** | — | **NOT SET** |
| `MAGIC_LINK_ENABLED` | — | **NOT SET** |

A Vercel environment change reaches traffic only on the **next deployment**; existing
deployments keep the variables they were built with. Set everything for a surface, then
deploy once. The seven merges today each triggered a deploy, so everything currently set
is live.

## What each surface needs

| Surface | Needs | State |
|---|---|---|
| Contact form, waitlist | `EMAIL_API_URL`, `EMAIL_API_KEY`, `EMAIL_FROM` | one short |
| Sign-in (magic link) | the three above, plus `SESSION_SECRET`, `MAGIC_LINK_ENABLED=1`, and the two `packages/site/migrations/` tables applied | two short |
| `/account` | sign-in working | blocked behind sign-in |
| Bundle checkout | Stripe (issue #29) | not started |

The site now **says all of this itself**, correctly, without anyone editing copy: the
waitlist reads "The waitlist isn't taking sign-ups yet" and Enterprise reads "This form
can't send messages yet", both derived from `contactForwarding()`. *VERIFIED LIVE —
which is also the cleanest proof that `EMAIL_FROM` is still unset.* Both revert to
promising a reply by themselves once sending is configured. No copy change is needed.

## Outstanding owner steps

In order. The first unblocks the most.

1. **`EMAIL_FROM`** — a verified sender at a domain Resend accepts. Tell me the address and
   I will set it without it appearing anywhere, or set it yourself. Nothing validates its
   format in our code, so a wrong value fails at Resend with a 502 in front of a real
   visitor. `lacre.dev` is Google-hosted and SPF'd; whether Resend has it verified as a
   sending domain is the open question.
2. **One redeploy of `main`** after that, so the variable reaches traffic.
3. **Confirm the two `packages/site/migrations/` tables are applied to Neon**
   (`0000_magic_link_used.sql`, `0001_magic_link_rate.sql`), then set
   `MAGIC_LINK_ENABLED=1`. Not checkable from here: the routes' 503 is deliberately
   generic, so the server log is the only tell.
4. **Apply `packages/cloud/migrations/0003_free_bundles.sql`.**
5. **Issue #29, Stripe** — keys and prices first, `STRIPE_WEBHOOK_SECRET` last, test mode
   only. Owner-only by the issue's own terms: the build agent never holds a live key.
6. **Decide the npm publish** (see Open PRs).
7. **Decide the retention claim** (see below).
8. **Issue #258's last item** — the Stripe check on the withdrawn 90-day package.

## Decision waiting on Jared: the retention claim

`/pricing` advertises "90-day retention" as a Cloud feature. **Nothing enforces it**: no
purge job, no TTL, no scheduled delete. The only crons are the anchor scheduler and the
collector. It is `retentionDays: 90` at `packages/cloud/src/pricing.ts:83`, rendered
through `packages/site/src/plans.ts:206`. *VERIFIED BY READ.*

This is the same defect class #243 fixed in the Privacy Policy, left standing one page
over. Two legitimate fixes point opposite ways — make the period real, or soften the page
— so the copy is deliberately unchanged. Choosing is yours.

One fact that bears on it, from the new gap note: **EU AI Act Article 19 requires logs for
at least six months.** A customer with an Article 19 obligation could not discharge it
with a 90-day retention period, whether or not it is enforced.

## Landed recently

- **#270** (#260) — finished the Provenant rename. MIT licences now say "Lacre
  contributors"; `LICENSE.commercial` says "Ascella Studios LLC" rather than "Lacre", which
  is a deliberate deviation from the issue (a commercial licence is owned by a legal
  entity). README/PRODUCT/AGENTS point at lacre.dev, the 404ing npm links are gone, and the
  Pages root is now a redirect stub with the demo at `docs/demo.html`.
- **#269** (#221) — gap note on the November 2026 agent-audit drafts. The authorizing
  principal is the one real gap and it is the same gap in every document read.
- **#268** (#256, #257) — robots, sitemap, canonicals and the raster icons.
- **#266** (#255, #259) — the overclaim recast, with a sweep guard.
- **#265** — cleared seven Next.js advisories and `source-map-js`, lockfile only.
- **#264** (#254, part of #258) — the contact address, and the forms and prices that were
  overpromising. `LEGAL.mailboxProvider` moved with the address, which #254 had not
  anticipated: `frontierforge.tech` is on Microsoft 365 and `lacre.dev` is on Google, so
  swapping the address alone would have left /privacy naming the wrong processor.
- **#262** — the previous pass of this file.

Closed without code: **#229** (already done by #230), **#263** (does not reproduce — a
nonexistent path returns 404, not 503), **#113** (the footer already names the entity),
**#267** (a GitHub Pages "inactive" false positive — the deploy succeeded at 05:31:32 and
was superseded 19 minutes later), **#253** (competitive research, deliberately not
mirrored into a public repo).

## Open PRs

- **#225, Prepare 1.0.1.** Blocked on a decision, not on work. Its own body says "merge
  only after 1.0.0 is on npm. These docs say the packages are on npm, which is false until
  then." Still true: both packages return **404** on the registry and `npm whoami` is not
  logged in. *VERIFIED LIVE.* It now also conflicts with `main`, because #270 removed the
  npm links on purpose. The right order is: publish, then land #225 immediately after.
  The release rehearsal is clean — `release:dry` passes, `@lacre/cloud` is correctly
  excluded as private, and the tarballs hold only LICENSE, README, bin and dist.

## Known stale or unverified

- **`/account`'s behaviour is not verified live.** It is behind sign-in, which is shut.
- **The two site migrations may or may not be applied to Neon.** Not checkable without
  database access.
- **`hello@lacre.dev` has not been sent a test message.** The domain is mail-enabled
  (Google MX, Google SPF) and issue #254 records that mail to it lands in the
  `hello@ascellastudios.com` mailbox, but nobody has confirmed delivery. It is now
  published on /terms, /privacy, the footer, pricing and `security.txt`.
- **The Terms text changed in #264**, so the **effective date may need to move**.
  `effectiveDate` is an owner-supplied fact in `src/legal.ts` and was not invented.
- **Divergence figures for #225 go stale immediately.** Re-measure from the API against
  current `main` before acting on one.
