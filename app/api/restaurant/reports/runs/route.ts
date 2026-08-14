import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthHeader } from '../../../../../lib/restaurant-auth'
import { getRestaurantAuthContext, resolveDiscoScopeRef } from '../../../../../lib/restaurant-auth-context'
import { sql, runDiscoOrderMigrations } from '../../../../../lib/db'
import { toClientIso } from '../../../../../lib/utils/timestamp'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

export async function GET(req: NextRequest) {
  // Disco-native: report run history from disco_report_runs (was FM → 401).
  const ctx = await getRestaurantAuthContext()
  if (ctx?.authType === 'disco') {
    const scope = await resolveDiscoScopeRef(ctx)
    if (!scope) return NextResponse.json({ content: [], totalElements: 0, totalPages: 0, number: 0, size: 25 })
    await runDiscoOrderMigrations()
    // Honor the page/size the UI's pager sends (was hardcoded LIMIT 100 with a
    // rows.length total, so pages past the first were unreachable — RL8).
    const sp = req.nextUrl.searchParams
    const page = Math.max(0, parseInt(sp.get('page') || '0', 10) || 0)
    const size = Math.min(200, Math.max(1, parseInt(sp.get('size') || '25', 10) || 25))
    const totalRows = (await sql`SELECT count(*)::int AS n FROM disco_report_runs WHERE restaurant_reference = ${scope}::uuid`) as { n: number }[]
    const total = totalRows[0]?.n ?? 0
    const rows = (await sql`
      SELECT reference, report_name AS "reportName", file_type AS "fileType",
             run_status AS "runStatus", created_at AS "createdAtRaw"
      FROM disco_report_runs WHERE restaurant_reference = ${scope}::uuid
      ORDER BY created_at DESC LIMIT ${size} OFFSET ${page * size}
    `) as Record<string, unknown>[]
    // Merge boundary — see lib/utils/timestamp.ts. This branch doesn't combine
    // with FM's own report-runs response today (the FM branch below returns
    // its list untouched), but it's one of the three routes flagged for the
    // same bare-to_char pattern that broke admin Orders sort.
    const normalized = rows.map((r) => {
      const { createdAtRaw, ...rest } = r
      return { ...rest, createdDate: toClientIso(createdAtRaw) }
    })
    return NextResponse.json({ content: normalized, totalElements: total, totalPages: Math.ceil(total / size), number: page, size })
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
  try {
    const res = await fetch(`${FM}/api/reports/runs?${params}`, { headers: h })
    if (!res.ok) return NextResponse.json({ error: 'Failed to fetch report runs' }, { status: res.status })
    return NextResponse.json(await res.json())
  } catch {
    return NextResponse.json({ error: 'Unable to fetch report runs' }, { status: 500 })
  }
}
