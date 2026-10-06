// Link each Disco-native restaurant to the Stripe connected account FAMILYMEAL
// already holds for it.
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
// Conversion resolved accounts from data/stripe-account-resolutions.json, which
// buckets accounts by TRANSFER HISTORY. An account that has never been paid out
// cannot be resolved there — exactly the population that converts — so 212
// restaurants converted with no payout path and, until the marketplace rule was
// fixed, went live refusing every order.
//
// FamilyMeal's own familymeal.tbl_stripe_connected_accounts carries the mapping
// as (restaurant_reference -> stripe_account_id). That is the authority: not a
// name, not a guess. Name matching was measured and rejected — "Black Seed
// Bagels" matches an account called "Black Market BBQ LLC", and a wrong link
// sends one restaurant's money to another business.
//
// ── SAFETY ──────────────────────────────────────────────────────────────────
//   * FamilyMeal is READ ONLY. One SELECT. Never a write, ever.
//   * Stripe is read through the READ-ONLY rk_live key.
//   * EVERY account is retrieved from live Stripe before anything is written.
//     An account that cannot be retrieved is not linked.
//   * An account that is restricted / disabled / past due is NOT linked. It is
//     reported for a human decision — linking it would mark a restaurant
//     payment-ready when Stripe will decline the charge.
//   * An account already linked to a DIFFERENT restaurant is not stolen.
//   * Writes go to Neon only, and only disco_restaurant_overrides.
//
// Dry run by default. --apply writes.
import { config } from 'dotenv'
config({ path: '.env.local', quiet: true })
import { Client } from 'pg'
import Stripe from 'stripe'
import { sql } from '../lib/db'
import { writeFileSync } from 'fs'

const APPLY = process.argv.includes('--apply')
const OUT = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : ''
const unq = (v?: string) => (v || '').replace(/^["']|["']$/g, '')

type Neon = { ref: string; name: string; visible: boolean; ordering: boolean }
type Acct = {
  id: string; exists: boolean; name: string
  charges: boolean; payouts: boolean; disabled: string | null; pastDue: string[]
  detailsSubmitted: boolean; error?: string
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
/** Enough shared significant words that a human need not be asked. */
function namesAgree(a: string, b: string): boolean {
  const STOP = new Set(['the','and','co','inc','llc','ltd','company','restaurant','cafe','kitchen','bar','grill','of','a'])
  const t = (x: string) => norm(x).split(' ').filter(w => w && !STOP.has(w))
  const A = t(a), B = t(b)
  if (!A.length || !B.length) return false
  const shared = A.filter(w => B.includes(w))
  return shared.length >= 2 || shared.some(w => w.length >= 6) || norm(a) === norm(b)
}

async function main() {
  // ── 1. The population ────────────────────────────────────────────────────
  const targets = (await sql`
    SELECT c.restaurant_reference::text AS ref, c.name,
           COALESCE(o.visible,false) AS visible,
           COALESCE(o.online_ordering_enabled,false) AS ordering
      FROM disco_restaurant_cache c
      JOIN disco_restaurant_overrides o ON o.restaurant_reference = c.restaurant_reference
     WHERE c.is_disco_native = true AND o.archived_at IS NULL AND o.stripe_account_id IS NULL
     ORDER BY c.name
  `) as Neon[]
  console.log(`Disco-native, unarchived, no Stripe account in Disco: ${targets.length}`)

  // ── 2. FamilyMeal's own mapping. ONE SELECT. READ ONLY. ──────────────────
  const fm = new Client({
    host: '127.0.0.1', port: 55432,
    database: unq(process.env.FM_DB_NAME_OVERRIDE || process.env.FM_DB_NAME),
    user: unq(process.env.FM_DB_USER_OVERRIDE || process.env.FM_DB_USER),
    password: unq(process.env.FM_DB_PASSWORD_OVERRIDE || process.env.FM_DB_PASSWORD),
    ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 20000,
  })
  await fm.connect()
  const res = await fm.query(
    `SELECT restaurant_reference::text AS ref, stripe_account_id, created_date
       FROM familymeal.tbl_stripe_connected_accounts
      WHERE restaurant_reference::text = ANY($1::text[])
        AND stripe_account_id IS NOT NULL
      ORDER BY restaurant_reference, created_date DESC NULLS LAST`,
    [targets.map(t => t.ref)],
  )
  await fm.end()

  const byRef = new Map<string, { id: string; created: string | null }[]>()
  for (const r of res.rows) {
    const list = byRef.get(r.ref) ?? []
    if (!list.some(x => x.id === r.stripe_account_id)) list.push({ id: r.stripe_account_id, created: r.created_date })
    byRef.set(r.ref, list)
  }
  const mapped = targets.filter(t => (byRef.get(t.ref) ?? []).length > 0)
  const single = targets.filter(t => (byRef.get(t.ref) ?? []).length === 1)
  const multi = targets.filter(t => (byRef.get(t.ref) ?? []).length > 1)
  const unmapped = targets.filter(t => (byRef.get(t.ref) ?? []).length === 0)
  console.log(`\nFamilyMeal's tbl_stripe_connected_accounts:`)
  console.log(`  rows returned                : ${res.rows.length}`)
  console.log(`  restaurants with a mapping   : ${mapped.length}`)
  console.log(`    - exactly one account      : ${single.length}`)
  console.log(`    - MORE than one account    : ${multi.length}`)
  console.log(`  no mapping in FamilyMeal     : ${unmapped.length}`)

  // ── 3. Live Stripe, read-only, every account individually ────────────────
  const stripe = new Stripe(unq(process.env.STRIPE_READONLY_KEY))
  const wantIds = [...new Set(mapped.flatMap(t => (byRef.get(t.ref) ?? []).map(a => a.id)))]
  console.log(`\nVerifying ${wantIds.length} distinct accounts against live Stripe (read-only)…`)
  const acct = new Map<string, Acct>()
  let i = 0
  async function worker() {
    while (i < wantIds.length) {
      const id = wantIds[i++]
      try {
        const a = await stripe.accounts.retrieve(id)
        acct.set(id, {
          id, exists: true,
          name: a.business_profile?.name || (a as any).settings?.dashboard?.display_name || '',
          charges: a.charges_enabled === true, payouts: a.payouts_enabled === true,
          disabled: (a as any).requirements?.disabled_reason ?? null,
          pastDue: ((a as any).requirements?.past_due || []) as string[],
          detailsSubmitted: (a as any).details_submitted === true,
        })
      } catch (e: any) {
        acct.set(id, { id, exists: false, name: '', charges: false, payouts: false, disabled: null, pastDue: [], detailsSubmitted: false, error: e?.message?.slice(0, 90) })
      }
    }
  }
  await Promise.all(Array.from({ length: 6 }, worker))

  // Accounts already linked to a DIFFERENT restaurant — never reassigned.
  const taken = new Map<string, string>()
  for (const r of (await sql`
    SELECT stripe_account_id, restaurant_reference::text AS ref FROM disco_restaurant_overrides
    WHERE stripe_account_id IS NOT NULL
  `) as { stripe_account_id: string; ref: string }[]) taken.set(r.stripe_account_id, r.ref)

  // ── 4. Classify ──────────────────────────────────────────────────────────
  const link: any[] = [], unhealthy: any[] = [], refused: any[] = [], nameFlag: any[] = []
  for (const t of single) {
    const id = byRef.get(t.ref)![0].id
    const a = acct.get(id)!
    const row = { ref: t.ref, restaurant: t.name, accountId: id, accountName: a.name, visible: t.visible, ordering: t.ordering, charges: a.charges, payouts: a.payouts, disabled: a.disabled, pastDue: a.pastDue }
    if (!a.exists) {
      // Verified with BOTH the read-only and the full secret key: Stripe answers
      // "does not have access to account ... Application access may have been
      // revoked". The connection is gone or the account is deleted, so Disco
      // could not charge through it even if it were linked. Refused, not
      // deferred — this is an answer, not a tooling limit.
      refused.push({ ...row, why: `Stripe will not return this account — connection revoked or account deleted` })
      continue
    }
    const other = taken.get(id)
    if (other && other !== t.ref) { refused.push({ ...row, why: `already linked to another restaurant (${other})` }); continue }
    if (a.disabled || a.pastDue.length || !a.charges) {
      unhealthy.push({ ...row, why: a.disabled ? `disabled_reason=${a.disabled}` : !a.charges ? 'charges disabled' : `past_due: ${a.pastDue.slice(0,3).join(', ')}` })
      continue
    }
    if (a.name && !namesAgree(t.name, a.name)) nameFlag.push(row)
    link.push(row)
  }
  for (const t of multi) {
    const ids = byRef.get(t.ref)!
    refused.push({ ref: t.ref, restaurant: t.name, why: `FamilyMeal maps ${ids.length} accounts to this restaurant — a human must choose`, candidates: ids.map(x => ({ id: x.id, ...acct.get(x.id) })) })
  }

  console.log(`\nCLASSIFICATION`)
  console.log(`  healthy, will link        : ${link.length}   (${nameFlag.length} with a name worth a glance)`)
  console.log(`  restricted / past due     : ${unhealthy.length}  — NOT linked, needs a decision`)
  console.log(`  refused for another reason: ${refused.length}`)

  if (unhealthy.length) {
    console.log(`\n── NOT LINKED: Stripe has stopped or is about to stop these ──`)
    for (const u of unhealthy) console.log(`   ${String(u.restaurant).slice(0,38).padEnd(38)} ${u.accountId}  ${u.why}`)
  }
  if (refused.length) {
    console.log(`\n── REFUSED ──`)
    for (const r of refused) console.log(`   ${String(r.restaurant).slice(0,38).padEnd(38)} ${r.why}`)
  }
  if (nameFlag.length) {
    console.log(`\n── LINKED, BUT THE NAMES DIVERGE (FamilyMeal's mapping is unambiguous; worth a human glance) ──`)
    for (const n of nameFlag) console.log(`   ${String(n.restaurant).slice(0,38).padEnd(38)} -> "${n.accountName}"  ${n.accountId}`)
  }

  // ── 5. Write ─────────────────────────────────────────────────────────────
  if (APPLY) {
    let n = 0
    for (const l of link) {
      // Every field written is a value just READ FROM LIVE STRIPE, not an
      // assumption. onboarding_complete mirrors details_submitted rather than
      // being hardcoded true, and the status snapshot is filled in so the
      // super-admin column, the portal and the marketplace all tell the same
      // story the moment this lands.
      const a = acct.get(l.accountId)!
      await sql`
        INSERT INTO disco_restaurant_overrides (
          restaurant_reference, stripe_account_id, stripe_onboarding_complete, stripe_connected,
          stripe_charges_enabled, stripe_payouts_enabled, stripe_status, stripe_status_reason,
          stripe_status_checked_at, updated_at)
        VALUES (${l.ref}, ${l.accountId}, ${a.detailsSubmitted}, true,
          ${a.charges}, ${a.payouts}, 'connected', NULL, NOW(), NOW())
        ON CONFLICT (restaurant_reference) DO UPDATE SET
          stripe_account_id = EXCLUDED.stripe_account_id,
          stripe_onboarding_complete = EXCLUDED.stripe_onboarding_complete,
          stripe_connected = true,
          stripe_charges_enabled = EXCLUDED.stripe_charges_enabled,
          stripe_payouts_enabled = EXCLUDED.stripe_payouts_enabled,
          stripe_status = 'connected',
          stripe_status_reason = NULL,
          stripe_status_checked_at = NOW(),
          updated_at = NOW()
        -- NEVER OVERWRITE AN ACCOUNT DISCO ALREADY HOLDS. The target list is
        -- already stripe_account_id IS NULL, but that was read minutes ago and
        -- the portal's own Stripe connect flow can land in between — One Lev was
        -- linked that way mid-investigation on 2026-10-05. Repeating the
        -- predicate here makes "never overwrite" a property of the WRITE rather
        -- than of the read that preceded it. Taim is why it matters: two
        -- accounts existed and DISCO'S WAS THE CORRECT ONE, so a write that won
        -- a race would have moved a live restaurant's payouts to the wrong
        -- account.
        WHERE disco_restaurant_overrides.stripe_account_id IS NULL
      `
      n++
    }
    console.log(`\nLINKED ${n} restaurant(s).`)
  } else {
    console.log(`\nDRY RUN — nothing written. Re-run with --apply.`)
  }

  if (OUT) { writeFileSync(OUT, JSON.stringify({ link, unhealthy, refused, nameFlag, unmapped: unmapped.map(u => u.name) }, null, 2)); console.log(`wrote ${OUT}`) }
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
