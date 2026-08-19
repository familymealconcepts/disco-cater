import { NextRequest, NextResponse } from 'next/server'
import { recordFunnelStage } from '../../../../lib/checkout-funnel'
import { isFunnelStage } from '../../../../lib/checkout-funnel-shared'

export const runtime = 'nodejs'

// Narrow shape checks -- this is a public route with an attacker-controlled body, same
// reasoning as isTrackableInitStage. A bad value here should just be dropped, not 400 (this
// route always 200s regardless -- see below), and never reach a DATE cast in the DB layer.
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const TIME_RE = /^\d{2}:\d{2}$/

// Lightweight capture target for the pure-client checkout transitions (date/
// time selected, item added / cart modified — see RestaurantClient.tsx). The
// client call to this route is fire-and-forget (postFunnelStage in
// lib/utils/funnel-session.ts never awaits it), so this handler's own job is
// simply to never surface an error back — it always 200s, even when the
// write itself fails, since nothing on the client reads the response anyway.
export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { sessionId, restaurantReference, stage, fulfillmentType, cartValueCents, itemCount, selectedOrderDate, selectedOrderTime } = body || {}

    if (typeof sessionId !== 'string' || !sessionId || typeof restaurantReference !== 'string' || !restaurantReference || !isFunnelStage(stage)) {
      return NextResponse.json({ ok: false, skipped: true })
    }

    await recordFunnelStage({
      sessionId,
      restaurantReference,
      stage,
      fulfillmentType: fulfillmentType === 'PICKUP' || fulfillmentType === 'DELIVERY' ? fulfillmentType : null,
      cartValueCents: Number.isFinite(cartValueCents) ? cartValueCents : null,
      itemCount: Number.isFinite(itemCount) ? itemCount : null,
      selectedOrderDate: typeof selectedOrderDate === 'string' && DATE_RE.test(selectedOrderDate) ? selectedOrderDate : null,
      selectedOrderTime: typeof selectedOrderTime === 'string' && TIME_RE.test(selectedOrderTime) ? selectedOrderTime : null,
    })

    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error('[checkout-funnel/track] capture failed (non-fatal):', e instanceof Error ? e.message : e)
    return NextResponse.json({ ok: false })
  }
}
