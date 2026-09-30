/**
 * One-off: link EggBred - Greenville's Stripe account in Disco.
 *
 * FamilyMeal holds acct_1ULPCFKzL5jcSmPt (connected 2026-09-30) and Disco's
 * disco_restaurant_overrides.stripe_account_id was NULL, so the restaurant —
 * Disco-native, live and visible — had no payout path and
 * assertRestaurantOrderable was refusing every order with
 * 'payment-not-configured'.
 *
 * NOT a general FM->Disco Stripe mirror: Peter's ruling is that restaurants will
 * not connect Stripe through FamilyMeal going forward, so this is a correction,
 * not a sync.
 *
 *   npx tsx -r dotenv/config scripts/link-eggbred-greenville-stripe.ts dotenv_config_path=.env.local [--apply]
 */
import { config } from 'dotenv'
config({ path: '.env.local' })
import Stripe from 'stripe'
import { sql } from '../lib/db'

const REF = '64b6308d-4a41-4684-929a-10ed7754acfb'
const ACCT = 'acct_1ULPCFKzL5jcSmPt'
const EXPECT_NAME = 'EggBred - Greenville'

async function main() {
  const apply = process.argv.includes('--apply')
  const key = process.env.STRIPE_LIVE_SECRET_KEY
  if (!key) { console.error('No live Stripe key — refusing to write a payout path unverified.'); process.exit(1) }
  const stripe = new Stripe(key)

  // ── VERIFY BEFORE WRITING ────────────────────────────────────────────────
  // A stripe_account_id is where this restaurant's money will be sent. It is
  // written only after the account is confirmed to exist, to be able to receive
  // funds, and to belong to this restaurant.
  const acct = await stripe.accounts.retrieve(ACCT)
  const healthy = acct.charges_enabled === true && acct.payouts_enabled === true && acct.details_submitted === true
  console.log(`Stripe ${acct.id}`)
  console.log(`  business        : ${acct.business_profile?.name ?? '-'}`)
  console.log(`  email           : ${acct.email ?? '-'}`)
  console.log(`  charges/payouts : ${acct.charges_enabled} / ${acct.payouts_enabled} / details ${acct.details_submitted}`)
  console.log(`  requirements    : due=${acct.requirements?.currently_due?.length ?? 0} disabled=${acct.requirements?.disabled_reason ?? 'none'}`)
  if (!healthy) { console.error('Account is not fully enabled — refusing.'); process.exit(1) }

  const rows = (await sql`
    SELECT c.name, c.is_disco_native, o.stripe_account_id
      FROM disco_restaurant_cache c
      LEFT JOIN disco_restaurant_overrides o ON o.restaurant_reference = c.restaurant_reference
     WHERE c.restaurant_reference = ${REF}
  `) as { name: string; is_disco_native: boolean; stripe_account_id: string | null }[]
  const r = rows[0]
  if (!r) { console.error('Restaurant not found.'); process.exit(1) }
  if (r.name !== EXPECT_NAME) { console.error(`Name mismatch: ${r.name}`); process.exit(1) }
  // Refuse to overwrite a DIFFERENT account — that would redirect settled money.
  if (r.stripe_account_id && r.stripe_account_id !== ACCT) {
    console.error(`Already linked to ${r.stripe_account_id} — refusing to overwrite.`); process.exit(1)
  }
  console.log(`\nDisco: "${r.name}" native=${r.is_disco_native} currently stripe_account_id=${r.stripe_account_id ?? 'NULL'}`)

  if (!apply) { console.log('\nDRY RUN — pass --apply to write.'); return }

  await sql`
    INSERT INTO disco_restaurant_overrides
      (restaurant_reference, stripe_account_id, stripe_onboarding_complete, stripe_connected,
       stripe_charges_enabled, stripe_payouts_enabled, stripe_status, stripe_status_reason,
       stripe_status_checked_at, stripe_checked_at, updated_at)
    VALUES (${REF}, ${ACCT}, true, true, true, true, 'connected', NULL, NOW(), NOW(), NOW())
    ON CONFLICT (restaurant_reference) DO UPDATE SET
      stripe_account_id = ${ACCT}, stripe_onboarding_complete = true, stripe_connected = true,
      stripe_charges_enabled = true, stripe_payouts_enabled = true,
      stripe_status = 'connected', stripe_status_reason = NULL,
      stripe_status_checked_at = NOW(), stripe_checked_at = NOW(), updated_at = NOW()
  `
  await sql`
    INSERT INTO disco_admin_audit (action, restaurant_reference, actor_email, detail)
    VALUES ('stripe_account_linked', ${REF}, 'peter@familymeal.com',
            ${JSON.stringify({ account: ACCT, source: 'FamilyMeal tbl_stripe_connected_accounts', verifiedAgainstLiveStripe: true })}::jsonb)
  `.catch(() => {})
  console.log('linked.')
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
