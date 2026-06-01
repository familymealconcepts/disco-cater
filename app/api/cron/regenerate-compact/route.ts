// Regenerate scripts/output/restaurant-compact.json (the AI assistant's
// enriched restaurant data) on a schedule and on demand.
//
// REQUIRED ENV (add to Vercel → Project → Environment Variables):
//   CRON_SECRET   shared secret. Vercel Cron sends it automatically as
//                 `Authorization: Bearer ${CRON_SECRET}`. Also accepted for
//                 manual/CLI calls.
//   GITHUB_TOKEN  PAT with `repo` / contents:write scope on
//                 familymealconcepts/disco-cater. Used to commit the
//                 regenerated JSON back to the repo (→ Vercel redeploy bundles
//                 the fresh file), since the serverless FS is read-only.
//
// Triggers:
//   • GET  — Vercel Cron (daily, see vercel.json) and CLI/manual runs. Requires
//            `Authorization: Bearer <CRON_SECRET>`.
//   • POST — the super-admin "Regenerate AI Data" button. Authorized by the
//            admin session cookie (so CRON_SECRET is NEVER shipped to the
//            browser), or by the same Bearer secret.

import { NextRequest, NextResponse } from 'next/server'
import { generateCompact, commitCompactToGitHub } from '../../../../lib/generateCompact'
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
  // Commit back to the repo (→ Vercel redeploy) rather than writing to the
  // read-only serverless FS. No-op when nothing changed (skips the commit).
  const gh = await commitCompactToGitHub(entries)
  return {
    success: true,
    count: entries.length,
    skipped: skipped.length,        // restaurants skipped during generation
    committed: !gh.skipped,         // false when the repo file was unchanged
    ...(gh.sha ? { sha: gh.sha } : {}),
    ...(gh.skipped ? { reason: gh.reason } : {}),
  }
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
