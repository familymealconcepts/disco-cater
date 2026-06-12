import { NextRequest, NextResponse } from 'next/server'

export const runtime = 'nodejs'

// Finalizes restaurant onboarding by emailing the team so a Disco Cater rep can
// follow up and take the merchant live. Same Mailgun pattern as menu-upload. The
// email is best-effort — a notification failure must NOT block the merchant from
// completing, so we always return { success: true }.
const MAILGUN_API_KEY = process.env.MAILGUN_API_KEY
const MAILGUN_DOMAIN = process.env.MAILGUN_DOMAIN
const TEAM_EMAIL = 'concierge@discocater.com'

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}))
    const restaurantName = String(body?.restaurantName || '').trim() || 'Unknown Restaurant'
    const email = String(body?.email || '').trim()
    const phone = String(body?.phone || '').trim()
    const zip = String(body?.zip || '').trim()
    const joinedMarketplace = !!body?.joinedMarketplace
    const stripeConnected = !!body?.stripeConnected

    if (MAILGUN_API_KEY && MAILGUN_DOMAIN) {
      const subject = `New Partner Onboarding Complete — ${restaurantName}`
      const text = `A restaurant has completed Disco Cater onboarding.

Restaurant: ${restaurantName}
Contact email: ${email || 'Not provided'}
Phone: ${phone || 'Not provided'}
Zip: ${zip || 'Not provided'}

Joined marketplace (3P): ${joinedMarketplace ? 'Yes' : 'No'}
Stripe connected: ${stripeConnected ? 'Yes' : 'No'}

Follow up to take the merchant live.

— Disco Cater Onboarding`
      try {
        const mg = new FormData()
        mg.append('from', `Disco Cater Onboarding <onboarding@${MAILGUN_DOMAIN}>`)
        mg.append('to', TEAM_EMAIL)
        mg.append('subject', subject)
        mg.append('text', text)
        const res = await fetch(`https://api.mailgun.net/v3/${MAILGUN_DOMAIN}/messages`, {
          method: 'POST',
          headers: { Authorization: 'Basic ' + Buffer.from(`api:${MAILGUN_API_KEY}`).toString('base64') },
          body: mg,
        })
        if (!res.ok) {
          const raw = await res.text().catch(() => '')
          console.error(`[complete] Mailgun ${res.status}: ${raw.slice(0, 300)}`)
        }
      } catch (err) {
        console.error('[complete] notification send failed:', err instanceof Error ? err.message : err)
      }
    } else {
      console.error('[complete] Mailgun is not configured (MAILGUN_API_KEY / MAILGUN_DOMAIN).')
    }

    return NextResponse.json({ success: true })
  } catch {
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
}
