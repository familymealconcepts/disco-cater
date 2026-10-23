import { NextRequest, NextResponse } from 'next/server'
import { getCustomerSession } from '../../../../lib/customer-auth'
import { optOutEmails, recordPrivacyOptOutEvents } from '../../../../lib/privacy-opt-out-events'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// POST /api/customer/privacy-choices { optOut: boolean }
// The /privacy-choices switch, for a SIGNED-IN diner: turning it on records an opt_out against
// their email, turning it off records an opt_in, which is the only thing that lifts NM OS's `ads`
// suppression (lib/privacy-opt-out-events.ts). The switch itself is still saved in the browser by
// lib/privacy-choices.ts; this only tells NM OS who it was.
//
// The email comes from the session, never the body. Signed out, nothing is recorded and the answer
// says so. Under GPC the switch is locked, so this is never called; if it were, an opt_in from a
// GPC browser is refused, because GPC opts the visitor out whatever the switch says.
export async function POST(req: NextRequest) {
  let body: Record<string, unknown>
  try { body = await req.json() } catch { return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 }) }
  if (typeof body.optOut !== 'boolean') return NextResponse.json({ error: 'optOut must be true or false' }, { status: 400 })

  const session = await getCustomerSession(req)
  if (!session?.email) return NextResponse.json({ recorded: false, reason: 'signed_out' })
  if (!body.optOut && req.headers.get('sec-gpc')?.trim() === '1') return NextResponse.json({ recorded: false, reason: 'gpc' })

  await recordPrivacyOptOutEvents({ emails: optOutEmails(session.email), kind: body.optOut ? 'opt_out' : 'opt_in', source: 'privacy_choices_switch' })
  return NextResponse.json({ recorded: true })
}
