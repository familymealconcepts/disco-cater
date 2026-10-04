/**
 * One-off restore: the seven CONVERTED restaurants an admin set to DIRECT on
 * 2026-10-02 15:47-15:48 UTC, which the money-flow reconcile cron reverted to
 * FamilyMeal's stale pre-conversion FAMILY_MEAL at 2026-10-03 06:00-06:02.
 *
 * The job is fixed (it no longer reads native rows at all), so this restores the
 * operator's decision and it will now stick. Writes Neon ONLY — FamilyMeal is
 * never contacted, which is correct for a converted restaurant: Disco owns
 * money_flow after conversion.
 *
 * Targets are derived from the audit trail, not hardcoded, so this cannot touch
 * a restaurant nobody actually set.
 *
 * AND IT NEVER OVERRIDES A LATER HUMAN DECISION. A restaurant only qualifies if
 * its MOST RECENT money_flow_update set DIRECT and the stored value is now
 * FAMILY_MEAL — i.e. the job's revert is still the last word. Colonial Ranch
 * Market is the reason this matters: the cron reverted it at 06:00 on 10-03, but
 * at 13:13:19 Peter set DIRECT and at 13:13:27 set FAMILY_MEAL again, so its
 * current value is HIS choice, not the job's. Restoring it would undo him.
 *
 *   npx tsx scripts/restore-reverted-money-flow.ts          # dry run
 *   npx tsx scripts/restore-reverted-money-flow.ts --apply
 */
import { config } from 'dotenv'
config({ path: '.env.local', quiet: true })
import { sql } from '../lib/db'
import { logSettingsChange } from '../lib/settings-audit'

const APPLY = process.argv.includes('--apply')

async function main() {
  // `last` = the most recent human money_flow_update per restaurant. Comparing
  // against THAT, rather than against the 10-02 batch alone, is what stops the
  // restore from overriding a decision made after the job's revert.
  const targets = (await sql`
    WITH last AS (
      SELECT DISTINCT ON (a.restaurant_reference)
             a.restaurant_reference AS ref,
             a.detail->'after'->>'money_flow' AS last_set,
             a.created_at AS last_at
      FROM disco_admin_audit a
      WHERE a.action = 'money_flow_update'
      ORDER BY a.restaurant_reference, a.id DESC
    )
    SELECT l.ref, c.name, o.money_flow, l.last_set,
           to_char(l.last_at, 'YYYY-MM-DD HH24:MI:SS') AS last_at
    FROM last l
    JOIN disco_restaurant_cache c ON c.restaurant_reference = l.ref
    JOIN disco_restaurant_overrides o ON o.restaurant_reference = l.ref
    WHERE c.is_disco_native = true
      AND EXISTS (
        SELECT 1 FROM disco_admin_audit b
        WHERE b.restaurant_reference = l.ref AND b.action = 'money_flow_update'
          AND b.created_at >= '2026-10-02 15:00+00' AND b.created_at < '2026-10-02 16:00+00'
          AND b.detail->'after'->>'money_flow' = 'DIRECT'
      )
    ORDER BY c.name
  `) as { ref: string; name: string | null; money_flow: string | null; last_set: string | null; last_at: string }[]

  console.log(`${APPLY ? 'APPLYING' : 'DRY RUN'} — ${targets.length} restaurant(s) from the audit trail\n`)
  let changed = 0
  for (const t of targets) {
    if (t.last_set !== 'DIRECT') {
      console.log(`  SKIP  ${t.name} — a human set ${t.last_set} later (${t.last_at}); that decision stands`)
      continue
    }
    if (t.money_flow === 'DIRECT') { console.log(`  skip  ${t.name} — already DIRECT`); continue }
    console.log(`  ${APPLY ? 'set ' : 'would set'}  ${t.name}: ${t.money_flow} -> DIRECT`)
    if (!APPLY) { changed++; continue }
    await logSettingsChange({
      action: 'money_flow_update',
      restaurantReference: t.ref,
      actorEmail: 'peter@familymeal.com',
      authType: 'admin',
      before: { money_flow: t.money_flow },
      after: { money_flow: 'DIRECT' },
      extra: {
        native: true,
        restore: true,
        note: 'Restores the 2026-10-02 operator setting that reconcile-money-flow reverted on 2026-10-03 from FM\'s stale pre-conversion value. Applied by scripts/restore-reverted-money-flow.ts after the job stopped reading native rows.',
      },
    })
    await sql`
      UPDATE disco_restaurant_overrides SET money_flow = 'DIRECT', updated_at = NOW()
      WHERE restaurant_reference = ${t.ref}
    `
    changed++
  }
  console.log(`\n${APPLY ? 'restored' : 'would restore'}: ${changed}`)
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
