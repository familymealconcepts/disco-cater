import { NextRequest, NextResponse } from 'next/server'
import { getAdminAuthHeader, getAdminEmail } from '../../../../../../lib/admin-auth'
import { sql, runMigrations } from '../../../../../../lib/db'
import { isDiscoNativeRestaurant } from '../../../../../../lib/order/native-checkout'
import { overridesSnapshot, pick, logSettingsChange } from '../../../../../../lib/settings-audit'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

// "Hold Payments on FamilyMeal" toggle. FM backs this with the moneyFlow
// field (restaurant-table.component.ts:387-400, restaurant.service.ts:323-325):
//   FAMILY_MEAL = payouts held in the platform account
//   DIRECT      = payouts released directly to the restaurant
//   PUT /api/admin/restaurants/{ref}/money-flow?moneyFlow=FAMILY_MEAL|DIRECT
export async function PUT(req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  let h: Record<string, string>
  try { h = await getAdminAuthHeader() } catch { return NextResponse.json({ error: 'Not authenticated' }, { status: 401 }) }
  const { ref } = await params
  const moneyFlow = req.nextUrl.searchParams.get('moneyFlow') || 'DIRECT'
  const flow = moneyFlow === 'FAMILY_MEAL' ? 'FAMILY_MEAL' : 'DIRECT'

  // Attribution. money_flow decides whether a restaurant's payouts are held in
  // the platform account or released directly to it, and DIRECT→FAMILY_MEAL is
  // the direction that also blocks restaurant-funded promos at validate — so who
  // flipped it, and from what, is the question this row answers.
  const auditMoneyFlow = async (extra?: Record<string, unknown>) => {
    try {
      await logSettingsChange({
        action: 'money_flow_update',
        restaurantReference: ref,
        actorEmail: await getAdminEmail(),
        authType: 'admin',
        before: pick(await overridesSnapshot(ref), ['money_flow']),
        after: { money_flow: flow },
        extra,
      })
    } catch (e) {
      console.error('[money-flow] audit row failed:', e instanceof Error ? e.message : e)
    }
  }

  // Disco-native restaurant: no FM record — the FM proxy below would 404 and the
  // UI would silently revert the toggle (S5). Neon is the source of truth for the
  // native money-flow (the restaurant-funded promo gate reads it), so write it
  // straight to disco_restaurant_overrides.
  if (await isDiscoNativeRestaurant(ref)) {
    try {
      await runMigrations()
      await auditMoneyFlow({ native: true })
      await sql`
        INSERT INTO disco_restaurant_overrides (restaurant_reference, money_flow, updated_at)
        VALUES (${ref}, ${flow}, NOW())
        ON CONFLICT (restaurant_reference) DO UPDATE SET money_flow = ${flow}, updated_at = NOW()
      `
      return NextResponse.json({ ok: true, native: true, moneyFlow: flow })
    } catch (e) {
      console.error('[money-flow] native write failed:', e instanceof Error ? e.message : e)
      return NextResponse.json({ error: 'Unable to update money flow' }, { status: 500 })
    }
  }

  try {
    const res = await fetch(`${FM}/api/admin/restaurants/${ref}/money-flow?moneyFlow=${moneyFlow}`, { method: 'PUT', headers: h })
    if (!res.ok) return NextResponse.json({ error: 'Failed' }, { status: res.status })
    const text = await res.text()
    // FM has accepted; record it before the mirror overwrites Neon's prior value.
    await auditMoneyFlow({ native: false, fmProxied: true })
    // Mirror the flow into Neon so the checkout can gate restaurant-funded promo
    // settlement (DIRECT-only) without a per-order FM round-trip. Best-effort:
    // FM already accepted the change, so a mirror hiccup must not fail the request.
    try {
      await runMigrations()
      await sql`
        INSERT INTO disco_restaurant_overrides (restaurant_reference, money_flow, updated_at)
        VALUES (${ref}, ${flow}, NOW())
        ON CONFLICT (restaurant_reference) DO UPDATE SET money_flow = ${flow}, updated_at = NOW()
      `
    } catch (e) {
      console.error('[money-flow] Neon mirror failed (non-fatal):', e instanceof Error ? e.message : e)
    }
    return NextResponse.json(text ? JSON.parse(text) : { ok: true })
  } catch { return NextResponse.json({ error: 'Unable to update money flow' }, { status: 500 }) }
}
