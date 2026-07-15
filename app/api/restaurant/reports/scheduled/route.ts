import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthHeader } from '../../../../../lib/restaurant-auth'
import { getRestaurantAuthContext, resolveDiscoScopeRef } from '../../../../../lib/restaurant-auth-context'
import { sql, runDiscoOrderMigrations } from '../../../../../lib/db'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

export async function GET(req: NextRequest) {
  // Disco-native: the user's scheduled reports from Neon (was FM → 401).
  const ctx = await getRestaurantAuthContext()
  if (ctx?.authType === 'disco') {
    await runDiscoOrderMigrations()
    // Honor page/size like the FM path (was: all rows with rows.length total — RL8).
    const sp = req.nextUrl.searchParams
    const page = Math.max(0, parseInt(sp.get('page') || '0', 10) || 0)
    const size = Math.min(200, Math.max(1, parseInt(sp.get('size') || '25', 10) || 25))
    const total = ((await sql`SELECT count(*)::int AS n FROM disco_scheduled_reports WHERE created_by = ${ctx.email}`) as { n: number }[])[0]?.n ?? 0
    const rows = (await sql`
      SELECT reference, name, frequency, time, timezone
      FROM disco_scheduled_reports WHERE created_by = ${ctx.email}
      ORDER BY created_at DESC LIMIT ${size} OFFSET ${page * size}
    `) as Record<string, unknown>[]
    return NextResponse.json({ content: rows, totalElements: total, totalPages: Math.ceil(total / size), number: page, size })
  }

  let h: Record<string, string>
  try { h = await getRestaurantAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  const sp = req.nextUrl.searchParams
  const params = new URLSearchParams()
  const page = sp.get('page')
  if (page && page !== '0') params.set('page', page)
  params.set('size', sp.get('size') || '25')
  sp.getAll('sort').forEach(s => params.append('sort', s))
  try {
    const res = await fetch(`${FM}/api/reports/scheduled?${params}`, { headers: h })
    if (!res.ok) {
      const raw = await res.text().catch(() => '')
      return NextResponse.json({ error: 'Failed to fetch scheduled reports', status: res.status, raw }, { status: res.status })
    }
    return NextResponse.json(await res.json())
  } catch {
    return NextResponse.json({ error: 'Unable to fetch scheduled reports' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  // Disco-native: create a scheduled report in Neon.
  const ctx = await getRestaurantAuthContext()
  if (ctx?.authType === 'disco') {
    const body = await req.json().catch(() => ({}))
    const name = String(body?.name || '').trim()
    if (!name) return NextResponse.json({ error: 'Report name is required.' }, { status: 400 })
    const scope = await resolveDiscoScopeRef(ctx)
    const owners = Array.isArray(body?.ownerReferences) && body.ownerReferences.length ? body.ownerReferences.map(String) : [scope].filter(Boolean)
    await runDiscoOrderMigrations()
    const rows = (await sql`
      INSERT INTO disco_scheduled_reports (
        restaurant_reference, name, frequency, time, timezone, file_type,
        columns, recipients, owner_references, filter, created_by
      ) VALUES (
        ${scope}::uuid, ${name},
        ${body?.frequency === 'MONTHLY' ? 'MONTHLY' : 'WEEKLY'},
        ${String(body?.time || '09:00')}, ${String(body?.timezone || 'America/New_York')},
        ${body?.fileType === 'PDF' ? 'PDF' : 'CSV'},
        ${JSON.stringify(body?.columns ?? [])}::jsonb, ${JSON.stringify(body?.recipients ?? [])}::jsonb,
        ${JSON.stringify(owners)}::jsonb, ${JSON.stringify(body?.filter ?? {})}::jsonb, ${ctx.email}
      ) RETURNING reference
    `) as { reference: string }[]
    return NextResponse.json({ reference: rows[0]?.reference }, { status: 201 })
  }

  let h: Record<string, string>
  try { h = await getRestaurantAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  try {
    const body = await req.json()
    const res = await fetch(`${FM}/api/reports/scheduled`, {
      method: 'POST',
      headers: { ...h, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = await res.json().catch(() => ({}))
    return NextResponse.json(data, { status: res.status })
  } catch {
    return NextResponse.json({ error: 'Unable to create scheduled report' }, { status: 500 })
  }
}
