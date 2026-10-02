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
import { readFileSync } from 'fs'
import { readProgress, appendProgress, importLegacyMap } from '../lib/run-progress'
import { sql } from '../lib/db'
import { convertToNative, importRestaurantStripeAccount } from '../lib/native-conversion'
import { resolveStripeAccountForConversion } from '../lib/stripe-link-resolver'
import { importFmMenuFaithfully } from '../lib/menu-import/fm-faithful-import'

const PROGRESS = 'data/mass-convert-progress.jsonl'
const LEGACY_JSON = 'data/mass-convert-progress.json'
// Excluded by Peter: dormant/test rows, and two live NJ restaurants with no tax
// rate anywhere in FM (they cannot price an order, so they must not convert).
const SKIP_SLUGS = new Set(['tastydawgvip'])
const SKIP_NAMES = new Set(['Good&Fantzye', 'Test Kitchen', '29 Hance Bakehouse', 'Point Lobster Co'])

interface Row { ref: string; name: string; acct: string | null; orders: number }

async function build(): Promise<Row[]> {
  // ── EXPLICIT REF LIST (--refs=<file>) ──────────────────────────────────────
  // The default queue is whatever data/stripe-account-resolutions.json resolved,
  // which is the population that run was built for. A targeted batch — e.g. a
  // bottom-quartile slice expanded to whole restaurant groups — is a different
  // set, so it is passed in rather than inferred. Everything downstream is
  // unchanged: same order (ascending FM order count), same progress file, same
  // skip-and-continue, same restartability.
  const refsArg = process.argv.find(a => a.startsWith('--refs='))
  if (refsArg) {
    const wanted: string[] = JSON.parse(readFileSync(refsArg.slice('--refs='.length), 'utf8'))
    const counts0 = JSON.parse(readFileSync('data/fm-order-counts-504.json', 'utf8')).counts as { ref: string; fmOrders: number | null }[]
    const orderBy0 = new Map(counts0.map(c => [c.ref, c.fmOrders ?? 0]))
    const res0 = JSON.parse(readFileSync('data/stripe-account-resolutions.json', 'utf8'))
    const acct0 = new Map<string, string>()
    for (const r of res0.resolutions as { bucket: string; restaurantReference: string; stripeAccountId: string }[]) {
      if (r.bucket === 'resolved') acct0.set(r.restaurantReference, r.stripeAccountId)
    }
    const rows0 = (await sql`
      SELECT c.restaurant_reference AS ref, c.name, c.slug
      FROM disco_restaurant_cache c
      WHERE c.restaurant_reference = ANY(${wanted}) AND NOT c.is_disco_native
    `) as { ref: string; name: string; slug: string | null }[]
    return rows0
      .map(r => ({ ref: r.ref, name: r.name, acct: acct0.get(r.ref) ?? null, orders: orderBy0.get(r.ref) ?? 0 }))
      .sort((a, b) => a.orders - b.orders || a.name.localeCompare(b.name))
  }

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
  const limit = Number(process.argv.find(a => /^\d+$/.test(a)) || '0') || Infinity
  const stripe = new Stripe(process.env.STRIPE_READONLY_KEY!)
  const queue = await build()
  // APPEND-ONLY. The old map-rewrite lost Hello Halloumi when two runs
  // overlapped — see lib/run-progress.ts.
  const imported = importLegacyMap(LEGACY_JSON, PROGRESS)
  if (imported) console.log(`carried ${imported} record(s) over from ${LEGACY_JSON}`)
  const done: Record<string, unknown> = readProgress(PROGRESS)
  // ── --retry-failed ─────────────────────────────────────────────────────────
  // The skip-what-is-recorded filter is what makes a run restartable, but it
  // also makes a FAILED restaurant permanently unreachable: its failure IS a
  // record, so the retry queue comes back empty. The 2026-09-28 batch left 23
  // restaurants in exactly that state — 22 of them failed on one transient
  // `fetch failed` when the machine slept, and no later run would touch them.
  // With this flag a ref whose LAST record did not convert re-enters the queue;
  // one that converted still never does.
  const retryFailed = process.argv.includes('--retry-failed')
  const todo = queue.filter(q => {
    const rec = done[q.ref] as { converted?: boolean } | undefined
    if (!rec) return true
    return retryFailed && rec.converted !== true
  })
  console.log(`queue ${queue.length} | already recorded ${Object.keys(done).length} | this run ${Math.min(limit, todo.length)}`)
  const unresolvedStripe: string[] = []
  const needsManualLink: string[] = []

  // Tripwire budget — see the check after each restaurant is recorded.
  const MAX_FAILURES = 5
  const MAX_SAME_ERROR = 3
  let failures = 0
  let consecutive = 0
  let lastReason: string | null = null

  let n = 0
  for (const q of todo) {
    if (n >= limit) break
    n++
    const t0 = Date.now()
    const rec: Record<string, unknown> = { name: q.name, ref: q.ref, ordersFm: q.orders }
    try {
      // ── RESOLVE STRIPE AT CONVERSION TIME, NOT FROM A FILE ──────────────
      // The static file is still consulted first (it is correct where it
      // resolved), but it is no longer the only source and no longer the last
      // word. lib/stripe-link-resolver.ts asks Disco, then Stripe's own
      // metadata, then FamilyMeal — live, now, for this restaurant.
      //
      // The file resolves accounts by TRANSFER HISTORY, so an account that has
      // never been paid out cannot appear in it at all. That is precisely the
      // population being converted: 212 restaurants have an account in
      // FamilyMeal and NOT ONE of them is in the file's resolved bucket.
      const resolved = q.acct
        ? { accountId: q.acct, needsManualLink: false, fmHasAccount: null as boolean | null, note: 'from data/stripe-account-resolutions.json' }
        : await resolveStripeAccountForConversion(q.ref, { stripe })
      if (resolved.accountId) {
        const imp = await importRestaurantStripeAccount(q.ref, resolved.accountId, { stripe }) as unknown as Record<string, unknown>
        rec.stripe = (imp.capability as { reusable?: boolean } | undefined)?.reusable ?? imp.reusable ?? null
        rec.stripeSource = resolved.note
      } else if (resolved.needsManualLink) {
        // ── THE CASE THAT USED TO CONVERT SILENTLY ──────────────────────────
        // FamilyMeal holds an account and will not say which. Converting anyway
        // is what put 122 restaurants on the marketplace refusing every order,
        // so the restaurant is converted with ONLINE ORDERING OFF: its data is
        // intact, its menu is intact, and it simply is not offered to customers
        // until a human links the account. Turning it back on is one toggle.
        rec.stripe = 'NEEDS-MANUAL-LINK'
        needsManualLink.push(q.name)
        await sql`
          INSERT INTO disco_restaurant_overrides (restaurant_reference, online_ordering_enabled, updated_at)
          VALUES (${q.ref}, false, NOW())
          ON CONFLICT (restaurant_reference) DO UPDATE SET online_ordering_enabled = false, updated_at = NOW()
        `.catch(() => {})
        console.warn(`  ⚠ ${q.name}: FamilyMeal holds a Stripe account but does not expose which one. Converted with ONLINE ORDERING OFF so it cannot take an order it would refuse — link the account, then turn ordering on.`)
      } else {
        rec.stripe = 'NO-ACCOUNT-ANYWHERE'
        unresolvedStripe.push(q.name)
        console.warn(`  ⚠ ${q.name}: no Stripe account in Disco Cater or FamilyMeal — converted without a payout path.`)
      }
      // ── ALREADY-IMPORTED GUARD ────────────────────────────────────────────
      // importFmMenuFaithfully used to run unconditionally, which made a failed
      // conversion UNRETRYABLE: attempt 1 imports the menu, then a later gate
      // (tax, readiness) refuses, and every retry dies on
      //   duplicate key value violates unique constraint "uq_disco_menus_rest_url"
      // before convertToNative is even reached. 29 Hance Bakehouse hit exactly
      // this on 2026-09-28 and had to be converted by hand; Cotton's Place has
      // been stuck on it since 2026-09-09.
      //
      // So skip the import when this restaurant already HAS a native menu. The
      // import is the expensive, collision-prone step; conversion is the part a
      // retry actually needs to re-run.
      const existing = (await sql`
        SELECT COUNT(*)::int AS menus FROM disco_menus WHERE restaurant_reference = ${q.ref}::uuid
      `.catch(() => [{ menus: 0 }])) as { menus: number }[]
      const alreadyImported = (existing[0]?.menus ?? 0) > 0
      if (alreadyImported) {
        const items = (await sql`
          SELECT COUNT(*)::int AS n FROM disco_menu_items WHERE restaurant_reference = ${q.ref}::uuid
        `.catch(() => [{ n: 0 }])) as { n: number }[]
        rec.menu = { menus: existing[0].menus, items: items[0]?.n ?? 0, groups: 0, links: 0 }
        rec.menuSkipped = 'already imported — reusing the existing native menu so the retry can reach convertToNative'
        console.log(`  ↻ ${q.name}: menu already imported (${existing[0].menus} menus, ${items[0]?.n ?? 0} items) — skipping import`)
      } else {
        const m = await importFmMenuFaithfully(q.ref) as unknown as Record<string, number>
        rec.menu = { menus: m.menus, items: m.items, groups: m.groups, links: m.itemGroupLinks }
      }

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
    appendProgress(PROGRESS, { ...rec, ref: q.ref })

    // ── IN-PROCESS FAILURE TRIPWIRE ─────────────────────────────────────────
    // The previous run's tripwire was an external watcher, so when the ssh
    // connection died the watcher died with it and the run kept going unattended
    // — 20 consecutive `fetch failed` failures accumulated against a database
    // that was simply unreachable, and every one of those restaurants was
    // recorded as failed for a reason that had nothing to do with it. A tripwire
    // that lives in the run itself cannot be separated from the run.
    //
    // Two independent conditions, either of which stops it: a total failure
    // budget, and a same-error streak. The streak is the one that catches an
    // environment that has gone away, because that failure is identical every
    // time.
    if (rec.converted === true) {
      consecutive = 0
      lastReason = null
    } else {
      failures++
      const reason = String(rec.reason ?? '').slice(0, 80)
      consecutive = reason === lastReason ? consecutive + 1 : 1
      lastReason = reason
      if (failures >= MAX_FAILURES || consecutive >= MAX_SAME_ERROR) {
        const why = failures >= MAX_FAILURES
          ? `${failures} failures reached the budget of ${MAX_FAILURES}`
          : `the same error repeated ${consecutive}x consecutively: ${reason}`
        console.error(`\n\u2715 TRIPWIRE: ${why}`)
        console.error('  Stopping rather than continuing. Nothing after this point was attempted.')
        appendProgress(PROGRESS, { ref: '__tripwire__', stoppedAfter: n, failures, consecutive, reason, at: new Date().toISOString() })
        console.error(`\nattempted ${n} | converted ${n - failures} | failed ${failures}`)
        process.exit(2)
      }
    }
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
  if (needsManualLink.length) {
    console.log(`\n⚠ ${needsManualLink.length} restaurant(s) have a Stripe account in FamilyMeal that it will not name.`)
    console.log('  Each was converted with ONLINE ORDERING OFF so it cannot receive an order it would refuse.')
    console.log('  Find the account in the Stripe dashboard, link it, then turn ordering on:')
    for (const n of needsManualLink) console.log(`   - ${n}`)
  }
  if (unresolvedStripe.length) {
    console.log(`\n⚠ ${unresolvedStripe.length} restaurant(s) converted with NO Stripe account resolved — they cannot pay out until one is linked:`)
    for (const n of unresolvedStripe) console.log(`   - ${n}`)
    console.log('  Check FamilyMeal (tbl_stripe_connected_accounts) for an account, verify it in live Stripe, then link it.')
  }
  process.exit(0)
}
main()
