import { NextRequest, NextResponse } from 'next/server'
import { getAdminAuthHeader } from '../../../../../../../lib/admin-auth'
import { runDiscoOrderMigrations } from '../../../../../../../lib/db'
import { revokeLocationAccess, getHomeLocationRef } from '../../../../../../../lib/disco-restaurant-auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// DELETE /api/admin/system-admins/{email}/locations/{ref}
// Removes a System Admin's access to a location. The original/home location can
// never be removed.
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ email: string; ref: string }> }) {
  try { await getAdminAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  const { email: rawEmail, ref: rawRef } = await params
  const email = decodeURIComponent(rawEmail || '').trim()
  const ref = decodeURIComponent(rawRef || '').trim()
  if (!email || !ref) return NextResponse.json({ error: 'email and ref required' }, { status: 400 })

  try {
    await runDiscoOrderMigrations()
    const home = await getHomeLocationRef(email)
    if (home && home === ref) {
      return NextResponse.json({ error: 'Cannot remove the home location' }, { status: 400 })
    }
    await revokeLocationAccess(email, ref)
    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('[admin/system-admins/locations] DELETE failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Unable to remove location' }, { status: 500 })
  }
}
