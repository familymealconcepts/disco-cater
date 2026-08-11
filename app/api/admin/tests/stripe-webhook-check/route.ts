import { NextResponse } from 'next/server'
import Stripe from 'stripe'
import { getAdminRole } from '../../../../../lib/admin-auth'

export const runtime = 'nodejs'

// TEMPORARY — reads the real production STRIPE_SECRET_KEY (only available inside
// Vercel's runtime, not locally) to list webhook endpoints and their subscribed
// event types. Delete after verification.
export async function GET() {
  const role = await getAdminRole()
  if (role !== 'SUPER_ADMIN') return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const key = process.env.STRIPE_SECRET_KEY || ''
  const stripe = new Stripe(key, { apiVersion: '2025-01-27.acacia' } as unknown as ConstructorParameters<typeof Stripe>[1])

  const endpoints = await stripe.webhookEndpoints.list({ limit: 30 })
  const keyMode = key.startsWith('sk_live_') ? 'live' : key.startsWith('sk_test_') ? 'test' : 'unknown'

  return NextResponse.json({
    keyMode,
    keyPrefix: key.slice(0, 12),
    count: endpoints.data.length,
    hasMore: endpoints.has_more,
    endpoints: endpoints.data.map(ep => ({
      id: ep.id,
      url: ep.url,
      status: ep.status,
      enabled_events: ep.enabled_events,
    })),
  })
}
