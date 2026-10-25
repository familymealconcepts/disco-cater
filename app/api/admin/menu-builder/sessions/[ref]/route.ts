// One Menu Builder session: the chat, the hidden draft as actually saved (read
// back from Neon, not the bot's JSON), the photo report, the pending
// before → after for an update, and the cost so far.
import { NextRequest, NextResponse } from 'next/server'
import { sql } from '../../../../../../lib/db'
import { requireMenuBuilderAccess } from '../../../../../../lib/menu-builder/access'
import { getSession } from '../../../../../../lib/menu-builder/store'
import { readMenuSpec } from '../../../../../../lib/menu-builder/spec'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(_req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  const access = await requireMenuBuilderAccess()
  if (!access.ok) return access.response
  const { ref } = await params
  const s = await getSession(ref)
  if (!s) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  // A turn that died with its lambda (timeout) would otherwise read "working" forever.
  if (s.status === 'working' && Date.now() - new Date(s.updated_at).getTime() > 15 * 60 * 1000) {
    await sql`UPDATE disco_menu_builder_sessions SET status = 'error', status_note = 'The last step stopped without finishing (timed out). Send your message again.' WHERE reference = ${ref}::uuid AND status = 'working'`
    s.status = 'error'; s.status_note = 'The last step stopped without finishing (timed out). Send your message again.'
  }
  let draft = null
  let photoReport = null
  if (s.draft_menu_ref) {
    const d = await readMenuSpec(s.draft_menu_ref)
    if (d) {
      draft = { reference: s.draft_menu_ref, visible: d.visible, spec: d.spec }
      const used = new Set(d.spec.categories.flatMap(c => c.items.map(i => i.image)).filter(Boolean))
      photoReport = {
        itemsWithoutPhoto: d.spec.categories.flatMap(c => c.items.filter(i => !i.image).map(i => `${c.name} → ${i.name}`)),
        photosWithoutItem: s.images.filter(i => !used.has(i.url)).map(i => i.name),
      }
    }
  }
  return NextResponse.json({ session: s, draft, photoReport, viewer: access.email })
}
