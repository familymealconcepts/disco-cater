// One-time backfill: moves stripe_account_id / stripe_onboarding_complete from
// disco_restaurant_accounts (per-admin row) onto disco_restaurant_overrides
// (restaurant-scoped) — see the "restaurant-level fields off accounts" audit
// this closes. Rule: the single non-null stripe_account_id among a
// restaurant's account rows; if a restaurant somehow has more than one
// distinct non-null value (confirmed zero cases before this script was
// written — see the audit), the newest real (non stripe-import) account wins
// and the disagreement is logged loudly rather than picked silently.
//
// Also prints, per restaurant, what the OLD read path
// (ORDER BY id ASC LIMIT 1 on disco_restaurant_accounts, the pattern every
// read site used before this migration) would have returned, next to what
// this backfill is writing — so the cutover is verified at the moment it
// ships, not just trusted from the one-time report that preceded it.
//
// Modes:
//   npx tsx scripts/backfill-stripe-overrides.ts             dry run, no writes (default)
//   npx tsx scripts/backfill-stripe-overrides.ts --execute   real writes
import { config } from 'dotenv'
config({ path: '.env.local', quiet: true })
import { sql, runMigrations } from '../lib/db'

const EXECUTE = process.argv.includes('--execute')

async function main() {
  await runMigrations() // ensures the new overrides columns exist

  const refs = (await sql`SELECT DISTINCT restaurant_reference FROM disco_restaurant_accounts`) as { restaurant_reference: string }[]
  console.log(`${refs.length} restaurant(s) with at least one account row.`)
  console.log(EXECUTE ? '=== EXECUTE MODE — writing real changes ===' : '=== DRY RUN — no writes (pass --execute for real) ===')

  let matched = 0, noStripeAnywhere = 0, conflicts = 0, mismatchVsOldReadPath = 0

  for (const { restaurant_reference: ref } of refs) {
    const rows = (await sql`
      SELECT email, stripe_account_id, stripe_onboarding_complete
      FROM disco_restaurant_accounts WHERE restaurant_reference = ${ref} ORDER BY id ASC
    `) as { email: string; stripe_account_id: string | null; stripe_onboarding_complete: boolean | null }[]

    // What the OLD read path (ORDER BY id ASC LIMIT 1) would have returned —
    // the value every pre-migration route was actually serving.
    const oldPathRow = rows[0]

    const withStripe = rows.filter(r => r.stripe_account_id)
    const distinctIds = new Set(withStripe.map(r => r.stripe_account_id))

    let chosen: { stripe_account_id: string | null; stripe_onboarding_complete: boolean | null }
    if (distinctIds.size === 0) {
      noStripeAnywhere++
      chosen = { stripe_account_id: null, stripe_onboarding_complete: false }
    } else if (distinctIds.size === 1) {
      matched++
      chosen = withStripe[0]
    } else {
      conflicts++
      const real = withStripe.filter(r => !r.email.startsWith('stripe-import+'))
      chosen = (real[real.length - 1] || withStripe[withStripe.length - 1])
      console.warn(`  [CONFLICT] ${ref}: ${distinctIds.size} distinct stripe_account_id values — chose ${chosen.stripe_account_id} (from ${chosen === real[real.length - 1] ? 'newest real account' : 'newest account'}). Rows: ${JSON.stringify(rows)}`)
    }

    const oldWouldHaveBeen = oldPathRow?.stripe_account_id ?? null
    if (oldWouldHaveBeen !== chosen.stripe_account_id) {
      mismatchVsOldReadPath++
      console.warn(`  [DIFFERS FROM OLD READ PATH] ${ref}: old ORDER BY id ASC LIMIT 1 would have served stripe_account_id=${oldWouldHaveBeen}, backfill is writing ${chosen.stripe_account_id}`)
    }

    if (EXECUTE) {
      await sql`
        INSERT INTO disco_restaurant_overrides (restaurant_reference, stripe_account_id, stripe_onboarding_complete, updated_at)
        VALUES (${ref}, ${chosen.stripe_account_id}, ${chosen.stripe_onboarding_complete === true}, NOW())
        ON CONFLICT (restaurant_reference) DO UPDATE
        SET stripe_account_id = EXCLUDED.stripe_account_id,
            stripe_onboarding_complete = EXCLUDED.stripe_onboarding_complete,
            updated_at = NOW()
      `
    }
  }

  console.log('\n--- Summary ---')
  console.log(`clean (exactly one non-null value): ${matched}`)
  console.log(`no stripe_account_id anywhere (backfilled NULL/false): ${noStripeAnywhere}`)
  console.log(`conflicts requiring a tiebreak: ${conflicts}`)
  console.log(`restaurants where the OLD id-ASC-LIMIT-1 read path would have served a DIFFERENT value than this backfill: ${mismatchVsOldReadPath}`)
  if (mismatchVsOldReadPath === 0) console.log('Every restaurant\'s backfilled value matches what the old (lucky) read path was already serving — this is a like-for-like relocation, not a behavior change.')
}

main()
