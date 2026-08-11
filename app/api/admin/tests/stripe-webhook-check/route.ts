import { NextResponse } from 'next/server'
import Stripe from 'stripe'
import { getAdminRole } from '../../../../../lib/admin-auth'

export const runtime = 'nodejs'

// TEMPORARY — makes a small, safe metadata update to Almost Home's connected
// account (triggers a real account.updated event) so delivery can be verified
// end-to-end. Delete after verification.
export async function POST() {
  const role = await getAdminRole()
  if (role !== 'SUPER_ADMIN') return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const key = process.env.STRIPE_SECRET_KEY || ''
  const stripe = new Stripe(key, { apiVersion: '2025-01-27.acacia' } as unknown as ConstructorParameters<typeof Stripe>[1])
  const almostHomeAcct = 'acct_1U2yeD3XIxT2pODU'

  const updated = await stripe.accounts.update(almostHomeAcct, {
    metadata: { source: 'disco-become-a-partner', webhook_test_ping: String(Date.now()) },
  })

  // Confirm Stripe actually generated the event (account-scoped, Express-account
  // events aren't visible via the platform-level events.list()).
  await new Promise(r => setTimeout(r, 2000))
  const events = await stripe.events.list({ limit: 5, type: 'account.updated' }, { stripeAccount: almostHomeAcct })

  return NextResponse.json({
    ok: true,
    accountId: updated.id,
    metadata: updated.metadata,
    mostRecentAccountUpdatedEvents: events.data.map(e => ({ id: e.id, created: new Date(e.created * 1000).toISOString(), pending_webhooks: e.pending_webhooks, request: e.request })),
  })
}

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

  const almostHomeAcct = 'acct_1U2yeD3XIxT2pODU'
  const acct = await stripe.accounts.retrieve(almostHomeAcct).catch(e => ({ error: e instanceof Error ? e.message : String(e) }))

  const eventsPlatform: unknown[] = []
  let startingAfter: string | undefined
  for (let i = 0; i < 5; i++) {
    const page = await stripe.events.list({ limit: 100, starting_after: startingAfter })
    eventsPlatform.push(...page.data)
    if (!page.has_more) break
    startingAfter = page.data[page.data.length - 1].id
  }
  const forAccount = (eventsPlatform as Stripe.Event[]).filter(e => e.account === almostHomeAcct)

  const eventsFromAccountPerspective = await stripe.events.list({ limit: 100 }, { stripeAccount: almostHomeAcct }).catch(e => ({ error: e instanceof Error ? e.message : String(e), data: [] }))

  return NextResponse.json({
    keyMode,
    keyPrefix: key.slice(0, 12),
    count: endpoints.data.length,
    hasMore: endpoints.has_more,
    endpoints: endpoints.data.map(ep => ({
      id: ep.id,
      url: ep.url,
      status: ep.status,
      application: ep.application,
      api_version: ep.api_version,
      enabled_events: ep.enabled_events,
    })),
    almostHomeAccount: acct,
    checkedPlatformEvents: eventsPlatform.length,
    platformEventsForAlmostHome: forAccount.map(e => ({ id: e.id, type: e.type, created: new Date(e.created * 1000).toISOString() })),
    accountPerspectiveEvents: 'data' in eventsFromAccountPerspective ? eventsFromAccountPerspective.data.map(e => ({ id: e.id, type: e.type, created: new Date(e.created * 1000).toISOString() })) : eventsFromAccountPerspective,
  })
}
