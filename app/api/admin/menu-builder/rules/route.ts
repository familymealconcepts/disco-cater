// Builder Rules: the standing rules the Menu Builder always follows. Every save
// is a new row, so the history of edits is the table itself.
import { NextRequest, NextResponse } from 'next/server'
import { requireMenuBuilderAccess } from '../../../../../lib/menu-builder/access'
import { currentRules, rulesHistory, saveRules } from '../../../../../lib/menu-builder/store'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  const access = await requireMenuBuilderAccess()
  if (!access.ok) return access.response
  return NextResponse.json({ current: await currentRules(), history: await rulesHistory() })
}

export async function PUT(req: NextRequest) {
  const access = await requireMenuBuilderAccess()
  if (!access.ok) return access.response
  const body = await req.json().catch(() => ({}))
  const rules = String(body?.rules || '').trim()
  if (rules.length < 10) return NextResponse.json({ error: 'Rules cannot be empty.' }, { status: 400 })
  if (rules.length > 50_000) return NextResponse.json({ error: 'Rules are too long (50,000 characters max).' }, { status: 400 })
  const cur = await currentRules()
  if (cur.rules === rules) return NextResponse.json({ current: cur, unchanged: true })
  const saved = await saveRules(rules, String(body?.note || '').trim().slice(0, 500) || null, access.email)
  return NextResponse.json({ current: saved })
}
