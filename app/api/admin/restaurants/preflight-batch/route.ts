import { NextRequest, NextResponse } from 'next/server'
import { getAdminAuthHeader } from '../../../../../lib/admin-auth'
import { runPreflightBatch } from '../../../../../lib/conversion-preflight'

// M3 — batch pre-flight (super-admin, read-only).
// POST { restaurantReferences: string[] } → one report per restaurant, same shape
// as the single-restaurant endpoint. Lets Peter review a whole batch of conversion
// candidates in one sitting rather than discovering blockers one at a time.
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 120

export async function POST(req: NextRequest) {
  try { await getAdminAuthHeader() } catch { return NextResponse.json({ error: 'Not authenticated' }, { status: 401 }) }
  let body: { restaurantReferences?: unknown }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 }) }
  const refs = Array.isArray(body?.restaurantReferences) ? body.restaurantReferences.map(String).filter(Boolean) : []
  if (!refs.length) return NextResponse.json({ error: 'restaurantReferences (non-empty array) is required.' }, { status: 400 })
  if (refs.length > 25) return NextResponse.json({ error: 'Max 25 restaurants per batch — split into multiple calls.' }, { status: 400 })
  try {
    const results = await runPreflightBatch(refs)
    return NextResponse.json({ results })
  } catch (e) {
    console.error('[preflight-batch] POST failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Unable to run batch pre-flight check' }, { status: 500 })
  }
}
