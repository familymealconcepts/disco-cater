import { NextRequest, NextResponse } from 'next/server'
import { getCustomerSession } from '../../../../../../lib/customer-auth'
import { activateForDiner } from '../../../../../../lib/promotions/diner-promotions'

export const runtime = 'nodejs'

// POST /api/customer/promotions/[ref]/activate — the diner activates their own promotion.
export async function POST(req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  const session = await getCustomerSession(req)
  if (!session) return NextResponse.json({ error: 'Please sign in.' }, { status: 401 })
  const { ref } = await params
  if (!/^[0-9a-f-]{36}$/i.test(ref)) return NextResponse.json({ error: 'Promotion not found.' }, { status: 404 })
  const r = await activateForDiner(session.email, ref)
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status })
  return NextResponse.json({ ok: true, status: r.promotion.status })
}
