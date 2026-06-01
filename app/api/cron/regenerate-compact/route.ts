// Regenerate scripts/output/restaurant-compact.json (the AI assistant's
// enriched restaurant data) on a schedule and on demand.
//
// REQUIRED ENV (add to Vercel → Project → Environment Variables):
//   CRON_SECRET            shared secret. Vercel Cron sends it automatically as
//                          `Authorization: Bearer ${CRON_SECRET}`. Also accepted
//                          for manual/CLI calls.
//
// Triggers:
//   • GET  — Vercel Cron (daily, see vercel.json) and CLI/manual runs. Requires
//            `Authorization: Bearer <CRON_SECRET>`.
//   • POST — the super-admin "Regenerate AI Data" button. Authorized by the
//            admin session cookie (so CRON_SECRET is NEVER shipped to the
//            browser), or by the same Bearer secret.
//
// NOTE: on Vercel's serverless runtime the deployment filesystem is read-only,
// so the write here will not persist into the deployed bundle disco-chat reads.
// Run reliably on a writable host/CI, or wire commit-back (GitHub API → redeploy)
// / Blob storage for production. See lib/generateCompact.ts.

import { NextRequest, NextResponse } from 'next/server'
import { generateCompact, writeCompactFile } from '../../../../lib/generateCompact'
import { getAdminTokenFromRequest } from '../../../../lib/admin-auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

function hasCronSecret(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return false
  const auth = req.headers.get('authorization') || ''
  return auth === `Bearer ${secret}` || auth === secret
}

async function regenerate() {
  const { entries, skipped } = await generateCompact()
  let sizeKb: number | undefined
  try {
    ;({ sizeKb } = writeCompactFile(entries))
  } catch (e: any) {
    // Read-only FS (Vercel) — surface clearly rather than claiming success.
    throw new Error(`Generated ${entries.length} entries but could not write file: ${e?.message || e}`)
  }
  return { success: true, count: entries.length, skipped: skipped.length, sizeKb }
}

// Vercel Cron + CLI — Bearer CRON_SECRET only.
export async function GET(req: NextRequest) {
  if (!hasCronSecret(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    return NextResponse.json(await regenerate())
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e?.message || 'Regeneration failed' }, { status: 500 })
  }
}

// Super-admin button — admin session cookie OR Bearer CRON_SECRET.
export async function POST(req: NextRequest) {
  const ok = hasCronSecret(req) || !!getAdminTokenFromRequest(req)
  if (!ok) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    return NextResponse.json(await regenerate())
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e?.message || 'Regeneration failed' }, { status: 500 })
  }
}
