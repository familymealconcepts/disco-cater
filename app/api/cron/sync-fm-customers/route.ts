// Daily cron: mirror FM's platform-wide customer list into
// disco_customer_roster (lib/fm-customer-sync.ts) so /api/export/customers
// can read Neon instead of paging FM live (85 pages, ~32s) on every call.
//
// Runs at 08:00 UTC (see vercel.json) — an unclaimed slot alongside the
// other daily crons (regenerate-compact 03:00, refresh-map-cache 04:00,
// sync-restaurants 05:00, menu-drift-check 06:00, sync-fm-orders-noncache
// 07:00).
//
// REQUIRED ENV: CRON_SECRET — Vercel Cron sends it as `Authorization: Bearer …`.

import { NextRequest, NextResponse } from 'next/server'
import { syncFmCustomers } from '../../../../lib/fm-customer-sync'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

function hasCronSecret(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return false
  const auth = req.headers.get('authorization') || ''
  return auth === `Bearer ${secret}` || auth === secret
}

async function handle(req: NextRequest): Promise<NextResponse> {
  if (!hasCronSecret(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const result = await syncFmCustomers()
    return NextResponse.json(result, { status: result.ok ? 200 : 502 })
  } catch (e) {
    console.error('[cron/sync-fm-customers] failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'sync failed' }, { status: 500 })
  }
}

export async function GET(req: NextRequest) { return handle(req) }
export async function POST(req: NextRequest) { return handle(req) }
