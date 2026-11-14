-- Lacre free first evidence bundles (Postgres / Neon). Hand-written; matches
-- billing_free_bundles in packages/cloud/src/billing/schema.ts, which a test
-- checks column for column.
--
-- The owner applies this to Neon by hand, after 0000_billing.sql,
-- 0001_overage.sql and 0002_overage_retry.sql. Nothing runs it automatically,
-- at startup or at deploy. It runs in one transaction, so it applies whole or
-- not at all.
--
-- One new table, no existing table changed. Nothing in a request path writes to
-- it: the free bundle is requested by email and made by hand, so until the
-- operator records a grant this table stays empty and the site behaves exactly
-- as it does today. Applying it late costs nothing; not applying it means the
-- "one per customer" claim stays uncheckable.
--
-- account_id is the one-way hash the site's accounts use, never an email
-- address. The Privacy Policy says no list of addresses is kept.

BEGIN;

CREATE TABLE billing_free_bundles (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id text NOT NULL,
  note text,
  granted_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT billing_free_bundles_account_id_unique UNIQUE (account_id)
);

COMMIT;
