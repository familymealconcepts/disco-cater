import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthContext, resolveDiscoScopeRef } from '../../../../lib/restaurant-auth-context'
import { sql, runDiscoMenuMigrations } from '../../../../lib/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
const ISO = /^\d{4}-\d{2}-\d{2}$/

// Restaurant-wide Closed Days (holidays + one-off closures) — apply across all of
// the restaurant's menus. SA location-scoped.
export async function GET() {
  const ctx = await getRestaurantAuthContext()
  if (!ctx) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  const ref = await resolveDiscoScopeRef(ctx)
  if (!ref) return NextResponse.json({ error: 'No restaurant in context' }, { status: 400 })
  await runDiscoMenuMigrations()
  const rows = (await sql`
    SELECT reference, name, to_char(from_date,'YYYY-MM-DD') AS from_date, to_char(to_date,'YYYY-MM-DD') AS to_date
    FROM disco_restaurant_closed_days WHERE restaurant_reference = ${ref}::uuid ORDER BY from_date
  `) as Record<string, unknown>[]
  return NextResponse.json({ closedDays: rows })
}

export async function POST(req: NextRequest) {
  const ctx = await getRestaurantAuthContext()
  if (!ctx) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  const ref = await resolveDiscoScopeRef(ctx)
  if (!ref) return NextResponse.json({ error: 'No restaurant in context' }, { status: 400 })
  let body: Record<string, unknown>
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid body' }, { status: 400 }) }
  const from = String(body?.fromDate || '')
  const to = String(body?.toDate || body?.fromDate || '')
  if (!ISO.test(from) || !ISO.test(to)) return NextResponse.json({ error: 'A valid date range is required.' }, { status: 400 })
  await runDiscoMenuMigrations()
  const rows = (await sql`
    INSERT INTO disco_restaurant_closed_days (restaurant_reference, name, from_date, to_date)
    VALUES (${ref}::uuid, ${String(body?.name || '').trim() || null}, ${from}::date, ${to}::date)
    RETURNING reference
  `) as { reference: string }[]
  return NextResponse.json({ reference: rows[0]?.reference })
}
