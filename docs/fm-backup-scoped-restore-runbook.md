# Restoring a fresh, scoped fm_backup snapshot and re-running the backfill

Runbook for closing the 1,057 post-freeze-order gap once a fresh scoped dump
lands. Follow in order — nothing here should require improvisation once the
dump file exists.

## 0. What you should already have

A file produced by (adjust host/port/user for the real production connection):
```bash
PGPASSWORD='...' pg_dump -h <HOST> -p <PORT> -U <USER> -d fm -Fc \
  -n familymeal \
  -t familymeal.tbl_restaurant_orders \
  -t familymeal.tbl_restaurant_sale_transactions \
  -t familymeal.tbl_restaurant_order_meal_packages \
  -t familymeal.tbl_restaurant_order_add_ons \
  -t familymeal.tbl_restaurant_delivery_addresses \
  -t familymeal.tbl_restaurants \
  -f fm_backup_scoped.dump
```

## 1. Restore into a NEW, separate local database

Never overwrite the existing `fm_backup` — it's the known-good 2026-06-17
snapshot, still useful for diffing old vs. new, and the fallback if the fresh
dump has an issue.

```bash
createdb fm_backup_scoped
pg_restore -d fm_backup_scoped --no-owner --no-privileges -j 4 fm_backup_scoped.dump
```

Expect a handful of harmless `ERROR: relation "tbl_restaurants" does not
exist` (or `tbl_restaurant_customers`) lines if `tbl_restaurants` wasn't
included in the dump — those are foreign-key constraints on the dumped tables
referencing tables that aren't part of this scoped set. Data still restores;
only the constraint-creation statements fail. If `tbl_restaurants` *was*
included (as in the command above), you shouldn't see these at all.

## 2. Verify the restore before trusting it

```bash
psql -d fm_backup_scoped -c "
  SELECT 'orders' AS t, COUNT(*) FROM familymeal.tbl_restaurant_orders
  UNION ALL SELECT 'sale_transactions', COUNT(*) FROM familymeal.tbl_restaurant_sale_transactions
  UNION ALL SELECT 'meal_packages', COUNT(*) FROM familymeal.tbl_restaurant_order_meal_packages
  UNION ALL SELECT 'add_ons', COUNT(*) FROM familymeal.tbl_restaurant_order_add_ons
  UNION ALL SELECT 'delivery_addresses', COUNT(*) FROM familymeal.tbl_restaurant_delivery_addresses;
"
```
Sanity check: every count should be **larger** than the corresponding count in
the existing `fm_backup` (23,144 / 23,014 / 55,558 / 67,817 / 4,186 as of the
2026-06-17 snapshot) — a fresh dump should have strictly more history, never
less. If any count is *smaller*, stop and investigate before proceeding; that
would mean the scoped dump missed data the old one had.

```bash
psql -d fm_backup_scoped -c "SELECT MAX(created_date) FROM familymeal.tbl_restaurant_orders;"
```
Confirm this is recent (close to today), confirming the new snapshot actually
extends past the 2026-06-17 freeze — otherwise nothing was gained.

## 3. Re-check the 6 excluded orders against the fresh data

Before touching the backfill script, manually re-investigate whether the
fresh snapshot resolves any of the 6 orders currently hard-excluded in
`scripts/fm-order-backfill.ts` (`EXCLUDED_ORDER_IDS`):
- **6741, 5122, 6512, 6517, 18470** — each had a duplicate never-PAID
  `ORIGINAL` transaction row (an abandoned/expired-checkout retry artifact).
  Query `familymeal.tbl_restaurant_sale_transactions` for these orders'
  `restaurant_order_id`s in `fm_backup_scoped` — if FM's backend has since
  cleaned up the duplicate (or the order progressed past EXPIRED), the
  duplicate may be gone.
- **17159** — the unexplained $444.13-vs-$381.50 gap. Re-check whether an
  `ADDITIONAL`/`REFUND` row now exists that explains it (an edit that happened
  after the original 2026-06-17 freeze but is now captured).

**Do not auto-resolve these.** If the fresh data looks clean for one of them,
remove it from `EXCLUDED_ORDER_IDS` by hand, with a comment explaining what
changed and citing the new evidence — mirroring how the original 5/6 exclusion
reasons are documented inline in the script.

## 4. Run the dry run against the new source

```bash
npx tsx scripts/fm-order-backfill.ts --source-db=fm_backup_scoped
```
Expect:
- `Backfillable candidate orders` should now include (most of) the 1,057
  previously-uncovered orders, on top of the 20,171 already done — check the
  reported count increased by roughly that much (minus whatever the excluded
  6 minus any orders you removed in Step 3, minus any orders that are still
  outside even this fresher snapshot).
- The dry run is read-only — no writes happen regardless of source DB.

## 5. Execute — should no-op on the 20,171 already done

```bash
npx tsx scripts/fm-order-backfill.ts --source-db=fm_backup_scoped --execute
```
The script's idempotency guarantee (DELETE-then-INSERT keyed by `order_id`,
proven via repeated real executions producing byte-identical row counts) means
this is safe to run against the full candidate set even though most of it was
already backfilled from the old snapshot: for the 20,171 already-done orders,
it deletes and re-inserts the *same* rows (the underlying FM data for those
orders hasn't changed — pre-freeze history is frozen) — net effect is a no-op,
not a duplicate write. Only the ~1,057 previously-uncovered orders should
actually change any *existing* Neon data (from "no transaction row" to "has
one"). Watch the per-chunk row counts in the output: chunks covering only
already-backfilled orders should report deltas consistent with a clean
replace, not growth.

## 6. Verify order 70627950 specifically

```bash
npx tsx -e "
import('./lib/order/order-pdf').then(async (m) => {
  const { neon } = await import('@neondatabase/serverless')
  const sql = neon(process.env.DATABASE_URL)
  const rows = await sql\`SELECT reference FROM disco_orders WHERE order_number = '70627950'\`
  const pdf = await m.buildOrderPdfByReference(rows[0].reference)
  require('fs').writeFileSync('/tmp/order-70627950.pdf', pdf)
  console.log('wrote PDF')
})
"
```
Extract text (`pypdf` or similar) and confirm: Taxes \$13.65, Tips \$30.92,
Delivery Fee \$14.95, Promo −\$22.90, Total \$271.80, and all six modifier
lines (five \$0.00 ones — Caesar Salad, Penne Vodka, Chicken Parm, Eggplant
Rollatini, No Utensils — plus Garlic Knots at \$9.00).

## 7. Spot-check reporting + a native/pickup/3P order

Repeat the same reconciliation check used for the 20,171-order backfill:
Glen Rock's summary cards vs. Daily Revenue graph vs. CSV export should still
agree, now with a higher total (the 17 previously-uncovered Glen Rock orders
included). Spot-check one native order (untouched), one pickup order, one 3P
delivery order from the newly-covered set, same as before.

## 8. Only after all of the above verifies clean

Proceed to Step 3 of the original task (removing the live
`loadFmOrderDetails` call from the popout) — in its own commit, per the
standing instruction not to bundle it with data changes.
