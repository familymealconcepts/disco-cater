import { NextResponse } from 'next/server'
import { verifySuperAdmin } from '../../../../../../lib/admin-auth'
import { cancelPromotion } from '../../../../../../lib/promotions/diner-promotions'

export const runtime = 'nodejs'

// POST /api/admin/promotions/[ref]/cancel — cancel an unused (Offered or Activated) promotion.
export async function POST(_req: Request, { params }: { params: Promise<{ ref: string }> }) {
  const auth = await verifySuperAdmin()
  if (!auth.ok) return NextResponse.json({ error: 'Not authenticated' }, { status: auth.status })
  const { ref } = await params
  if (!/^[0-9a-f-]{36}$/i.test(ref)) return NextResponse.json({ error: 'Invalid promotion' }, { status: 400 })
  const r = await cancelPromotion(ref, auth.email)
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status })
  return NextResponse.json({ ok: true })
}
