// The marketplace's half of NM OS's AI health watch (noise-machine: src/lib/aiHealthRun.ts).
//
// NM OS calls this hourly. It makes ONE 1-token Anthropic call with this project's own
// ANTHROPIC_API_KEY and reports the raw outcome. NM OS classifies it (credit, key refused, outage)
// and alerts in its Messenger, so the marketplace's key is watched without NM OS ever holding it.
//
// WHY: NM OS ran out of Anthropic credit on 2026-10-16 and nobody knew for three days. The
// marketplace's AI features fail even more quietly: the Disco chat and Menu Advisor answer customers
// with a canned "having trouble" reply and HTTP 200, so no error ever surfaces.
//
// AUTH: Bearer AI_HEALTH_SECRET, the same value set in both Vercel projects. Not under middleware.ts
// (its matcher covers the portals only), so it checks the secret itself, in constant time.
//
// RESPONSES, deliberately distinct so NM OS never reads "could not check" as "the check failed":
//   503  AI_HEALTH_SECRET is not set here          -> NM OS records nothing
//   401  wrong or missing bearer                   -> NM OS records nothing
//   200  { ok, status, error, model }              -> NM OS records the check's outcome
// A missing ANTHROPIC_API_KEY is a 200 with ok:false: that IS the failure being watched for.

import crypto from 'crypto'
import { NextRequest, NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

// The cheapest call that still proves the key works and the account has credit. Same model the
// enrichment route already uses with this key.
const PROBE_MODEL = 'claude-haiku-4-5-20251001'

function secretMatches(header: string | null, secret: string): boolean {
  const given = header?.startsWith('Bearer ') ? header.slice(7) : ''
  // Compare digests, so the two buffers are always the same length (timingSafeEqual throws otherwise).
  const a = crypto.createHash('sha256').update(given).digest()
  const b = crypto.createHash('sha256').update(secret).digest()
  return crypto.timingSafeEqual(a, b)
}

const json = (body: unknown, status = 200) =>
  NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } })

export async function GET(req: NextRequest) {
  const secret = process.env.AI_HEALTH_SECRET
  if (!secret) return json({ error: 'AI_HEALTH_SECRET is not set' }, 503)
  if (!secretMatches(req.headers.get('authorization'), secret)) return json({ error: 'Unauthorized' }, 401)

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return json({ ok: false, status: null, error: 'ANTHROPIC_API_KEY not set', model: PROBE_MODEL })

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: PROBE_MODEL, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }),
      signal: AbortSignal.timeout(30_000),
      cache: 'no-store',
    })
    if (res.ok) return json({ ok: true, status: res.status, error: null, model: PROBE_MODEL })
    const body = (await res.text()).slice(0, 500)
    console.error('[ai-health] Anthropic check failed:', res.status, body)
    return json({ ok: false, status: res.status, error: body, model: PROBE_MODEL })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    console.error('[ai-health] Anthropic check failed:', message)
    return json({ ok: false, status: null, error: message, model: PROBE_MODEL })
  }
}
