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

  // Disco-native restaurant. Neon is the source of truth for the native money-flow
  // (the restaurant-funded promo gate reads it), so it is always written here.
  //
  // A CONVERTED restaurant still has its FM record, and FamilyMeal still processes
  // some of its orders (its /order link, FM's own channels). FM decides whether
  // THOSE charges transfer, from its own moneyFlow — so this toggle has to reach
  // FM too, the same bridge the FM-backed path below has always been. It used to
  // write Neon only: Colonial Ranch Market was switched to DIRECT here four times
  // (Oct 2 – Nov 3) while FM kept FAMILY_MEAL and held every charge. FM is written
  // FIRST and read back; if FM refuses, nothing changes, so Disco can't again show
  // a setting FM doesn't have. Only a restaurant FM has no record of (404) is
  // Neon-only.
  if (await isDiscoNativeRestaurant(ref)) {
    try {
      await runMigrations()
      // A native restaurant rebuilt under a new reference keeps its FM one here.
      const acct = (await sql`
        SELECT fm_restaurant_reference FROM disco_restaurant_accounts
        WHERE restaurant_reference = ${ref} AND fm_restaurant_reference IS NOT NULL LIMIT 1
      `) as { fm_restaurant_reference: string }[]
      const fmRef = acct[0]?.fm_restaurant_reference || ref
      const fmGet = await fetch(`${FM}/api/admin/restaurants/${fmRef}`, { headers: { ...h, Accept: 'application/json' }, cache: 'no-store' })
      let fmMoneyFlow: string | null = null
      if (fmGet.status !== 404) {
        if (!fmGet.ok) {
          return NextResponse.json({ error: `FamilyMeal couldn't be reached (${fmGet.status}), so Hold Payments wasn't changed.` }, { status: 502 })
        }
        const put = await fetch(`${FM}/api/admin/restaurants/${fmRef}/money-flow?moneyFlow=${flow}`, { method: 'PUT', headers: h })
        if (!put.ok) {
          return NextResponse.json({ error: `FamilyMeal refused the change (${put.status}), so Hold Payments wasn't changed.` }, { status: 502 })
        }
        const check = await fetch(`${FM}/api/admin/restaurants/${fmRef}`, { headers: { ...h, Accept: 'application/json' }, cache: 'no-store' })
        fmMoneyFlow = check.ok ? ((await check.json().catch(() => null)) as { moneyFlow?: string } | null)?.moneyFlow ?? null : null
        if (fmMoneyFlow !== flow) {
          return NextResponse.json({ error: `FamilyMeal still shows ${fmMoneyFlow ?? 'no value'} after the change, so Disco wasn't updated.`, fmMoneyFlow }, { status: 502 })
        }
        // The admin-list cache is where the ordering page reads FM's value; keep it
        // current rather than showing a mismatch until its next 15-minute refresh.
        await sql`
          UPDATE disco_restaurant_admin_list_cache SET raw = jsonb_set(raw, '{moneyFlow}', to_jsonb(${flow}::text))
          WHERE restaurant_reference = ${fmRef}
        `.catch(() => {})
      }
      await auditMoneyFlow({ native: true, ...(fmMoneyFlow ? { fmProxied: true, fmReference: fmRef } : { fmRecord: false }) })
      await sql`
        INSERT INTO disco_restaurant_overrides (restaurant_reference, money_flow, updated_at)
        VALUES (${ref}, ${flow}, NOW())
        ON CONFLICT (restaurant_reference) DO UPDATE SET money_flow = ${flow}, updated_at = NOW()
      `
      return NextResponse.json({ ok: true, native: true, moneyFlow: flow, fmMoneyFlow })
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
