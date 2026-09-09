/**
 * Mass conversion runner — serial, invites suppressed, restartable.
 *
 * Order: ASCENDING by FM order count. The fast, low-risk restaurants go first,
 * so a systemic fault surfaces in the first minutes against a restaurant with
 * two orders rather than one with 4,585.
 *
 * SKIP-AND-CONTINUE, never abort. convertToNative refuses BEFORE it writes
 * anything (readiness, then the order-history backfill hard gate), so a failure
 * leaves the restaurant FM-backed and untouched. Re-running a converted
 * restaurant returns "Already Disco-native" and writes nothing, so the whole
 * script is safe to restart from the top.
 *
 * Progress is appended to data/mass-convert-progress.json after every
 * restaurant, so an interrupted run can be resumed and audited.
 *
 * Usage: npx tsx --env-file=.env.local scripts/mass-convert.ts [limit]
 */
import Stripe from 'stripe'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { sql } from '../lib/db'
import { convertToNative, importRestaurantStripeAccount } from '../lib/native-conversion'
import { importFmMenuFaithfully } from '../lib/menu-import/fm-faithful-import'

const PROGRESS = 'data/mass-convert-progress.json'
// Excluded by Peter: dormant/test rows, and two live NJ restaurants with no tax
// rate anywhere in FM (they cannot price an order, so they must not convert).
const SKIP_SLUGS = new Set(['tastydawgvip'])
const SKIP_NAMES = new Set(['Good&Fantzye', 'Test Kitchen', '29 Hance Bakehouse', 'Point Lobster Co'])

interface Row { ref: string; name: string; acct: string | null; orders: number }

async function build(): Promise<Row[]> {
  const res = JSON.parse(readFileSync('data/stripe-account-resolutions.json', 'utf8'))
  const acctByRef = new Map<string, string>()
  for (const r of res.resolutions as { bucket: string; restaurantReference: string; stripeAccountId: string }[]) {
    if (r.bucket === 'resolved') acctByRef.set(r.restaurantReference, r.stripeAccountId)
  }
  const counts = JSON.parse(readFileSync('data/fm-order-counts-504.json', 'utf8')).counts as { ref: string; fmOrders: number | null }[]
  const orderByRef = new Map(counts.map(c => [c.ref, c.fmOrders ?? 0]))

  const rows = (await sql`
    SELECT c.restaurant_reference AS ref, c.name, c.slug
    FROM disco_restaurant_cache c
    WHERE c.restaurant_reference = ANY(${[...acctByRef.keys()]}) AND NOT c.is_disco_native
  `) as { ref: string; name: string; slug: string | null }[]

  return rows
    .filter(r => !SKIP_NAMES.has(r.name) && !SKIP_SLUGS.has(r.slug ?? ''))
    .map(r => ({ ref: r.ref, name: r.name, acct: acctByRef.get(r.ref) ?? null, orders: orderByRef.get(r.ref) ?? 0 }))
    .sort((a, b) => a.orders - b.orders || a.name.localeCompare(b.name))
}

async function main() {
  const limit = Number(process.argv[2] || '0') || Infinity
  const stripe = new Stripe(process.env.STRIPE_READONLY_KEY!)
  const queue = await build()
  const done: Record<string, unknown> = existsSync(PROGRESS)
    ? JSON.parse(readFileSync(PROGRESS, 'utf8')) : {}
  const todo = queue.filter(q => !done[q.ref])
  console.log(`queue ${queue.length} | already recorded ${Object.keys(done).length} | this run ${Math.min(limit, todo.length)}`)

  let n = 0
  for (const q of todo) {
    if (n >= limit) break
    n++
    const t0 = Date.now()
    const rec: Record<string, unknown> = { name: q.name, ref: q.ref, ordersFm: q.orders }
    try {
      if (q.acct) {
        const imp = await importRestaurantStripeAccount(q.ref, q.acct, { stripe }) as unknown as Record<string, unknown>
        rec.stripe = (imp.capability as { reusable?: boolean } | undefined)?.reusable ?? imp.reusable ?? null
      }
      const m = await importFmMenuFaithfully(q.ref) as unknown as Record<string, number>
      rec.menu = { menus: m.menus, items: m.items, groups: m.groups, links: m.itemGroupLinks }

      const r = await convertToNative(q.ref, { stripe, skipInvites: true, actorEmail: 'peter@familymeal.com' }) as unknown as Record<string, unknown>
      rec.converted = r.converted
      rec.isLive = (r.readiness as { isLive?: boolean } | undefined)?.isLive ?? null
      rec.link = (r.multiUnitLink as { status?: string } | undefined)?.status ?? null
      rec.orders = (r.orderStats as { after?: { count?: number } } | undefined)?.after?.count ?? null
      if (!r.converted) rec.reason = String(r.reason).slice(0, 160)
    } catch (e) {
      rec.converted = false
      rec.reason = 'THREW: ' + (e instanceof Error ? e.message : String(e)).slice(0, 160)
    }
    rec.seconds = Number(((Date.now() - t0) / 1000).toFixed(1))
    done[q.ref] = rec
    writeFileSync(PROGRESS, JSON.stringify(done, null, 1) + '\n')
    console.log(
      String(n).padStart(3) + '.',
      String(q.name).slice(0, 30).padEnd(32),
      String(q.orders).padStart(5) + 'o',
      String(rec.seconds).padStart(6) + 's',
      rec.converted ? 'OK  live=' + rec.isLive + ' link=' + rec.link + ' items=' + (rec.menu as Record<string, number>)?.items
        : 'FAIL ' + rec.reason,
    )
  }
  const all = Object.values(done) as { converted?: boolean }[]
  console.log(`\nrecorded ${all.length} | converted ${all.filter(x => x.converted).length} | failed ${all.filter(x => !x.converted).length}`)
  process.exit(0)
}
main()
