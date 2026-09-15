/**
 * Verifies that the courier actually receives the customer's delivery instructions, and that
 * the payload still signs.
 *
 *   npx tsx scripts/verify-expedite-instructions.ts          # offline: payload only, no network
 *   npx tsx scripts/verify-expedite-instructions.ts --live   # + a live dlivrd signature probe
 *
 * NOTHING IS EVER DISPATCHED. The --live probe takes each real payload, REPLACES its
 * external_delivery_id with a freshly generated UUID, and posts it as delivery_cancelled. dlivrd
 * answers 404 "unknown delivery id", which proves the signature was accepted over that exact
 * payload content without any real delivery existing to affect. A 401 would mean rejected.
 *
 * WHY THIS EXISTS. Two claims about this integration were asserted from reading code and both
 * needed live evidence before they could be trusted:
 *
 *   1. "instructions are sent"  — FALSE. The field was declared on ExpediteTask from day one and
 *      populated nowhere, so no courier ever received a delivery instruction. Now fixed; this
 *      script is what stops it silently regressing, because the failure is invisible from our
 *      side — dispatch succeeds either way and only the driver knows something is missing.
 *
 *   2. "non-ASCII breaks signing" — ALSO FALSE, and it was asserted here first. FamilyMeal escapes
 *      non-ASCII to \\uXXXX before signing, and their code says it was added to fix a signature
 *      mismatch, so the same bug was assumed to exist here. It does not. FM's actual fault was
 *      SERIALIZING TWICE (once for the signature, once by RestTemplate for the body) and the two
 *      serializations disagreeing; their fix is commented `// serialize only once`. dlivrd HMACs
 *      the raw request bytes, so any encoding works provided the signed string and the wire body
 *      are the same string. Measured against live dlivrd on 2026-09-15: curly apostrophe, en-dash,
 *      accented character and an astral emoji were ALL accepted with raw UTF-8 and no escaping.
 *      Do not "fix" this by escaping — escaping one side and not the other is how you break it.
 */
import { config } from 'dotenv'
config({ path: '.env.local' })

import { randomUUID } from 'crypto'
import { sql } from '../lib/db'
import { buildPayloadFromNeon, buildExpediteHeaders, BASE_URL } from '../lib/expedite'

const LIVE = process.argv.includes('--live')

// CREDENTIALS ARE NOT IN .env.local AND MUST NOT BE COMMITTED HERE. They live only in Vercel
// (EXPEDITE_TOKEN / EXPEDITE_DISPATCH_SECRET, both Sensitive). Without them buildExpediteHeaders
// signs with an empty secret and EVERY probe comes back 401 — which reads exactly like a real
// signature regression and is not one. Refuse to run rather than report that, because a false
// "signing is broken" is worse than no result: it invites someone to "fix" working code.
if (LIVE && !(process.env.EXPEDITE_TOKEN && process.env.EXPEDITE_DISPATCH_SECRET)) {
  console.error('\n--live needs EXPEDITE_TOKEN and EXPEDITE_DISPATCH_SECRET in the environment.')
  console.error('They are Sensitive in Vercel and are deliberately not stored in this repo.')
  console.error('Supply them for one run, e.g.:\n')
  console.error('   EXPEDITE_TOKEN=... EXPEDITE_DISPATCH_SECRET=... npx tsx scripts/verify-expedite-instructions.ts --live\n')
  console.error('Without --live the payload checks below still run and need no credentials.')
  process.exit(2)
}
let failures = 0
const check = (ok: boolean, label: string) => {
  if (!ok) failures++
  console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${label}`)
}

async function main() {
  const rows = (await sql`
    SELECT order_number, reference::text AS reference, order_date::text AS od, restaurant_name,
           delivery_instructions, note
      FROM disco_orders
     WHERE is_deleted = false AND order_type = 'DELIVERY' AND delivery_type = 'THIRD_PARTY_DELIVERY'
       AND order_date >= CURRENT_DATE AND order_date < CURRENT_DATE + INTERVAL '30 days'
     ORDER BY order_date, order_number`) as Array<Record<string, string | null>>

  console.log(`\nupcoming third-party-delivery orders: ${rows.length}${LIVE ? '  (live signature probe ON)' : '  (offline)'}\n`)

  for (const r of rows) {
    const p = await buildPayloadFromNeon(String(r.reference))
    console.log(`#${r.order_number}  ${r.od}  ${r.restaurant_name}`)
    if (!p) { check(false, 'payload builds'); continue }

    const dropoff = p.tasks[1]
    const pickup = p.tasks[0]
    const expected = (r.delivery_instructions || '').trim() || undefined

    check((dropoff.instructions ?? undefined) === expected,
      `dropoff.instructions is the customer's own text${expected ? `: ${JSON.stringify(expected.slice(0, 60))}` : ' (none on this order)'}`)
    // The restaurant must never be shown the customer's gate code or door instructions.
    check(pickup.instructions === undefined, 'pickup task carries NO instructions (dropoff only)')
    // note is a different field with a different audience and is deliberately not sent.
    if (r.note) check(!JSON.stringify(p).includes(String(r.note)), 'disco_orders.note is NOT leaked into the courier payload')

    if (LIVE) {
      const probe = { ...p, external_delivery_id: randomUUID() }
      const wire = JSON.stringify(probe)
      const headers = { ...buildExpediteHeaders(wire), 'X-Expedite-Event': 'delivery_cancelled' }
      const res = await fetch(BASE_URL, { method: 'POST', headers, body: wire })
      const na = JSON.stringify(p).match(/[^\x00-\x7F]/g)
      check(res.status !== 401,
        `live signature accepted (HTTP ${res.status})${na ? ` — payload contains non-ASCII ${JSON.stringify([...new Set(na)].join(''))}` : ''}`)
    }
  }

  console.log('\n' + '='.repeat(66))
  console.log(failures === 0 ? 'ALL CHECKS PASSED — nothing dispatched' : `${failures} CHECK(S) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch(e => { console.error(e); process.exit(1) })
