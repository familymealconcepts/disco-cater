import { NextResponse } from 'next/server'

export const runtime = 'nodejs'

// POST /api/promo/redeem — DISABLED (Peter's standing rule, 2 Nov 2026: every refund
// comes from the restaurant; Disco's code never funds a refund or any part of one).
//
// This route issued a DISCO-funded promo as a plain Stripe refund off the PLATFORM
// balance after the charge — the restaurant kept its full payment and Disco paid the
// discount. That is exactly what the rule forbids, so it refunds nothing now, and
// /api/promo/validate refuses Disco-funded codes before checkout with the same
// message, so no customer is promised one. If Disco is to give a discount back,
// Peter does it by hand in Stripe. (In use: 0 Disco-funded redemptions ever.)
//
// Restaurant-funded codes never used this route: they discount the charge before it
// is made (/api/order/place, lib/promo-apply.ts), so the restaurant funds them.
export async function POST() {
  return NextResponse.json({ success: false, error: 'Contact Disco Cater to process this refund.' }, { status: 410 })
}
