import { NextRequest, NextResponse } from 'next/server'
import { getAdminAuthHeader, getAdminEmail } from '../../../../../../lib/admin-auth'
import { runMigrations } from '../../../../../../lib/db'
import { isDiscoNativeRestaurant } from '../../../../../../lib/order/native-checkout'
import { parseMoneyFlow, setMoneyFlowEverywhere } from '../../../../../../lib/money-flow-sync'
import { fmRefFor, moneyFlowDeps, alertMoneyFlowChangeFailed, resolveMoneyFlowChangeFailed } from '../../../../../../lib/money-flow-sync-server'

// "Hold Payments" toggle. FM backs this with the moneyFlow field
// (restaurant-table.component.ts:387-400, restaurant.service.ts:323-325):
//   FAMILY_MEAL = payouts held in the platform account   (toggle ON)
//   DIRECT      = payouts released directly to the restaurant (toggle OFF)
//   PUT /api/admin/restaurants/{ref}/money-flow?moneyFlow=FAMILY_MEAL|DIRECT[&dryRun=1]
//
// Disco and FamilyMeal must always agree, so every change goes through setMoneyFlowEverywhere
// (lib/money-flow-sync.ts): FamilyMeal first, read back, then Disco, with FamilyMeal put back if a
// later step fails, and every attempt audited. Native and FM-backed restaurants take the same path
// (it used to differ: the FM-backed branch never read FamilyMeal back, and the native branch left
// FamilyMeal changed and logged nothing when its read-back failed).
//
// The value must be exactly FAMILY_MEAL or DIRECT. It used to default to DIRECT, so a malformed
// request released payouts.
//
// dryRun=1 reads both systems and returns what would happen, writing nothing anywhere.
//
// Alerts (Peter, 2026-11-10): a successful change is NOT an alert, only an audit row (who, when,
// old and new, source super_admin). Only a change that didn't complete alerts: FamilyMeal refused or
// couldn't be reached, read back a different value, or Disco's write failed (with FamilyMeal put
// back). That alert closes on the next successful change or when the 15-minute check finds them
// in sync.
export async function PUT(req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  let h: Record<string, string>
  try { h = await getAdminAuthHeader() } catch { return NextResponse.json({ error: 'Not authenticated' }, { status: 401 }) }
  const { ref } = await params
  const flow = parseMoneyFlow(req.nextUrl.searchParams.get('moneyFlow'))
  if (!flow) return NextResponse.json({ error: 'moneyFlow must be FAMILY_MEAL (held) or DIRECT (released)' }, { status: 400 })
  const dryRun = req.nextUrl.searchParams.get('dryRun') === '1'

  try {
    await runMigrations()
    const native = await isDiscoNativeRestaurant(ref)
    const fmRef = native ? await fmRefFor(ref) : ref
    const deps = moneyFlowDeps(h, { ref, actorEmail: await getAdminEmail(), native, fmRef })
    const result = await setMoneyFlowEverywhere(deps, { ref, fmRef, flow, native, dryRun })
    if (!result.ok) {
      if (!dryRun) await alertMoneyFlowChangeFailed({ ref, actorEmail: await getAdminEmail(), result }).catch(() => {})
      return NextResponse.json({ ...result, native, fmMoneyFlow: result.fmAfter }, { status: 502 })
    }
    if (!dryRun) await resolveMoneyFlowChangeFailed(ref).catch(() => {})
    return NextResponse.json({ ...result, native, moneyFlow: flow, fmMoneyFlow: result.fmAfter })
  } catch (e) {
    console.error('[money-flow] failed:', e instanceof Error ? e.message : e)
    // Thrown mid-change (e.g. FamilyMeal unreachable during the PUT): which system holds what is unknown.
    if (!dryRun) {
      await alertMoneyFlowChangeFailed({
        ref, actorEmail: await getAdminEmail().catch(() => null),
        error: `Asked for ${flow}; the change stopped with an error (${e instanceof Error ? e.message : 'unknown'}).`,
      }).catch(() => {})
    }
    return NextResponse.json({ error: 'Unable to update Hold Payments. Nothing was confirmed changed; check both systems.' }, { status: 500 })
  }
}
