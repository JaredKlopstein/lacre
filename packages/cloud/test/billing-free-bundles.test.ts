import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import { billingSchema, billingFreeBundles } from '../src/billing/schema.js';
import { freeBundleGrant, recordFreeBundle, type BillingDb } from '../src/billing/store.js';

/**
 * The free first bundle, and the record that makes "one per customer" checkable.
 *
 * /pricing and the Terms both promise the first evidence bundle free, one per
 * customer. Nothing recorded a free one: it is requested by email and made by
 * hand, so billing_bundle_credits -- one row per paid Checkout Session -- could
 * never hold it. When a second request arrived there was no table to check.
 *
 * What is tested here is the record, not enforcement. No code path refuses a
 * second free bundle, because no code path fulfils the first one, and the tests
 * say so rather than implying otherwise.
 *
 * Postgres is PGlite, in process. Nothing here touches a real database.
 */

const MIGRATIONS = new URL('../migrations/', import.meta.url);
/** Every migration, in the order their names sort, which is the order the owner applies them. */
const migrationFiles = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();
const ACCOUNT = `acct_${'a'.repeat(64)}`;
const OTHER_ACCOUNT = `acct_${'b'.repeat(64)}`;

let pg: PGlite;
let db: BillingDb;

beforeAll(async () => {
  pg = await PGlite.create();
  for (const file of migrationFiles) await pg.exec(readFileSync(new URL(file, MIGRATIONS), 'utf8'));
  db = drizzle({ client: pg, schema: billingSchema });
});
afterAll(async () => {
  await pg.close();
});
beforeEach(async () => {
  await pg.exec('TRUNCATE billing_free_bundles RESTART IDENTITY');
});

describe('recording a free first bundle', () => {
  it('records the grant, and reads back as the account having had one', async () => {
    expect(await freeBundleGrant(db, ACCOUNT)).toBeNull();
    expect(await recordFreeBundle(db, { accountId: ACCOUNT, note: 'requested by email, made by hand' })).toBe('recorded');

    const grant = await freeBundleGrant(db, ACCOUNT);
    expect(grant).not.toBeNull();
    expect(grant!.accountId).toBe(ACCOUNT);
    expect(grant!.note).toBe('requested by email, made by hand');
    expect(grant!.grantedAt).toBeInstanceOf(Date);
  });

  it('is what a second request can be checked against: the claim becomes answerable', async () => {
    await recordFreeBundle(db, { accountId: ACCOUNT });
    // The question "has this customer had their free one?" now has an answer.
    expect(await freeBundleGrant(db, ACCOUNT)).not.toBeNull();
    expect(await freeBundleGrant(db, OTHER_ACCOUNT)).toBeNull();
  });

  it('is idempotent: a second recording of the same account adds no row and says so', async () => {
    expect(await recordFreeBundle(db, { accountId: ACCOUNT, note: 'first' })).toBe('recorded');
    expect(await recordFreeBundle(db, { accountId: ACCOUNT, note: 'second' })).toBe('already_recorded');
    const rows = await db.select().from(billingFreeBundles);
    expect(rows).toHaveLength(1);
    // The first grant is the record; a later call does not rewrite it.
    expect(rows[0]!.note).toBe('first');
  });

  it('holds at most one row per account however many callers race', async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () => recordFreeBundle(db, { accountId: ACCOUNT })),
    );
    expect(results.filter((r) => r === 'recorded')).toHaveLength(1);
    expect(await db.select().from(billingFreeBundles)).toHaveLength(1);
  });

  it('keeps accounts apart', async () => {
    await recordFreeBundle(db, { accountId: ACCOUNT });
    expect(await recordFreeBundle(db, { accountId: OTHER_ACCOUNT })).toBe('recorded');
    expect((await db.select().from(billingFreeBundles)).map((r) => r.accountId).sort()).toEqual(
      [ACCOUNT, OTHER_ACCOUNT].sort(),
    );
  });

  it('defaults the note to null rather than inventing one', async () => {
    await recordFreeBundle(db, { accountId: ACCOUNT });
    expect((await freeBundleGrant(db, ACCOUNT))!.note).toBeNull();
  });

  /**
   * The Privacy Policy says no list of email addresses is kept. The key is the
   * account id the site already uses, a one-way hash, and this table must not
   * become the place an address appears.
   */
  it('stores no email address: its only account column is the hashed account id', () => {
    const config = getTableConfig(billingFreeBundles as PgTable);
    expect(config.columns.map((c) => c.name).sort()).toEqual(['account_id', 'granted_at', 'id', 'note']);
    expect(config.columns.map((c) => c.name).join(' ')).not.toMatch(/email|address/);
  });
});

/**
 * Every table the code knows about exists after the migrations are applied.
 *
 * The list is read from billingSchema and the migrations from the directory, so
 * a table added to one and not the other fails here. A test that enumerated
 * either could not notice that: it would only check what someone remembered to
 * add to it.
 */
describe('the migrations cover the schema', () => {
  it('creates every table in billingSchema, column for column and constraint for constraint', async () => {
    const fresh = await PGlite.create();
    try {
      for (const file of migrationFiles) await fresh.exec(readFileSync(new URL(file, MIGRATIONS), 'utf8'));
      const tables = Object.values(billingSchema) as PgTable[];
      expect(tables.length).toBeGreaterThan(0);
      for (const table of tables) {
        const config = getTableConfig(table);
        const { rows: columns } = await fresh.query<{ column_name: string; data_type: string; is_nullable: string }>(
          'SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name = $1 ORDER BY column_name',
          [config.name],
        );
        expect(columns, config.name).toEqual(
          config.columns
            .map((c) => ({ column_name: c.name, data_type: c.getSQLType(), is_nullable: c.notNull ? 'NO' : 'YES' }))
            .sort((a, b) => a.column_name.localeCompare(b.column_name)),
        );
        const { rows: constraints } = await fresh.query<{ constraint_name: string }>(
          "SELECT constraint_name FROM information_schema.table_constraints WHERE table_name = $1 AND constraint_type IN ('UNIQUE', 'FOREIGN KEY') ORDER BY constraint_name",
          [config.name],
        );
        expect(constraints.map((c) => c.constraint_name), config.name).toEqual(
          [
            ...config.columns.filter((c) => c.isUnique).map((c) => c.uniqueName!),
            ...config.uniqueConstraints.map((u) => u.name!),
            ...config.foreignKeys.map((fk) => fk.getName()),
          ].sort(),
        );
      }
    } finally {
      await fresh.close();
    }
  });

  it('leaves every table that existed before this one untouched, so applying it late is safe', () => {
    const added = readFileSync(new URL('0003_free_bundles.sql', MIGRATIONS), 'utf8');
    expect(added).not.toMatch(/\b(ALTER|DROP|TRUNCATE|UPDATE|DELETE)\b/i);
    expect(added.match(/CREATE TABLE/gi)).toHaveLength(1);
  });
});
