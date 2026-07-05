import { NextRequest, NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { getRestaurantAuthHeader, getRestaurantRef, SELECTED_RESTAURANT_COOKIE } from '../../../../lib/restaurant-auth'
import { getRestaurantAuthContext } from '../../../../lib/restaurant-auth-context'
import { sql, runMigrations } from '../../../../lib/db'

export const runtime = 'nodejs'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Zero tax rates in the shape the tax-rate page + promo engine consume — returned
// for a Disco-native restaurant that hasn't saved rates yet.
const DEFAULT_TAX = {
  stateSalesTax: { percent: 0, fixedAmount: 0 },
  localSalesTax: { percent: 0, fixedAmount: 0 },
  otherSalesTax: { percent: 0, fixedAmount: 0, types: [] },
}

// Persist tax rates for a Disco-native restaurant entirely in Neon (zero FM).
async function saveDiscoTaxRates(ref: string, taxRates: unknown): Promise<void> {
  await runMigrations()
  await sql`
    INSERT INTO disco_restaurant_overrides (restaurant_reference, tax_rates, updated_at)
    VALUES (${ref}, ${JSON.stringify(taxRates)}::jsonb, NOW())
    ON CONFLICT (restaurant_reference) DO UPDATE SET tax_rates = ${JSON.stringify(taxRates)}::jsonb, updated_at = NOW()
  `
}

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
  // Disco-native restaurants store tax rates in Neon — read them directly, no FM.
  const ctx = await getRestaurantAuthContext()
  if (ctx?.authType === 'disco') {
    const ref = await currentRef()
    if (!ref) return NextResponse.json(DEFAULT_TAX)
    try {
      await runMigrations()
      const rows = (await sql`SELECT tax_rates FROM disco_restaurant_overrides WHERE restaurant_reference = ${ref} LIMIT 1`) as { tax_rates: unknown }[]
      return NextResponse.json(rows[0]?.tax_rates || DEFAULT_TAX)
    } catch {
      return NextResponse.json(DEFAULT_TAX)
    }
  }

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
  // Disco-native restaurants save tax rates entirely in Neon — never touch FM.
  const ctx = await getRestaurantAuthContext()
  if (ctx?.authType === 'disco') {
    const ref = await currentRef()
    if (!ref) return NextResponse.json({ error: 'No restaurant in context' }, { status: 400 })
    let body: unknown
    try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid body' }, { status: 400 }) }
    try {
      await saveDiscoTaxRates(ref, body)
      return NextResponse.json(body)
    } catch (e) {
      console.error('[tax-rate] disco save failed:', e instanceof Error ? e.message : e)
      return NextResponse.json({ error: 'Unable to save tax rate' }, { status: 500 })
    }
  }

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
