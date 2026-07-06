import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthHeader } from '../../../../../../lib/restaurant-auth'
import { getRestaurantAuthContext } from '../../../../../../lib/restaurant-auth-context'
import { sql, runDiscoOrderMigrations } from '../../../../../../lib/db'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function GET(_req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  const { ref } = await params

  // Disco-native: return the report in the payload shape the edit form expects.
  const ctx = await getRestaurantAuthContext()
  if (ctx?.authType === 'disco') {
    if (!UUID_RE.test(ref)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    await runDiscoOrderMigrations()
    const rows = (await sql`
      SELECT reference, name, frequency, time, timezone, file_type AS "fileType",
             columns, recipients, owner_references AS "ownerReferences", filter
      FROM disco_scheduled_reports WHERE reference = ${ref}::uuid AND created_by = ${ctx.email} LIMIT 1
    `) as Record<string, unknown>[]
    if (!rows.length) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    return NextResponse.json(rows[0])
  }

  let h: Record<string, string>
  try { h = await getRestaurantAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  try {
    const res = await fetch(`${FM}/api/reports/scheduled/${ref}`, { headers: h })
    if (!res.ok) return NextResponse.json({ error: 'Failed to fetch report' }, { status: res.status })
    return NextResponse.json(await res.json())
  } catch {
    return NextResponse.json({ error: 'Unable to fetch report' }, { status: 500 })
  }
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  const { ref } = await params

  // Disco-native: update the report (only your own).
  const ctx = await getRestaurantAuthContext()
  if (ctx?.authType === 'disco') {
    if (!UUID_RE.test(ref)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    const body = await req.json().catch(() => ({}))
    await runDiscoOrderMigrations()
    const rows = (await sql`
      UPDATE disco_scheduled_reports SET
        name = COALESCE(NULLIF(${String(body?.name || '')}, ''), name),
        frequency = ${body?.frequency === 'MONTHLY' ? 'MONTHLY' : 'WEEKLY'},
        time = ${String(body?.time || '09:00')},
        timezone = ${String(body?.timezone || 'America/New_York')},
        file_type = ${body?.fileType === 'PDF' ? 'PDF' : 'CSV'},
        columns = ${JSON.stringify(body?.columns ?? [])}::jsonb,
        recipients = ${JSON.stringify(body?.recipients ?? [])}::jsonb,
        owner_references = ${JSON.stringify(body?.ownerReferences ?? [])}::jsonb,
        filter = ${JSON.stringify(body?.filter ?? {})}::jsonb,
        updated_at = NOW()
      WHERE reference = ${ref}::uuid AND created_by = ${ctx.email}
      RETURNING reference
    `) as { reference: string }[]
    if (!rows.length) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    return NextResponse.json({ reference: rows[0].reference })
  }

  let h: Record<string, string>
  try { h = await getRestaurantAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  try {
    const body = await req.json()
    const res = await fetch(`${FM}/api/reports/scheduled/${ref}`, {
      method: 'PUT',
      headers: { ...h, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = await res.json().catch(() => ({}))
    return NextResponse.json(data, { status: res.status })
  } catch {
    return NextResponse.json({ error: 'Unable to update report' }, { status: 500 })
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  const { ref } = await params

  const ctx = await getRestaurantAuthContext()
  if (ctx?.authType === 'disco') {
    if (!UUID_RE.test(ref)) return NextResponse.json({ ok: true })
    await runDiscoOrderMigrations()
    await sql`DELETE FROM disco_scheduled_reports WHERE reference = ${ref}::uuid AND created_by = ${ctx.email}`
    return NextResponse.json({ ok: true })
  }

  let h: Record<string, string>
  try { h = await getRestaurantAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  try {
    const res = await fetch(`${FM}/api/reports/scheduled/${ref}`, { method: 'DELETE', headers: h })
    return NextResponse.json({ ok: res.ok }, { status: res.ok ? 200 : res.status })
  } catch {
    return NextResponse.json({ error: 'Unable to delete report' }, { status: 500 })
  }
}
