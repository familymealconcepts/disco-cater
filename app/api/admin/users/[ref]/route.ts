import { NextRequest, NextResponse } from 'next/server'
import { getAdminAuthHeader } from '../../../../../lib/admin-auth'
import { sql } from '../../../../../lib/db'
// Disco-native customer accounts carry a synthetic `disco:<email>` reference (see
// ../route.ts, which merges them into this screen). FamilyMeal has no user behind
// them, so both handlers route on the reference instead of 404ing against FM.
import { discoUserEmail } from '../../../../../lib/admin/disco-user-ref'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'


export async function PUT(req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  let h: Record<string, string>
  try { h = await getAdminAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  const { ref } = await params

  const native = discoUserEmail(ref)
  if (native) {
    try {
      const body = await req.json()
      const firstName = String(body?.firstName ?? '').trim()
      const lastName = String(body?.lastName ?? '').trim()
      const phone = String(body?.phoneNumber ?? body?.phone ?? '').replace(/\D/g, '')
      if (!firstName) return NextResponse.json({ error: 'First name is required' }, { status: 400 })
      const rows = (await sql`
        UPDATE disco_customers
           SET first_name = ${firstName}, last_name = ${lastName || null},
               phone = ${phone || null}, updated_at = NOW()
         WHERE lower(email) = ${native}
         RETURNING email
      `) as Array<{ email: string }>
      if (!rows.length) return NextResponse.json({ error: 'User not found' }, { status: 404 })
      return NextResponse.json({ ok: true, reference: ref })
    } catch (e) {
      console.error('[admin/users] native update failed:', e instanceof Error ? e.message : e)
      return NextResponse.json({ error: 'Unable to update user' }, { status: 500 })
    }
  }

  try {
    const body = await req.json()
    const res = await fetch(`${FM}/api/admin/users/${ref}`, {
      method: 'PUT', headers: { ...h, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) return NextResponse.json({ error: 'Failed to update user' }, { status: res.status })
    const text = await res.text()
    return NextResponse.json(text ? JSON.parse(text) : { ok: true })
  } catch {
    return NextResponse.json({ error: 'Unable to update user' }, { status: 500 })
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  let h: Record<string, string>
  try { h = await getAdminAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  const { ref } = await params

  const native = discoUserEmail(ref)
  if (native) {
    // REFUSE rather than orphan. A customer with native orders is referenced by
    // those orders; deleting the row would leave money and history pointing at
    // nobody. Disabling is the reversible action that actually achieves what an
    // admin wants here, and the response says so instead of failing silently.
    try {
      const orders = (await sql`
        SELECT COUNT(*)::int AS n FROM disco_orders
         WHERE lower(customer_email) = ${native} AND is_deleted = false
      `) as Array<{ n: number }>
      if (orders[0]?.n > 0) {
        return NextResponse.json({
          error: `This customer has ${orders[0].n} order(s) on Disco Cater and cannot be deleted — deleting them would orphan that history. Disable the account instead.`,
        }, { status: 409 })
      }
      const rows = (await sql`DELETE FROM disco_customers WHERE lower(email) = ${native} RETURNING email`) as Array<{ email: string }>
      if (!rows.length) return NextResponse.json({ error: 'User not found' }, { status: 404 })
      return NextResponse.json({ ok: true })
    } catch (e) {
      console.error('[admin/users] native delete failed:', e instanceof Error ? e.message : e)
      return NextResponse.json({ error: 'Unable to delete user' }, { status: 500 })
    }
  }

  try {
    const res = await fetch(`${FM}/api/admin/users/${ref}`, { method: 'DELETE', headers: h })
    if (!res.ok) return NextResponse.json({ error: 'Failed to delete user' }, { status: res.status })
    return NextResponse.json({ ok: true })
  } catch {
    return NextResponse.json({ error: 'Unable to delete user' }, { status: 500 })
  }
}
