import { NextRequest, NextResponse } from 'next/server'
import { getCustomerSession } from '../../../../../lib/customer-auth'
import { runDiscoOrderMigrations, sql } from '../../../../../lib/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// DELETE /api/customer/favorites/{ref} — remove a favorite for the logged-in customer.
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  const session = await getCustomerSession(_req)
  if (!session) return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  const { ref: rawRef } = await params
  const ref = decodeURIComponent(rawRef || '').trim()
  if (!ref) return NextResponse.json({ error: 'ref required' }, { status: 400 })
  try {
    await runDiscoOrderMigrations()
    await sql`
      DELETE FROM disco_customer_favorites
      WHERE customer_email = ${session.email} AND restaurant_reference = ${ref}
    `
    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('[customer/favorites] DELETE failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Unable to remove favorite' }, { status: 500 })
  }
}
