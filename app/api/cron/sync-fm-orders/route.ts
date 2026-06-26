// Cron: sync FM orders into Neon for restaurants whose portal is never opened.
//
// Runs every 15 minutes (see vercel.json). Restaurants only otherwise sync when
// someone opens their orders page, so quiet locations would drift. This rotates
// through the restaurant cache in bounded batches (a cursor in sync_state), so
// every restaurant is reconciled over a full cycle without any single run
// exceeding the function-duration limit.
//
// REQUIRED ENV: CRON_SECRET — Vercel Cron sends it as `Authorization: Bearer …`.

import { NextRequest, NextResponse } from 'next/server'
import { sql, runMigrations } from '../../../../lib/db'
import { syncAllRestaurantOrders } from '../../../../lib/fm-orders-sync'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

const BATCH = 25
const CURSOR_KEY = 'fm_orders_sync_offset'

function hasCronSecret(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return false
  const auth = req.headers.get('authorization') || ''
  return auth === `Bearer ${secret}` || auth === secret
}

async function readCursor(): Promise<number> {
  try {
    const rows = (await sql`SELECT value FROM sync_state WHERE key = ${CURSOR_KEY}`) as { value: string }[]
    const n = rows[0] ? parseInt(rows[0].value, 10) : 0
    return Number.isFinite(n) && n >= 0 ? n : 0
  } catch { return 0 }
}
async function writeCursor(offset: number): Promise<void> {
  try {
    await sql`
      INSERT INTO sync_state (key, value, updated_at) VALUES (${CURSOR_KEY}, ${String(offset)}, NOW())
      ON CONFLICT (key) DO UPDATE SET value = ${String(offset)}, updated_at = NOW()
    `
  } catch { /* best-effort */ }
}

async function handle(req: NextRequest): Promise<NextResponse> {
  if (!hasCronSecret(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const startedAt = Date.now()
  try {
    await runMigrations()
    const offset = await readCursor()
    const { restaurants, results } = await syncAllRestaurantOrders({ withItems: false, limit: BATCH, offset, maxPages: 1 })
    // Advance the cursor; wrap to 0 when this batch was the tail.
    await writeCursor(restaurants < BATCH ? 0 : offset + BATCH)

    const synced = results.reduce((a, r) => a + r.inserted + r.updated, 0)
    const duration_ms = Date.now() - startedAt
    console.log(`[cron/sync-fm-orders] offset=${offset} restaurants=${restaurants} synced=${synced} (${duration_ms}ms)`)
    return NextResponse.json({ synced, restaurants, offset, duration_ms })
  } catch (e) {
    console.error('[cron/sync-fm-orders] failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'sync failed', duration_ms: Date.now() - startedAt }, { status: 500 })
  }
}

export async function GET(req: NextRequest) { return handle(req) }
export async function POST(req: NextRequest) { return handle(req) }
