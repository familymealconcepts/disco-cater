import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthContext, resolveDiscoScopeRef } from '../../../../lib/restaurant-auth-context'
import { sql, runDiscoMenuMigrations } from '../../../../lib/db'
import { holidayDates, isHolidayName } from '../../../../lib/holidays'

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
    SELECT reference, name, holiday, to_char(from_date,'YYYY-MM-DD') AS from_date, to_char(to_date,'YYYY-MM-DD') AS to_date
    FROM disco_restaurant_closed_days WHERE restaurant_reference = ${ref}::uuid ORDER BY from_date
  `) as { reference: string; name: string | null; holiday: string | null; from_date: string; to_date: string }[]
  // Custom one-off closures (holiday IS NULL) vs. the set of toggled-on holidays.
  const closedDays = rows.filter(r => !r.holiday)
  const holidays = [...new Set(rows.filter(r => r.holiday).map(r => r.holiday as string))]
  return NextResponse.json({ closedDays, holidays })
}

export async function POST(req: NextRequest) {
  const ctx = await getRestaurantAuthContext()
  if (!ctx) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  const ref = await resolveDiscoScopeRef(ctx)
  if (!ref) return NextResponse.json({ error: 'No restaurant in context' }, { status: 400 })
  let body: Record<string, unknown>
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid body' }, { status: 400 }) }
  await runDiscoMenuMigrations()

  // Holiday toggle: pre-compute + store every year's date for the next 50 years so
  // "Thanksgiving 2026/2027/…" are all blocked. Idempotent: always clear this
  // holiday's rows first, then (re)insert when enabling.
  const holiday = String(body?.holiday || '').trim()
  if (holiday) {
    if (!isHolidayName(holiday)) return NextResponse.json({ error: 'Unknown holiday.' }, { status: 400 })
    const enabled = body?.enabled !== false
    await sql`DELETE FROM disco_restaurant_closed_days WHERE restaurant_reference = ${ref}::uuid AND holiday = ${holiday}`
    let count = 0
    if (enabled) {
      const dates = holidayDates(holiday, new Date().getFullYear())
      count = dates.length
      await sql`
        INSERT INTO disco_restaurant_closed_days (restaurant_reference, name, holiday, from_date, to_date)
        SELECT ${ref}::uuid, ${holiday}, ${holiday}, d::date, d::date FROM unnest(${dates}::text[]) AS d
      `
    }
    return NextResponse.json({ ok: true, holiday, enabled, count })
  }

  // Custom one-off closure (date range).
  const from = String(body?.fromDate || '')
  const to = String(body?.toDate || body?.fromDate || '')
  if (!ISO.test(from) || !ISO.test(to)) return NextResponse.json({ error: 'A valid date range is required.' }, { status: 400 })
  const rows = (await sql`
    INSERT INTO disco_restaurant_closed_days (restaurant_reference, name, from_date, to_date)
    VALUES (${ref}::uuid, ${String(body?.name || '').trim() || null}, ${from}::date, ${to}::date)
    RETURNING reference
  `) as { reference: string }[]
  return NextResponse.json({ reference: rows[0]?.reference })
}
