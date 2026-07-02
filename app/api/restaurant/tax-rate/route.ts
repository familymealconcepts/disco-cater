import { NextRequest, NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { getRestaurantAuthHeader, getRestaurantRef, SELECTED_RESTAURANT_COOKIE } from '../../../../lib/restaurant-auth'
import { getRestaurantAuthContext } from '../../../../lib/restaurant-auth-context'
import { sql, runMigrations } from '../../../../lib/db'

export const runtime = 'nodejs'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Resolve the single restaurant whose tax rates these are: a SYSTEM_ADMIN's
// selected location, else the ADMIN's own reference. Returns '' if ambiguous.
async function currentRef(): Promise<string> {
  try {
    const ctx = await getRestaurantAuthContext()
    const store = await cookies()
    const selected = store.get(SELECTED_RESTAURANT_COOKIE)?.value || ''
    if (selected && UUID_RE.test(selected)) return selected
    const own = ctx?.authType === 'disco' ? (ctx.restaurantReference || '') : (await getRestaurantRef()) || ''
    return UUID_RE.test(own) ? own : ''
  } catch { return '' }
}

// Mirror FM's tax rates into Neon so the customer checkout can recompute a
// restaurant-funded promo's discounted tax to the cent (FM exposes rates only to
// the restaurant's own admin token — see lib/db.ts). Best-effort; never blocks.
async function mirrorTaxRates(taxRates: unknown): Promise<void> {
  if (!taxRates || typeof taxRates !== 'object') return
  const ref = await currentRef()
  if (!ref) return
  try {
    await runMigrations()
    await sql`
      INSERT INTO disco_restaurant_overrides (restaurant_reference, tax_rates, updated_at)
      VALUES (${ref}, ${JSON.stringify(taxRates)}::jsonb, NOW())
      ON CONFLICT (restaurant_reference) DO UPDATE SET tax_rates = ${JSON.stringify(taxRates)}::jsonb, updated_at = NOW()
    `
  } catch (e) {
    console.error('[tax-rate] Neon mirror failed (non-fatal):', e instanceof Error ? e.message : e)
  }
}

export async function GET() {
  let h: Record<string, string>
  try { h = await getRestaurantAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  try {
    const res = await fetch(`${FM}/api/restaurants/taxRate`, { headers: h })
    if (!res.ok) return NextResponse.json({ error: 'Failed to fetch tax rate' }, { status: res.status })
    const data = await res.json()
    // Opportunistic mirror: every time a restaurant views its tax settings, keep
    // Neon current so restaurant-funded promos stay cent-exact.
    void mirrorTaxRates(data)
    return NextResponse.json(data)
  } catch {
    return NextResponse.json({ error: 'Unable to fetch tax rate' }, { status: 500 })
  }
}

export async function PUT(req: NextRequest) {
  let h: Record<string, string>
  try { h = await getRestaurantAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  try {
    const body = await req.json()
    const res = await fetch(`${FM}/api/restaurants/taxRate`, {
      method: 'PUT',
      headers: { ...h, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const err = await res.text()
      return NextResponse.json({ error: 'Failed to update tax rate', raw: err }, { status: res.status })
    }
    const text = await res.text()
    const data = text ? JSON.parse(text) : null
    // Mirror the authoritative saved rates (FM's response echoes them; fall back to
    // the request body if the response is empty).
    await mirrorTaxRates(data ?? body)
    return NextResponse.json(data ?? { ok: true })
  } catch {
    return NextResponse.json({ error: 'Unable to update tax rate' }, { status: 500 })
  }
}
