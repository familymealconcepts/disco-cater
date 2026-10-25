// Save a confirmed update. Each location's plan was shown before → after; it is
// applied only if that menu has not changed since (applyPlan re-checks), one
// transaction per location.
import { NextRequest, NextResponse } from 'next/server'
import { requireMenuBuilderAccess } from '../../../../../../../lib/menu-builder/access'
import { getSession, patchSession, claimSession } from '../../../../../../../lib/menu-builder/store'
import { applyPlan, type LocationPlan } from '../../../../../../../lib/menu-builder/writer'
import { logAdminAction } from '../../../../../../../lib/admin-audit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

export async function POST(_req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  const access = await requireMenuBuilderAccess()
  if (!access.ok) return access.response
  const { ref } = await params
  const s0 = await getSession(ref)
  if (!s0) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const plans = (s0.pending_diff as { plans?: LocationPlan[] } | null)?.plans
  if (s0.mode !== 'update' || !plans?.length) return NextResponse.json({ error: 'There are no changes waiting for confirmation.' }, { status: 400 })
  if (!(await claimSession(ref, 'Saving the changes…'))) return NextResponse.json({ error: 'The builder is busy or this session is finished.' }, { status: 409 })
  const s = (await getSession(ref))!
  const done: { restaurant: string; menuRef: string; changes: number }[] = []
  const at = new Date().toISOString()
  for (const p of plans) {
    const name = s.restaurant_names[s.restaurant_refs.indexOf(p.restaurantRef)] || p.restaurantRef
    try {
      const r = await applyPlan(s, p)
      done.push({ restaurant: name, menuRef: p.menuRef, changes: r.changes })
      await logAdminAction({ action: 'menu_builder_update', restaurantReference: p.restaurantRef, actorEmail: access.email, detail: { session: ref, menuRef: p.menuRef, changes: p.changes } })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      await patchSession(ref, {
        status: 'error', status_note: `Saved ${done.length} of ${plans.length} locations; ${name} failed: ${msg}`,
        result: { applied: done, failed: { restaurant: name, error: msg }, at },
        pending_diff: { plans: plans.filter(x => !done.some(d => d.menuRef === x.menuRef)), at },
      })
      return NextResponse.json({ error: msg, applied: done }, { status: 409 })
    }
  }
  await patchSession(ref, {
    status: 'applied', status_note: null, result: { applied: done, at }, pending_diff: null,
    messages: [...s.messages, { role: 'assistant', text: `Saved: ${done.map(d => `${d.restaurant} (${d.changes} change${d.changes === 1 ? '' : 's'})`).join(', ')}.`, at }],
  })
  return NextResponse.json({ ok: true, applied: done })
}
