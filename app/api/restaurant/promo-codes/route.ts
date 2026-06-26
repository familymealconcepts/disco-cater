import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthContext, getFmHeaderForRestaurant } from '../../../../lib/restaurant-auth-context'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

// Date-picker value (YYYY-MM-DD) → FM's DD.MM.YYYY. Pass through anything that's
// already in another shape so we never silently drop a date.
function toFmDate(d: string): string {
  const s = String(d || '').trim()
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  return m ? `${m[3]}.${m[2]}.${m[1]}` : s
}

// GET — list this restaurant's promo codes (FM coupons). FM's /api/coupon returns
// either a single coupon object or null; normalize to an array so the table
// renders regardless of how many FM exposes.
export async function GET() {
  const ctx = await getRestaurantAuthContext()
  if (!ctx) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  try {
    const h = await getFmHeaderForRestaurant(ctx)
    const res = await fetch(`${FM}/api/coupon`, { headers: h, cache: 'no-store' })
    if (res.status === 404) return NextResponse.json({ codes: [] })
    if (!res.ok) return NextResponse.json({ error: 'Failed to fetch promo codes' }, { status: res.status })
    const text = await res.text()
    const data = text ? JSON.parse(text) : null
    const codes = Array.isArray(data) ? data : data ? [data] : []
    return NextResponse.json({ codes })
  } catch (err) {
    console.error('[restaurant/promo-codes] GET failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Unable to fetch promo codes' }, { status: 500 })
  }
}

// POST — create a promo code (FM coupon). Auth via getRestaurantAuthContext; the
// FM call uses the restaurant auth header (raw JWT, no Bearer prefix) from
// getFmHeaderForRestaurant. Dates arrive as YYYY-MM-DD and convert to DD.MM.YYYY.
export async function POST(req: NextRequest) {
  const ctx = await getRestaurantAuthContext()
  if (!ctx) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  try {
    const body = await req.json().catch(() => ({}))
    const code = String(body?.code || '').trim().toUpperCase()
    const discountPercentage = Number(body?.discountPercentage)
    const maxAvailable = Math.trunc(Number(body?.maxAvailable))
    const maxPerDiner = body?.maxPerDiner != null && body.maxPerDiner !== '' ? Math.trunc(Number(body.maxPerDiner)) : 1
    const startDate = toFmDate(String(body?.startDate || ''))
    const endDate = toFmDate(String(body?.endDate || ''))

    if (!code || !/^[A-Z0-9]+$/.test(code)) {
      return NextResponse.json({ error: 'Code must be uppercase and alphanumeric.' }, { status: 400 })
    }
    if (!Number.isFinite(discountPercentage) || discountPercentage < 1 || discountPercentage > 100) {
      return NextResponse.json({ error: 'Discount must be a number between 1 and 100.' }, { status: 400 })
    }
    if (!startDate || !endDate) {
      return NextResponse.json({ error: 'Start and end dates are required.' }, { status: 400 })
    }
    if (!Number.isFinite(maxAvailable) || maxAvailable < 1) {
      return NextResponse.json({ error: 'Max available must be a positive integer.' }, { status: 400 })
    }

    const h = await getFmHeaderForRestaurant(ctx)
    const res = await fetch(`${FM}/api/coupon`, {
      method: 'POST',
      headers: { ...h, 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, discountPercentage, startDate, endDate, maxAvailable, maxPerDiner }),
    })
    const text = await res.text()
    let data: unknown = null
    try { data = text ? JSON.parse(text) : null } catch { data = null }
    if (!res.ok) {
      console.error('[restaurant/promo-codes] FM POST', res.status, text.slice(0, 300))
      const msg = (data && typeof data === 'object' && ((data as Record<string, unknown>).message || (data as Record<string, unknown>).error)) as string | undefined
      return NextResponse.json({ error: msg || 'Could not create promo code.' }, { status: res.status })
    }
    return NextResponse.json(data ?? { ok: true })
  } catch (err) {
    console.error('[restaurant/promo-codes] POST failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Unable to create promo code' }, { status: 500 })
  }
}

// DELETE — end the active promo code. FM's /api/coupon DELETE is restaurant-scoped
// (no per-id path), so this ends the current coupon for the restaurant.
export async function DELETE() {
  const ctx = await getRestaurantAuthContext()
  if (!ctx) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  try {
    const h = await getFmHeaderForRestaurant(ctx)
    const res = await fetch(`${FM}/api/coupon`, { method: 'DELETE', headers: h })
    if (!res.ok) return NextResponse.json({ error: 'Could not delete promo code.' }, { status: res.status })
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[restaurant/promo-codes] DELETE failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Unable to delete promo code' }, { status: 500 })
  }
}
