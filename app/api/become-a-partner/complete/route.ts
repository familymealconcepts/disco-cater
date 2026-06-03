import { NextRequest, NextResponse } from 'next/server'

// Finalizes restaurant onboarding (pricing + delivery agreement acceptance).
// Placeholder for now: a future iteration will fan this out to a webhook / team
// notification email so a Disco Cater rep can follow up and take the merchant
// live. We accept and acknowledge the agreement payload today.
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}))
    const { email, agreedToPricing, agreedToDelivery } = body || {}
    // Intentionally not persisted yet — see note above.
    void email; void agreedToPricing; void agreedToDelivery
    return NextResponse.json({ success: true })
  } catch {
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
}
