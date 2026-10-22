// Order emails Mailgun could not deliver — see lib/email-failures.ts. Records
// each permanent failure once on its order and alerts ops once. Never resends.
//
// REQUIRED ENV (set in Vercel):
//   CRON_SECRET          Vercel Cron sends `Authorization: Bearer ${CRON_SECRET}`.
//   MAILGUN_API_KEY / MAILGUN_DOMAIN   the same pair sendEmail uses.
//
// Triggers:
//   • GET  — Vercel Cron + CLI. Requires `Authorization: Bearer <CRON_SECRET>`.
//   • POST — super-admin session, or the same Bearer secret. `?hours=N` (max
//            96) changes the look-back from its default of 72h (Mailgun keeps
//            ~3 days of events), so a missed run catches up on the next.
import { NextRequest, NextResponse } from 'next/server'
import { isVerifiedSuperAdminRequest } from '../../../../lib/admin-auth'
import { checkEmailFailures } from '../../../../lib/email-failures'
import { alertOps } from '../../../../lib/ops-alert'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

function hasCronSecret(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return false
  return req.headers.get('authorization') === `Bearer ${secret}`
}

async function handle(hours: number): Promise<NextResponse> {
  try {
    const result = await checkEmailFailures(hours)
    console.log('[mailgun-failures] done:', JSON.stringify({ hours, scanned: result.scanned, orderEmails: result.orderEmails, recorded: result.recorded.length }))
    return NextResponse.json({ success: true, hours, ...result })
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    await alertOps('mailgun-failures: FAILED', { error })
    return NextResponse.json({ success: false, error }, { status: 500 })
  }
}

export async function GET(req: NextRequest) {
  if (!hasCronSecret(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  return handle(72)
}

export async function POST(req: NextRequest) {
  const ok = hasCronSecret(req) || await isVerifiedSuperAdminRequest(req)
  if (!ok) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const h = Number(req.nextUrl.searchParams.get('hours'))
  return handle(Number.isFinite(h) && h > 0 ? Math.min(h, 96) : 72)
}
