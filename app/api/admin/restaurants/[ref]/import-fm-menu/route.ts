import { NextRequest, NextResponse } from 'next/server'
import { getAdminAuthHeader } from '../../../../../../lib/admin-auth'
import { importFmMenuFaithfully } from '../../../../../../lib/menu-import/fm-faithful-import'

// M3 faithful importer (super-admin): pull a restaurant's REAL FM menu — items,
// modifiers (with real prices + min/max rules), and operational settings (service
// charge, tips, delivery, order minimums, lead time) — into the Disco-native tables.
// READ-ONLY against FM. maxOrder is left null (manual) since FM's per-15-min cap
// can't be auto-converted to Disco's per-day cap.
//   POST { targetRef? }  → import fmRef's menu into targetRef (default: same ref)
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

export async function POST(req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  try { await getAdminAuthHeader() } catch { return NextResponse.json({ error: 'Not authenticated' }, { status: 401 }) }
  const { ref } = await params
  let body: { targetRef?: unknown } = {}
  try { body = await req.json() } catch { /* optional */ }
  try {
    const summary = await importFmMenuFaithfully(ref, { targetRef: body?.targetRef ? String(body.targetRef) : undefined })
    return NextResponse.json(summary, { status: summary.error ? 502 : 200 })
  } catch (e) {
    console.error('[import-fm-menu] failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Import failed' }, { status: 500 })
  }
}
