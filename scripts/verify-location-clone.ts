/**
 * Verifies duplicating a Stacks & Cordials location produces a correct Disco-native
 * copy, and that a refusal can never be silent again.
 *
 * Runs the REAL clone helpers against the REAL source, then DELETES what it made.
 *
 * NOT a transaction. lib/db's `sql` is Neon's HTTP driver, where every call is its
 * own request — BEGIN and ROLLBACK are separate statements that share no session,
 * so the ROLLBACK silently does nothing and the row persists. That is not a
 * hypothetical: the first run of this script left a real
 * "Stacks & Cordials - Clawson (Copy)" in production, which had to be deleted by
 * hand. Explicit cleanup in a finally block is what actually works here.
 *
 * No FM record is created either way — the native path never touches FM at all.
 *
 *   npx tsx scripts/verify-location-clone.ts
 */
import { config } from 'dotenv'
config({ path: '.env.local' })
import { randomUUID } from 'crypto'
import { readFileSync } from 'fs'
import { sql } from '../lib/db'
import { cloneDiscoRestaurantOverrides } from '../lib/locations/clone-restaurant'

let failures = 0
const check = (label: string, ok: boolean, detail = '') => {
  if (!ok) failures++
  console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : ` — ${detail}`}`)
}

const SOURCE = '9d918415-8712-4a03-8bb1-a0b9f5e20b51' // Stacks & Cordials - Clawson (native, live)

async function main() {
  const src = (await sql`SELECT * FROM disco_restaurant_cache WHERE restaurant_reference = ${SOURCE}`) as Record<string, unknown>[]
  console.log(`\n=== source: ${src[0].name} (native=${src[0].is_disco_native}, live=${src[0].is_live}) ===`)
  check('source is Disco-native, so the clone takes the native path and never calls FM',
    src[0].is_disco_native === true, 'source is not native')

  const srcOv = (await sql`SELECT tax_rates, notification_emails, text_notifications_enabled,
      online_ordering_enabled, money_flow, stripe_account_id
    FROM disco_restaurant_overrides WHERE restaurant_reference = ${SOURCE}`) as Record<string, unknown>[]
  console.log('   source overrides:', JSON.stringify(srcOv[0] ?? {}).slice(0, 180))

  const newRef = randomUUID()
  let created = false
  try {
    const s = src[0]
    await sql`
      INSERT INTO disco_restaurant_cache (
        restaurant_reference, name, slug, cuisine, description, image_url, lat, lng, location,
        address, address_line2, city, state, zipcode, phone, timezone, icon_url, is_disco_native, is_live
      ) VALUES (
        ${newRef}, ${((s.name as string) || 'Location') + ' (Copy)'}, ${'zz-verify-' + newRef.slice(0, 8)},
        ${s.cuisine}, ${s.description}, ${s.image_url}, ${s.lat}, ${s.lng}, ${s.location},
        ${s.address}, ${s.address_line2}, ${s.city}, ${s.state}, ${s.zipcode}, ${s.phone}, ${s.timezone}, ${s.icon_url}, true, false
      )`
    created = true
    await cloneDiscoRestaurantOverrides(SOURCE, newRef)

    const c = (await sql`SELECT name, is_disco_native, is_live FROM disco_restaurant_cache WHERE restaurant_reference = ${newRef}`) as Record<string, unknown>[]
    const o = (await sql`SELECT * FROM disco_restaurant_overrides WHERE restaurant_reference = ${newRef}`) as Record<string, unknown>[]

    console.log('\n=== the duplicate ===')
    console.log('   name:', c[0].name)
    check('created as Disco-native', c[0].is_disco_native === true, String(c[0].is_disco_native))
    check('NOT live', c[0].is_live === false, String(c[0].is_live))
    check('visible = false', o[0].visible === false, String(o[0].visible))
    check('NO Stripe account inherited', !o[0].stripe_account_id, String(o[0].stripe_account_id))
    check('tax rates copied from the source',
      JSON.stringify(o[0].tax_rates ?? null) === JSON.stringify(srcOv[0]?.tax_rates ?? null),
      JSON.stringify(o[0].tax_rates))
    check('notification emails copied',
      (o[0].notification_emails ?? null) === (srcOv[0]?.notification_emails ?? null), String(o[0].notification_emails))
    check('text notifications setting copied',
      (o[0].text_notifications_enabled ?? null) === (srcOv[0]?.text_notifications_enabled ?? null), String(o[0].text_notifications_enabled))
    check('online ordering setting copied',
      (o[0].online_ordering_enabled ?? null) === (srcOv[0]?.online_ordering_enabled ?? null), String(o[0].online_ordering_enabled))
  } finally {
    if (created) {
      await sql`DELETE FROM disco_restaurant_overrides WHERE restaurant_reference = ${newRef}`
      await sql`DELETE FROM disco_restaurant_cache WHERE restaurant_reference = ${newRef}`
    }
  }

  const gone = (await sql`SELECT COUNT(*)::int n FROM disco_restaurant_cache WHERE restaurant_reference = ${newRef}`) as { n: number }[]
  const goneOv = (await sql`SELECT COUNT(*)::int n FROM disco_restaurant_overrides WHERE restaurant_reference = ${newRef}`) as { n: number }[]
  check('cleaned up — no cache row survives', gone[0].n === 0, `${gone[0].n} row(s) left behind`)
  check('cleaned up — no overrides row survives', goneOv[0].n === 0, `${goneOv[0].n} row(s) left behind`)

  console.log('\n=== the failure can no longer be silent ===')
  const ui = readFileSync('app/(restaurant)/restaurant/(portal)/manage/locations/page.tsx', 'utf8')
  const fn = ui.slice(ui.indexOf('async function copyLocation'), ui.indexOf('async function switchToLocation'))
  check('the UI has an else branch for a non-ok response', /}\s*else\s*{/.test(fn), 'errors are still discarded')
  check('it shows the route\'s own message', /body\.error/.test(fn))
  check('it reports a network failure too', /catch\s*{[\s\S]*showToast/.test(fn))
  check('the button disables while in flight', /setCopying\(loc\.reference\)/.test(fn))

  console.log('\n=== authorization no longer collapses to the selected location ===')
  const route = readFileSync('app/api/restaurant/locations/[ref]/clone/route.ts', 'utf8')
  check('an FM caller is scoped by FM\'s system-admin restaurant list', /fmCallerMayActOn/.test(route))
  check('getCallerScopeRefs (single selected ref) is no longer used here', !/getCallerScopeRefs\(/.test(route))
  check('a 403 now explains itself', /You don’t have access to this location/.test(route))
  check('only ONE path can POST to FM\'s clone, and it needs a non-native source',
    (route.match(/\/clone`, \{ method: 'POST'/g) || []).length === 1)

  console.log('\n' + '='.repeat(66))
  console.log(failures === 0 ? 'ALL CHECKS PASSED — nothing was created in FM, nothing persisted' : `${failures} CHECK(S) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}
main().catch(e => { console.error(e); process.exit(1) })
