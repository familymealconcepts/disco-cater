import { NextRequest, NextResponse } from 'next/server'
import { getAdminAuthHeader, getAdminEmail } from '../../../../../../lib/admin-auth'
import { discoUserEmail } from '../../../../../../lib/admin/disco-user-ref'
import { sql } from '../../../../../../lib/db'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

// PATCH /api/admin/users/{ref}/disable?isEnabled={bool}
//
// For a Disco-native customer this writes disco_customers.disabled_at, which the
// customer login path ENFORCES (app/api/fm-auth). The toggle was previously
// FM-only, so for these accounts it moved nothing and the customer kept signing
// in — a control that reported a state it did not have.
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  let h: Record<string, string>
  try { h = await getAdminAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  const { ref } = await params
  const isEnabled = req.nextUrl.searchParams.get('isEnabled') || 'true'

  const native = discoUserEmail(ref)
  if (native) {
    const enable = isEnabled !== 'false'
    try {
      const rows = (await sql`
        UPDATE disco_customers
           SET disabled_at = ${enable ? null : new Date().toISOString()},
               disabled_by = ${enable ? null : await getAdminEmail()},
               updated_at = NOW()
         WHERE lower(email) = ${native}
         RETURNING email
      `) as Array<{ email: string }>
      if (!rows.length) return NextResponse.json({ error: 'User not found' }, { status: 404 })
      return NextResponse.json({ ok: true, enabled: enable })
    } catch (e) {
      console.error('[admin/users/disable] native toggle failed:', e instanceof Error ? e.message : e)
      return NextResponse.json({ error: 'Unable to toggle' }, { status: 500 })
    }
  }

  try {
    const res = await fetch(`${FM}/api/admin/users/${ref}/disable/toggle?isEnabled=${isEnabled}`, {
      method: 'PATCH', headers: h,
    })
    if (!res.ok) return NextResponse.json({ error: 'Failed to toggle' }, { status: res.status })
    return NextResponse.json({ ok: true })
  } catch {
    return NextResponse.json({ error: 'Unable to toggle' }, { status: 500 })
  }
}
