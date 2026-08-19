// Daily cron: reconcile restaurant-funded promo codes against FM's live
// coupon. See lib/promo-code-reconcile.ts for why this drifts and why this
// one alerts rather than auto-corrects, unlike reconcile-money-flow.
//
// REQUIRED ENV (set in Vercel):
//   CRON_SECRET          shared secret. Vercel Cron sends it as
//                        `Authorization: Bearer ${CRON_SECRET}`.
//   FM_MASTER_PASSWORD   read via lib/fm-master-admin-read.ts only.
//   FM service credentials, via lib/fm-service-auth.ts.
//
// Triggers:
//   • GET  — Vercel Cron + CLI. Requires `Authorization: Bearer <CRON_SECRET>`.
//   • POST — super-admin, authorized by the admin session cookie, or by the
//            same Bearer secret.
import { NextRequest, NextResponse } from 'next/server'
import { getAdminTokenFromRequest } from '../../../../lib/admin-auth'
import { reconcilePromoCodes } from '../../../../lib/promo-code-reconcile'
import { alertOps } from '../../../../lib/ops-alert'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

function hasCronSecret(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return false
  return req.headers.get('authorization') === `Bearer ${secret}`
}

async function handle(): Promise<NextResponse> {
  const startedAt = Date.now()
  try {
    const result = await reconcilePromoCodes()
    console.log('[reconcile-promo-codes] done:', JSON.stringify({ ...result, drifts: result.drifts.length }))
    return NextResponse.json({ success: true, ...result })
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    await alertOps('reconcile-promo-codes: FAILED', { error, elapsedMs: Date.now() - startedAt })
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
