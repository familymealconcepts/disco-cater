import { NextRequest, NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { getRestaurantAuthHeader, getRestaurantRef, SELECTED_RESTAURANT_COOKIE } from '../../../../lib/restaurant-auth'
import { getRestaurantAuthContext, resolveDiscoScopeRef } from '../../../../lib/restaurant-auth-context'
import { requireWritableRestaurantRef } from '../../../../lib/restaurant-write-scope'
import { sql, runMigrations } from '../../../../lib/db'
import { restaurantActorEmail, overridesSnapshot, pick, logSettingsChange } from '../../../../lib/settings-audit'

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
    if (!ctx) return ''
    // Disco: resolveDiscoScopeRef validates the selected location against the SA's
    // group access before honoring it (a raw selected cookie must not be trusted
    // for another restaurant). FM: the selected cookie (FM SA) or the JWT ref.
    if (ctx.authType === 'disco') {
      const ref = await resolveDiscoScopeRef(ctx)
      return UUID_RE.test(ref) ? ref : ''
    }
    const store = await cookies()
    const selected = store.get(SELECTED_RESTAURANT_COOKIE)?.value || ''
    if (selected && UUID_RE.test(selected)) return selected
    const own = (await getRestaurantRef()) || ''
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

// Attribution for a tax-rate SAVE only. Deliberately NOT called from the
// opportunistic mirror in GET: that fires on every page view and records no
// human intent, so auditing it would bury the real saves in noise.
// ctx is nullable only in theory on the FM path (getRestaurantAuthHeader would
// already have thrown a 401 without a token) — tolerated rather than asserted so
// a null can never turn an accepted save into a 500 from its own audit call.
async function auditTaxRateSave(
  ref: string,
  ctx: Awaited<ReturnType<typeof getRestaurantAuthContext>>,
  after: unknown,
  extra?: Record<string, unknown>,
): Promise<void> {
  await logSettingsChange({
    action: 'tax_rate_update',
    restaurantReference: ref,
    actorEmail: ctx ? restaurantActorEmail(ctx) : null,
    authType: ctx?.authType ?? 'fm',
    before: pick(await overridesSnapshot(ref), ['tax_rates']),
    after: { tax_rates: after },
    extra,
  })
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
      const tax = (rows[0]?.tax_rates || DEFAULT_TAX) as Record<string, unknown>
      return NextResponse.json({ ...tax, restaurant_reference: ref })
    } catch {
      return NextResponse.json({ ...DEFAULT_TAX, restaurant_reference: ref })
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
    const ref = await currentRef()
    return NextResponse.json({ ...data, restaurant_reference: ref })
  } catch {
    return NextResponse.json({ error: 'Unable to fetch tax rate' }, { status: 500 })
  }
}

export async function PUT(req: NextRequest) {
  let body: Record<string, unknown>
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid body' }, { status: 400 }) }

  // Write target is the client-claimed restaurant_reference, verified against
  // the caller's permitted set — never the session's current selection (see
  // disco-profile's PUT for the full stale-intent rationale).
  const check = await requireWritableRestaurantRef(body?.restaurant_reference)
  if (!check.ok) return NextResponse.json({ error: check.error }, { status: check.status })
  const ref = check.ref
  // Never persist/forward our own scoping field as part of the tax-rates payload.
  const { restaurant_reference: _rr, ...taxBody } = body

  // Disco-native restaurants save tax rates entirely in Neon — never touch FM.
  const ctx = await getRestaurantAuthContext()
  if (ctx?.authType === 'disco') {
    try {
      // Snapshot + log before the write — Neon is authoritative on this path, so
      // before/after here are the real old and new rates.
      await auditTaxRateSave(ref, ctx, taxBody)
      await saveDiscoTaxRates(ref, taxBody)
      return NextResponse.json(taxBody)
    } catch (e) {
      console.error('[tax-rate] disco save failed:', e instanceof Error ? e.message : e)
      return NextResponse.json({ error: 'Unable to save tax rate' }, { status: 500 })
    }
  }

  // FM's own taxRate endpoint has no explicit restaurant param — it always
  // targets FM's own internal "current restaurant" pointer (set via the
  // now-validated selected-restaurant switch), and we cannot retarget that
  // per-call. So being in the permitted SET isn't enough here: the claimed ref
  // must also be the one CURRENTLY active, or this write would silently land on
  // whatever FM's pointer says instead of what the form displayed — refuse
  // rather than risk that.
  const active = await getRestaurantRef()
  if (ref !== active) {
    return NextResponse.json({ error: 'Your selected restaurant has changed — reload and try again.' }, { status: 409 })
  }

  let h: Record<string, string>
  try { h = await getRestaurantAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  try {
    const res = await fetch(`${FM}/api/restaurants/taxRate`, {
      method: 'PUT',
      headers: { ...h, 'Content-Type': 'application/json' },
      body: JSON.stringify(taxBody),
    })
    if (!res.ok) {
      const err = await res.text()
      return NextResponse.json({ error: 'Failed to update tax rate', raw: err }, { status: res.status })
    }
    const text = await res.text()
    const data = text ? JSON.parse(text) : null
    // Attribution BEFORE the mirror — FM has already accepted the change, so a
    // mirror hiccup must not also lose the record of who made it. `before` reads
    // the previously-mirrored Neon value, which is the FM value a later "FM says
    // otherwise" dispute compares against.
    await auditTaxRateSave(ref, ctx, data ?? taxBody, { fmEchoedRates: data != null })
    // Mirror the authoritative saved rates (FM's response echoes them; fall back to
    // the request body if the response is empty).
    await mirrorTaxRates(data ?? taxBody)
    return NextResponse.json(data ?? { ok: true })
  } catch {
    return NextResponse.json({ error: 'Unable to update tax rate' }, { status: 500 })
  }
}
