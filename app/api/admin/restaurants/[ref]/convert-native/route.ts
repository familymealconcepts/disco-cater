import { NextRequest, NextResponse } from 'next/server'
import { getAdminAuthHeader } from '../../../../../../lib/admin-auth'
import { checkConversionReadiness, convertToNative } from '../../../../../../lib/native-conversion'

// M3 — FM→Disco-native conversion tooling (super-admin).
//   GET  → readiness checklist (never mutates)
//   POST → perform the flip, ONLY when every blocking step passes (guarded by the
//          M4 marketplace-drop-off gate). Requires { confirm: true }.
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(_req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  try { await getAdminAuthHeader() } catch { return NextResponse.json({ error: 'Not authenticated' }, { status: 401 }) }
  const { ref } = await params
  try {
    return NextResponse.json(await checkConversionReadiness(ref))
  } catch (e) {
    console.error('[convert-native] GET failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Unable to check conversion readiness' }, { status: 500 })
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  try { await getAdminAuthHeader() } catch { return NextResponse.json({ error: 'Not authenticated' }, { status: 401 }) }
  const { ref } = await params
  let body: { confirm?: unknown }
  try { body = await req.json() } catch { body = {} }
  if (body?.confirm !== true) {
    return NextResponse.json({ error: 'Pass { confirm: true } to convert. Review the readiness checklist first.' }, { status: 400 })
  }
  try {
    const result = await convertToNative(ref)
    return NextResponse.json(result, { status: result.converted ? 200 : 409 })
  } catch (e) {
    console.error('[convert-native] POST failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Unable to convert restaurant' }, { status: 500 })
  }
}
