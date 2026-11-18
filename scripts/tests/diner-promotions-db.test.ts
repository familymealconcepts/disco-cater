// Diner promotions against a REAL Postgres (lib/promotions/diner-promotions.ts): every SQL statement the
// module runs, on a throwaway local database. Never production (CLAUDE.md: no probe writes; this repo
// has no transactions). Email is captured, not sent.
//
// Run (needs a local Postgres you can drop tables in):
//   PROMO_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:54329/postgres \
//     node --import tsx --experimental-test-module-mocks scripts/tests/diner-promotions-db.test.ts
// Skips (exit 0) when PROMO_TEST_DATABASE_URL is unset.
import { mock } from 'node:test'
import { readFileSync } from 'node:fs'
import pg from 'pg'

const url = process.env.PROMO_TEST_DATABASE_URL
if (!url) { console.log('PROMO_TEST_DATABASE_URL not set — skipping the database test.'); process.exit(0) }
if (/neon\.tech|amazonaws|vercel/i.test(url)) { console.error('Refusing: PROMO_TEST_DATABASE_URL must be a throwaway local database.'); process.exit(1) }

const pool = new pg.Pool({ connectionString: url })
// A Neon-shaped client: sql`...` (tagged) and sql.query(text, params), both resolving to rows.
function tagged(strings: TemplateStringsArray, ...values: unknown[]) {
  let text = strings[0]
  values.forEach((_, i) => { text += `$${i + 1}` + strings[i + 1] })
  return pool.query(text, values as unknown[]).then((r) => r.rows)
}
const sql = Object.assign(tagged, { query: (text: string, params: unknown[] = []) => pool.query(text, params).then((r) => r.rows) })
const sent: { to: string; subject: string; html: string }[] = []
mock.module(new URL('../../lib/db.ts', import.meta.url).href, { namedExports: { sql } })
mock.module(new URL('../../lib/email/send.ts', import.meta.url).href, {
  namedExports: { sendEmail: async (p: { to: string; subject: string; html: string }) => { sent.push(p); return { success: true, id: '<test>' } } },
})

let passed = 0
const failures: string[] = []
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); passed++; console.log(`  ok  ${name}`) } catch (e) { failures.push(name); console.log(`  FAIL ${name}: ${(e as Error).message}`) }
}
function eq(a: unknown, b: unknown, msg: string) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`) }

const R3P = '11111111-1111-4111-8111-111111111111'   // third-party delivery menu
const ROWN = '22222222-2222-4222-8222-222222222222'  // self-delivery only
const RPICK = '33333333-3333-4333-8333-333333333333' // pickup only

async function schema() {
  await sql.query(`DROP TABLE IF EXISTS disco_diner_promotions, disco_customers, disco_restaurant_cache, disco_restaurant_overrides, disco_menus, disco_orders, disco_sale_transactions, disco_order_events, disco_admin_audit CASCADE`)
  await sql.query(`CREATE TABLE disco_customers (id SERIAL PRIMARY KEY, email TEXT UNIQUE NOT NULL, first_name TEXT, last_name TEXT, disabled_at TIMESTAMPTZ)`)
  await sql.query(`CREATE TABLE disco_restaurant_cache (restaurant_reference TEXT PRIMARY KEY, name TEXT, slug TEXT, image_url TEXT, city TEXT, state TEXT, is_disco_native BOOLEAN, timezone TEXT)`)
  await sql.query(`CREATE TABLE disco_restaurant_overrides (restaurant_reference TEXT PRIMARY KEY, archived_at TIMESTAMPTZ)`)
  await sql.query(`CREATE TABLE disco_menus (id SERIAL PRIMARY KEY, restaurant_reference UUID, visible BOOLEAN, archived BOOLEAN, offers_delivery BOOLEAN, delivery_settings JSONB)`)
  await sql.query(`CREATE TABLE disco_orders (id SERIAL PRIMARY KEY, reference UUID NOT NULL DEFAULT gen_random_uuid(), restaurant_reference UUID, order_date DATE, order_time TIME)`)
  await sql.query(`CREATE TABLE disco_sale_transactions (id SERIAL PRIMARY KEY, order_id INT, transaction_type TEXT, updated_at TIMESTAMPTZ)`)
  await sql.query(`CREATE TABLE disco_order_events (id SERIAL PRIMARY KEY, order_reference UUID, event_type TEXT, event_data JSONB, source TEXT, created_at TIMESTAMPTZ DEFAULT NOW())`)
  // The promotions table and the sale-transaction column exactly as the migration file writes them.
  const mig = readFileSync('lib/migrations/001_disco_orders.sql', 'utf8')
  const block = mig.slice(mig.indexOf('CREATE TABLE IF NOT EXISTS disco_diner_promotions'))
  for (const stmt of block.split(/;\s*\n/).map((s) => s.replace(/^\s*--.*$/gm, '').trim()).filter(Boolean)) await sql.query(stmt)
  await sql.query(`INSERT INTO disco_customers (email, first_name, last_name) VALUES ('dana@example.com', 'Dana', 'Diner'), ('other@example.com', 'Oli', 'Other')`)
  for (const [ref, name, slug] of [[R3P, 'Bagel Place', 'bagel-place'], [ROWN, 'Own Driver Deli', 'own-driver'], [RPICK, 'Pickup Pantry', 'pickup-pantry']]) {
    await sql.query(`INSERT INTO disco_restaurant_cache VALUES ($1, $2, $3, NULL, 'Brooklyn', 'NY', true, 'America/New_York')`, [ref, name, slug])
    await sql.query(`INSERT INTO disco_restaurant_overrides VALUES ($1, NULL)`, [ref])
  }
  await sql.query(`INSERT INTO disco_menus (restaurant_reference, visible, archived, offers_delivery, delivery_settings) VALUES
    ($1, true, false, true, '{"method":"THIRD_PARTY_DELIVERY"}'), ($2, true, false, true, '{"method":"OWN_DELIVERY"}'), ($3, true, false, false, '{}')`, [R3P, ROWN, RPICK])
}

async function main() {
  await schema()
  const P = await import('../../lib/promotions/diner-promotions')
  const dana = (await sql`SELECT id FROM disco_customers WHERE email = 'dana@example.com'`)[0].id as number
  const adminEmail = 'peter@familymeal.com'

  console.log('\n=== Diner promotions (local Postgres) ===')
  await check('only restaurants with a third-party delivery menu can be picked', async () => {
    eq((await P.searchEligibleRestaurants('a')).map((r) => r.name), ['Bagel Place'], 'search')
    const own = await P.createPromotion({ customerId: dana, restaurantReference: ROWN, emailDiner: false, createdBy: adminEmail })
    eq(own.ok, false, 'self-delivery refused')
  })
  await check('diner search by name or email', async () => {
    eq((await P.searchDiners('dana')).map((d) => d.email), ['dana@example.com'], 'by name')
    eq((await P.searchDiners('other@')).map((d) => d.email), ['other@example.com'], 'by email')
  })

  let ref = ''
  await check('create: default 60 days, emailed with an Activate link, audited', async () => {
    const r = await P.createPromotion({ customerId: dana, restaurantReference: R3P, emailDiner: true, note: 'Sorry about the late order', createdBy: adminEmail })
    if (!r.ok) throw new Error(r.error)
    ref = r.promotion.reference
    eq(r.promotion.status, 'OFFERED', 'status')
    eq(r.promotion.expiresOn, P.defaultExpiresOn(), 'expiry')
    eq(r.emailed, true, 'emailed')
    eq(sent[0].subject, "You've got free delivery on your next order from Bagel Place", 'subject')
    if (!sent[0].html.includes(`/account/promotions?activate=${ref}`)) throw new Error('no Activate link')
    const audit = await sql`SELECT action, actor_email FROM disco_admin_audit`
    eq(audit.map((a: { action: string }) => a.action), ['diner_promotion_create'], 'audit')
  })
  await check('one open promotion per diner per restaurant', async () => {
    const r = await P.createPromotion({ customerId: dana, restaurantReference: R3P, emailDiner: false, createdBy: adminEmail })
    eq(r.ok ? 'created' : r.status, 409, 'second refused')
  })
  await check('checkout ignores it until activated; only its own diner can activate', async () => {
    eq(await P.findActivatedFreeDelivery('dana@example.com', R3P), null, 'offered is not usable')
    const wrong = await P.activateForDiner('other@example.com', ref)
    eq(wrong.ok ? 'ok' : wrong.status, 404, 'another diner')
    const a = await P.activateForDiner('dana@example.com', ref)
    eq(a.ok && a.promotion.status, 'ACTIVATED', 'activated')
    const again = await P.activateForDiner('dana@example.com', ref)
    eq(again.ok, true, 'activating twice is fine')
    if (!(await P.findActivatedFreeDelivery('DANA@example.com', R3P))) throw new Error('not found at checkout')
    eq(await P.findActivatedFreeDelivery('dana@example.com', RPICK), null, 'other restaurant')
  })

  const order = async (daysAhead: number) => {
    const o = (await sql.query(`INSERT INTO disco_orders (restaurant_reference, order_date, order_time) VALUES ($1, (NOW() AT TIME ZONE 'America/New_York')::date + $2::int, '12:00') RETURNING id, reference::text AS reference`, [R3P, daysAhead]))[0]
    await sql`INSERT INTO disco_sale_transactions (order_id, transaction_type, disco_promo_delivery_waived) VALUES (${o.id}, 'ORIGINAL', 47.02)`
    return o as { id: number; reference: string }
  }
  const promo = async () => (await P.listForDiner('dana@example.com')).find((p) => p.reference === ref)!

  await check('used once: reserved at placement, recorded with the order', async () => {
    const found = (await P.findActivatedFreeDelivery('dana@example.com', R3P))!
    eq(await P.reserveForOrder(found.id), true, 'reserved')
    eq(await P.reserveForOrder(found.id), false, 'a second order cannot take it')
    const o = await order(5)
    await P.finalizeForOrder(found.id, { orderReference: o.reference, orderNumber: 900009001, waived: 47.02, source: 'TEST' })
    const p = await promo()
    eq([p.status, p.orderNumber, p.waivedAmount], ['USED', 900009001, 47.02], 'used')
    eq(await P.waivedForOrder(o.reference), 47.02, 'frozen waived fee for edits')
    eq(await P.findActivatedFreeDelivery('dana@example.com', R3P), null, 'no longer usable')
  })
  await check('cancelled before delivery: back to Activated, waived fee cleared', async () => {
    const o = (await sql`SELECT reference::text AS reference, id FROM disco_orders ORDER BY id DESC LIMIT 1`)[0]
    eq(await P.releaseForCancelledOrder(o.reference, 'TEST'), true, 'released')
    eq((await promo()).status, 'ACTIVATED', 'activated again')
    eq(Number((await sql`SELECT disco_promo_delivery_waived FROM disco_sale_transactions WHERE order_id = ${o.id}`)[0].disco_promo_delivery_waived), 0, 'report no longer counts it')
    eq((await sql`SELECT event_type FROM disco_order_events WHERE order_reference = ${o.reference}::uuid ORDER BY id`).map((e: { event_type: string }) => e.event_type), ['FREE_DELIVERY_APPLIED', 'FREE_DELIVERY_RESTORED'], 'order history')
  })
  await check('cancelled after the delivery time: stays Used', async () => {
    const found = (await P.findActivatedFreeDelivery('dana@example.com', R3P))!
    await P.reserveForOrder(found.id)
    const o = await order(-1)
    await P.finalizeForOrder(found.id, { orderReference: o.reference, orderNumber: 900009002, waived: 47.02, source: 'TEST' })
    eq(await P.releaseForCancelledOrder(o.reference, 'TEST'), false, 'not released')
    eq((await promo()).status, 'USED', 'still used')
    // An abandoned checkout or a switch to pickup releases regardless of time.
    eq(await P.releaseForOrder(o.reference, 'switched off third-party delivery', 'TEST'), true, 'switch releases')
    eq((await promo()).status, 'ACTIVATED', 'activated again')
  })
  await check('placement failure gives it straight back', async () => {
    const found = (await P.findActivatedFreeDelivery('dana@example.com', R3P))!
    await P.reserveForOrder(found.id)
    await P.releaseReservation(found.id)
    eq((await promo()).status, 'ACTIVATED', 'activated again')
  })
  await check('expired: shown Expired, cannot be activated or used, released ones read Expired', async () => {
    await sql`UPDATE disco_diner_promotions SET expires_at = NOW() - INTERVAL '1 minute' WHERE reference = ${ref}::uuid`
    eq((await promo()).status, 'EXPIRED', 'expired')
    eq(await P.findActivatedFreeDelivery('dana@example.com', R3P), null, 'not usable')
    eq((await P.listPromotions({ status: 'EXPIRED' })).map((p) => p.reference), [ref], 'expired filter')
    eq((await P.listPromotions({ status: 'ACTIVATED' })).length, 0, 'not in Activated')
    // A new one can be given once the old one has expired.
    const r = await P.createPromotion({ customerId: dana, restaurantReference: R3P, emailDiner: false, createdBy: adminEmail })
    if (!r.ok) throw new Error(r.error)
    const off = await P.activateForDiner('dana@example.com', ref)
    eq(off.ok ? 'ok' : off.status, 409, 'expired cannot be activated')
  })
  await check('Super Admin cancels only unused ones; filters work', async () => {
    const open = (await P.listPromotions({ status: 'OFFERED' }))[0]
    eq((await P.cancelPromotion(open.reference, adminEmail)).ok, true, 'cancel offered')
    eq((await P.cancelPromotion(open.reference, adminEmail)).ok, false, 'cancel twice')
    eq((await P.listPromotions({ status: 'CANCELLED' })).map((p) => p.cancelledBy), [adminEmail], 'cancelled by')
    eq((await P.listPromotions({ diner: 'Dana', restaurant: 'bagel', createdBy: 'peter@' })).length, 2, 'diner + restaurant + creator')
    eq((await P.listPromotions({ diner: 'nobody' })).length, 0, 'no match')
  })
  await check('a past expiry date is refused', async () => {
    const r = await P.createPromotion({ customerId: dana, restaurantReference: R3P, expiresOn: '2020-01-01', emailDiner: false, createdBy: adminEmail })
    eq(r.ok ? 'created' : r.status, 400, 'refused')
  })

  await pool.end()
  console.log(`\n${passed} passed, ${failures.length} failed`)
  if (failures.length) process.exit(1)
}
main().catch(async (e) => { console.error(e); await pool.end(); process.exit(1) })
