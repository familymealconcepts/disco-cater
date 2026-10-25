// Discard a session: deletes its never-published draft (and any hidden copies
// from a publish that did not finish), or drops an unconfirmed update. Never
// touches a live menu.
import { NextRequest, NextResponse } from 'next/server'
import { requireMenuBuilderAccess } from '../../../../../../../lib/menu-builder/access'
import { getSession, patchSession, claimSession } from '../../../../../../../lib/menu-builder/store'
import { discardHiddenMenu } from '../../../../../../../lib/menu-builder/writer'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(_req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  const access = await requireMenuBuilderAccess()
  if (!access.ok) return access.response
  const { ref } = await params
  if (!(await getSession(ref))) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (!(await claimSession(ref, 'Discarding…'))) return NextResponse.json({ error: 'The builder is busy or this session is finished.' }, { status: 409 })
  const s = (await getSession(ref))!
  try {
    const refs = new Set<string>([...(s.draft_menu_ref ? [s.draft_menu_ref] : []), ...Object.values(((s.result as { copies?: Record<string, string> } | null)?.copies) || {})])
    let deleted = 0
    for (const m of refs) if (await discardHiddenMenu(s, m)) deleted++
    await patchSession(ref, { status: 'discarded', status_note: null, pending_diff: null, result: { discarded: true, hiddenMenusDeleted: deleted, by: access.email, at: new Date().toISOString() } })
    return NextResponse.json({ ok: true, deleted })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    await patchSession(ref, { status: 'error', status_note: msg })
    return NextResponse.json({ error: msg }, { status: 409 })
  }
}
