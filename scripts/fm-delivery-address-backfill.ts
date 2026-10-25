// One-off backfill: delivery address + delivery instructions for FamilyMeal
// delivery orders already copied into disco_orders without them.
//
// READ-ONLY to FamilyMeal: one GET /public-api/v2/orders/{ref}/details per
// order, through the existing FM service login, ONE AT A TIME with a pause
// between calls. Writes to Neon ONLY empty address/instruction fields, through
// the same fillDeliveryAddress() the sync uses (lib/fm-delivery-address.ts) —
// never amounts, status, tips, fees, payouts or anything else.
//
// Upcoming orders first, then newest to oldest.
//
//   npx tsx scripts/fm-delivery-address-backfill.ts --cache=<file>            dry run: reads FM, caches
//                                                                             what it found, writes nothing
//   npx tsx scripts/fm-delivery-address-backfill.ts --cache=<file> --apply    writes from the cache
//                                                                             (re-reads FM only for orders the
//                                                                             dry run couldn't read)
// Options: --limit=N  --pause-ms=250
//
// The cache holds customers' addresses — keep it outside the repo and delete it
// when done.

import { config } from 'dotenv'
config({ path: '.env.local', quiet: true })
import { existsSync, readFileSync, appendFileSync } from 'fs'

type Cached = { id: number; fmRef: string; ok: boolean; deliveryAddress: Record<string, unknown> | null }

function arg(name: string): string | undefined {
  const a = process.argv.find(x => x.startsWith(`--${name}=`))
  return a ? a.slice(name.length + 3) : undefined
}

async function main() {
  const { sql } = await import('../lib/db')
  const { fetchFmOrderDetail, fillDeliveryAddress, fmDeliveryAddressFrom } = await import('../lib/fm-delivery-address')
  const apply = process.argv.includes('--apply')
  const cachePath = arg('cache')
  if (!cachePath) throw new Error('--cache=<file> is required')
  const limit = Number(arg('limit') || 0) || null
  const pauseMs = Number(arg('pause-ms') || 250)

  const rows = (await sql`
    SELECT id, fm_order_reference::text AS fm_ref, (order_date >= CURRENT_DATE) AS upcoming
    FROM disco_orders
    WHERE order_type = 'DELIVERY' AND fm_order_reference IS NOT NULL AND is_deleted = false
      AND delivery_address_line1 IS NULL
    ORDER BY (order_date >= CURRENT_DATE) DESC,
             CASE WHEN order_date >= CURRENT_DATE THEN order_date END ASC,
             order_date DESC, id DESC
  `) as { id: number; fm_ref: string; upcoming: boolean }[]
  const todo = limit ? rows.slice(0, limit) : rows
  console.log(`${apply ? 'APPLY' : 'DRY RUN'}: ${rows.length} FM delivery orders with no address (${rows.filter(r => r.upcoming).length} upcoming); handling ${todo.length}`)

  const cache = new Map<number, Cached>()
  if (existsSync(cachePath)) {
    for (const line of readFileSync(cachePath, 'utf8').split('\n')) {
      if (!line.trim()) continue
      const c = JSON.parse(line) as Cached
      if (c.ok || !cache.has(c.id)) cache.set(c.id, c)
    }
  }

  const tally = { fmRead: 0, fromCache: 0, failed: 0, withAddress: 0, withInstructions: 0, noAddress: 0, trimmed: 0, verbatim: 0, filled: 0, kept: 0, markedNone: 0 }
  const t0 = Date.now()
  for (const [i, r] of todo.entries()) {
    let c = cache.get(r.id)
    if (c?.ok) tally.fromCache++
    else {
      const details = await fetchFmOrderDetail(r.fm_ref, 20_000)
      const order = (((details?.data as Record<string, unknown>)?.order as Record<string, unknown>) ?? null)
      c = { id: r.id, fmRef: r.fm_ref, ok: !!details, deliveryAddress: (order?.deliveryAddress as Record<string, unknown>) ?? null }
      appendFileSync(cachePath, JSON.stringify(c) + '\n')
      tally.fmRead++
      await new Promise(res => setTimeout(res, pauseMs))
    }
    if (!c.ok) { tally.failed++; continue }
    const synthetic = { data: { order: { deliveryAddress: c.deliveryAddress } } }
    const a = fmDeliveryAddressFrom(synthetic)
    if (!a || !a.line1) tally.noAddress++
    else {
      tally.withAddress++
      if (a.line1 === String(c.deliveryAddress?.addressLine1 ?? '').trim()) tally.verbatim++; else tally.trimmed++
    }
    if (a?.instructions) tally.withInstructions++
    if (apply) {
      const res = await fillDeliveryAddress(r.id, synthetic, { markNone: true })
      if (res === 'filled') tally.filled++
      else if (res === 'kept') tally.kept++
      if (!a || !a.line1) tally.markedNone++
    }
    if ((i + 1) % 250 === 0) console.log(`  ${i + 1}/${todo.length} · ${Math.round((Date.now() - t0) / 1000)}s · ${JSON.stringify(tally)}`)
  }
  console.log(`done in ${Math.round((Date.now() - t0) / 1000)}s`, tally)
}

main().catch(e => { console.error(e); process.exit(1) })
