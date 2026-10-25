// Publish a built menu: the hidden draft is copied to every other chosen
// location, every copy is read back and compared with the draft, and only if
// all match are they turned on together. Nothing is live before this.
import { NextRequest, NextResponse } from 'next/server'
import { requireMenuBuilderAccess } from '../../../../../../../lib/menu-builder/access'
import { getSession, patchSession, claimSession } from '../../../../../../../lib/menu-builder/store'
import { publishNew } from '../../../../../../../lib/menu-builder/writer'
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
  if (s0.mode !== 'new') return NextResponse.json({ error: 'Updates are saved with Confirm, not Publish.' }, { status: 400 })
  if (!s0.draft_menu_ref) return NextResponse.json({ error: 'There is no draft to publish yet.' }, { status: 400 })
  if (!(await claimSession(ref, 'Publishing…'))) return NextResponse.json({ error: 'The builder is busy or this session is finished.' }, { status: 409 })
  const s = (await getSession(ref))!
  const prior = ((s.result as { copies?: Record<string, string> } | null)?.copies) || {}
  try {
    const r = await publishNew(s, prior)
    const at = new Date().toISOString()
    if (!r.matched) {
      const bad = r.mismatches.map(m => s.restaurant_names[s.restaurant_refs.indexOf(m)] || m)
      await patchSession(ref, {
        status: 'ready', status_note: null, result: { copies: r.menus, mismatches: r.mismatches, at },
        messages: [...s.messages, { role: 'assistant', text: `I did NOT publish: the copy at ${bad.join(', ')} did not match the draft when I read it back. Everything is still hidden. Press Publish again to retry.`, at }],
      })
      return NextResponse.json({ ok: false, mismatches: bad }, { status: 409 })
    }
    for (const [rest, menuRef] of Object.entries(r.menus)) {
      await logAdminAction({ action: 'menu_builder_publish', restaurantReference: rest, actorEmail: access.email, detail: { session: ref, menuRef, menuName: (s.spec as { name?: string } | null)?.name ?? null } })
    }
    const lines = Object.entries(r.menus).map(([rest]) => s.restaurant_names[s.restaurant_refs.indexOf(rest)] || rest)
    await patchSession(ref, {
      status: 'published', status_note: null, result: { copies: r.menus, published: r.menus, matched: true, at },
      messages: [...s.messages, { role: 'assistant', text: `Published to ${lines.join(', ')}. ${lines.length > 1 ? 'I read every copy back and they match the draft exactly.' : ''}`.trim(), at }],
    })
    return NextResponse.json({ ok: true, menus: r.menus })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    await patchSession(ref, { status: 'error', status_note: `Publish failed: ${msg}` })
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
