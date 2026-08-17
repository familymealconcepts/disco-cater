import { NextRequest, NextResponse } from 'next/server'
import { getAdminAuthHeader } from '../../../../../lib/admin-auth'
import { importRestaurantStripeAccount, type ImportResult } from '../../../../../lib/native-conversion'

// M3 bulk-import tool (super-admin): ingest existing FM connected-account ids and
// LIVE-verify each (charges_enabled + transfers active) so charge-capable accounts
// are REUSED with zero restaurant effort; non-capable ones are recorded but flagged
// for onboarding. Runs in prod with the live Stripe key.
//   POST { mappings: [{ restaurantReference, stripeAccountId, email? }] }
//   POST { restaurantReference, stripeAccountId, email? }   (single)
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

const MAX = 500

interface Mapping { restaurantReference?: unknown; stripeAccountId?: unknown; email?: unknown; firstName?: unknown; lastName?: unknown }

export async function POST(req: NextRequest) {
  try { await getAdminAuthHeader() } catch { return NextResponse.json({ error: 'Not authenticated' }, { status: 401 }) }

  let body: { mappings?: unknown; restaurantReference?: unknown; stripeAccountId?: unknown; email?: unknown; firstName?: unknown; lastName?: unknown }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid body' }, { status: 400 }) }

  const raw: Mapping[] = Array.isArray(body?.mappings)
    ? (body.mappings as Mapping[])
    : (body?.restaurantReference && body?.stripeAccountId
        ? [{ restaurantReference: body.restaurantReference, stripeAccountId: body.stripeAccountId, email: body.email, firstName: body.firstName, lastName: body.lastName }]
        : [])

  const mappings = raw
    .map(m => ({
      ref: String(m?.restaurantReference || '').trim(), acct: String(m?.stripeAccountId || '').trim(),
      email: m?.email ? String(m.email).trim() : undefined,
      firstName: m?.firstName ? String(m.firstName).trim() : undefined,
      lastName: m?.lastName ? String(m.lastName).trim() : undefined,
    }))
    .filter(m => m.ref && m.acct)

  if (!mappings.length) return NextResponse.json({ error: 'Provide { mappings: [{ restaurantReference, stripeAccountId }] } or a single { restaurantReference, stripeAccountId }.' }, { status: 400 })
  if (mappings.length > MAX) return NextResponse.json({ error: `Too many mappings (${mappings.length}); max ${MAX} per call.` }, { status: 400 })

  const results: ImportResult[] = []
  const failed: { restaurantReference: string; stripeAccountId: string; error: string }[] = []
  // Sequential so we don't hammer the Stripe API; each does one live retrieve.
  for (const m of mappings) {
    try {
      results.push(await importRestaurantStripeAccount(m.ref, m.acct, { email: m.email, firstName: m.firstName, lastName: m.lastName }))
    } catch (e) {
      failed.push({ restaurantReference: m.ref, stripeAccountId: m.acct, error: e instanceof Error ? e.message.slice(0, 200) : 'import failed' })
    }
  }

  return NextResponse.json({
    total: mappings.length,
    reused: results.filter(r => r.mode === 'reuse').length,
    needsOnboarding: results.filter(r => r.mode === 'needs-onboarding').length,
    failed: failed.length,
    results,
    failures: failed,
  })
}
