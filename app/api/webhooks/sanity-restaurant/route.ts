// Sanity webhook → regenerate the AI assistant's restaurant data when a
// restaurant document changes.
//
// REQUIRED ENV (add to Vercel → Project → Environment Variables):
//   SANITY_WEBHOOK_SECRET   shared secret configured on the Sanity webhook.
//                           Send it from Sanity as `Authorization: Bearer <secret>`,
//                           an `x-sanity-webhook-secret` header, or `?secret=` on
//                           the URL.
//
// Configure in Sanity (Manage → API → Webhooks): trigger on create/update/delete
// of `_type == "restaurant"`, POST to /api/webhooks/sanity-restaurant.
//
// V1: any restaurant change triggers a FULL regeneration (same core as the
// cron). Incremental single-restaurant updates can come later.
//
// NOTE: same Vercel read-only-FS caveat as the cron route — see
// lib/generateCompact.ts.

import { NextRequest, NextResponse } from 'next/server'
import { generateCompact, writeCompactFile } from '../../../../lib/generateCompact'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

export async function POST(req: NextRequest) {
  const secret = process.env.SANITY_WEBHOOK_SECRET
  if (!secret) return NextResponse.json({ error: 'Webhook not configured' }, { status: 500 })

  const provided =
    req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ||
    req.headers.get('x-sanity-webhook-secret') ||
    new URL(req.url).searchParams.get('secret') ||
    ''
  if (provided !== secret) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Only act on restaurant documents. Sanity's payload shape varies by webhook
  // projection; accept _type at the top level or under `document`.
  let payload: any = null
  try { payload = await req.json() } catch {}
  const docType = payload?._type ?? payload?.document?._type
  if (docType && docType !== 'restaurant') {
    return NextResponse.json({ success: true, skipped: `ignored ${docType}` })
  }

  try {
    const { entries, skipped } = await generateCompact()
    let sizeKb: number | undefined
    try {
      ;({ sizeKb } = writeCompactFile(entries))
    } catch (e: any) {
      throw new Error(`Generated ${entries.length} entries but could not write file: ${e?.message || e}`)
    }
    return NextResponse.json({ success: true, count: entries.length, skipped: skipped.length, sizeKb })
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e?.message || 'Regeneration failed' }, { status: 500 })
  }
}
