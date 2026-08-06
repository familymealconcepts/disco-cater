import { NextRequest, NextResponse } from 'next/server'
import { getAdminAuthHeader } from '../../../../../../lib/admin-auth'
import { runPreflightCheck } from '../../../../../../lib/conversion-preflight'

// M3 — FM→Disco-native conversion pre-flight (super-admin, read-only).
// GET → the full blocker/warning report for one restaurant, checking every known
// conversion blocker up front (menu completeness, Stripe resolvability, duplicate
// FM records, login status, FM's own online-ordering flag) instead of one at a
// time mid-conversion.
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET(_req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  try { await getAdminAuthHeader() } catch { return NextResponse.json({ error: 'Not authenticated' }, { status: 401 }) }
  const { ref } = await params
  try {
    return NextResponse.json(await runPreflightCheck(ref))
  } catch (e) {
    console.error('[preflight] GET failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Unable to run pre-flight check' }, { status: 500 })
  }
}
