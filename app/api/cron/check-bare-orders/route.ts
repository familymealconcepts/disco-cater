// Standing check C — bare-order display integrity. See lib/bare-order-check.ts
// for the full rationale. Read-only: finds bare orders on native restaurants
// and alerts; never repairs (that's a manual syncOrderDetail follow-up).
//
// REQUIRED ENV (set in Vercel):
//   CRON_SECRET   shared secret. Vercel Cron sends it as
//                 `Authorization: Bearer ${CRON_SECRET}`.
//
// Triggers:
//   • GET  — Vercel Cron + CLI. Requires `Authorization: Bearer <CRON_SECRET>`.
//   • POST — super-admin, authorized by the admin session cookie, or by the
//            same Bearer secret.
import { NextRequest, NextResponse } from 'next/server'
import { getAdminTokenFromRequest } from '../../../../lib/admin-auth'
import { checkBareOrderIntegrity } from '../../../../lib/bare-order-check'
import { alertOps } from '../../../../lib/ops-alert'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

function hasCronSecret(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return false
  return req.headers.get('authorization') === `Bearer ${secret}`
}

async function handle(): Promise<NextResponse> {
  try {
    const result = await checkBareOrderIntegrity()
    console.log('[check-bare-orders] done:', JSON.stringify({ count: result.count }))
    return NextResponse.json({ success: true, ...result })
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    await alertOps('check-bare-orders: FAILED', { error })
    return NextResponse.json({ success: false, error }, { status: 500 })
  }
}

export async function GET(req: NextRequest) {
  if (!hasCronSecret(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  return handle()
}

export async function POST(req: NextRequest) {
  const ok = hasCronSecret(req) || !!getAdminTokenFromRequest(req)
  if (!ok) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  return handle()
}
