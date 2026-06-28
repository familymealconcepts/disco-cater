import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthHeader, getRestaurantRef } from '../../../../lib/restaurant-auth'
import { getRestaurantAuthContext } from '../../../../lib/restaurant-auth-context'
import { sql, runMigrations } from '../../../../lib/db'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

export async function GET() {
  let h: Record<string, string>
  try { h = await getRestaurantAuthHeader() } catch { return NextResponse.json({ error: 'Not authenticated' }, { status: 401 }) }
  try {
    const res = await fetch(`${FM}/api/feesAndTips`, { headers: h })
    if (!res.ok) return NextResponse.json({ error: 'Failed' }, { status: res.status })
    return NextResponse.json(await res.json())
  } catch { return NextResponse.json({ error: 'Unable to fetch' }, { status: 500 }) }
}

export async function PUT(req: NextRequest) {
  let h: Record<string, string>
  try { h = await getRestaurantAuthHeader() } catch { return NextResponse.json({ error: 'Not authenticated' }, { status: 401 }) }
  try {
    const body = await req.json()
    const res = await fetch(`${FM}/api/feesAndTips`, {
      method: 'PUT',
      headers: { ...h, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) return NextResponse.json({ error: 'Failed' }, { status: res.status })
    const text = await res.text()

    // Slug change: when the portal edits the public-page slug
    // (businessNameWithoutSpaces), mirror it into disco_restaurant_cache.slug so
    // the Disco map/ordering URLs stay in sync with FM. Best-effort.
    const newSlug = String(body?.businessNameWithoutSpaces || '').trim().toLowerCase()
    if (newSlug) {
      try {
        const ctx = await getRestaurantAuthContext()
        const ref = ctx?.restaurantReference || (await getRestaurantRef()) || ''
        if (ref) {
          await runMigrations()
          await sql`
            UPDATE disco_restaurant_cache SET slug = ${newSlug}, cached_at = NOW()
            WHERE restaurant_reference = ${ref}
          `
        }
      } catch (e) {
        console.error('[fees-and-tips] cache slug sync failed:', e instanceof Error ? e.message : e)
      }
    }

    return NextResponse.json(text ? JSON.parse(text) : { ok: true })
  } catch { return NextResponse.json({ error: 'Unable to update' }, { status: 500 }) }
}
