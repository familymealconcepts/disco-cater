// Send the builder a message (answers, "build it", or a change). The turn runs
// in the background; the page polls the session.
import { NextRequest, NextResponse, after } from 'next/server'
import { requireMenuBuilderAccess } from '../../../../../../../lib/menu-builder/access'
import { getSession, patchSession, claimSession, scrubSensitive } from '../../../../../../../lib/menu-builder/store'
import { runTurn } from '../../../../../../../lib/menu-builder/engine'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 800

export async function POST(req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  const access = await requireMenuBuilderAccess()
  if (!access.ok) return access.response
  const { ref } = await params
  const body = await req.json().catch(() => ({}))
  const text = scrubSensitive(String(body?.text || '').trim().slice(0, 20_000))
  if (!text) return NextResponse.json({ error: 'Type a message.' }, { status: 400 })
  if (!(await getSession(ref))) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (!(await claimSession(ref, 'Thinking…'))) return NextResponse.json({ error: 'The builder is busy or this session is finished.' }, { status: 409 })
  const s = (await getSession(ref))!
  await patchSession(ref, { messages: [...s.messages, { role: 'user', text: `${text}${access.email !== s.actor_email ? `\n(from ${access.email})` : ''}`, at: new Date().toISOString() }] })
  after(() => runTurn(ref))
  return NextResponse.json({ ok: true })
}
