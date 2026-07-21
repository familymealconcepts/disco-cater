import { NextRequest, NextResponse } from 'next/server'
import { getCustomerSession } from '../../../../../lib/customer-auth'
import { sql, withDiscoTables } from '../../../../../lib/db'

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
    // Favorites are stored by UUID today, but legacy rows were stored by SLUG,
    // while GET returns the CANONICAL uuid (via disco_restaurant_cache). Matching
    // on the passed ref alone therefore silently no-ops on a legacy row and the
    // favorite reappears on reload. Resolve through the cache in both directions.
    // No eager migration run — see withDiscoTables().
    const removed = await withDiscoTables(() => sql`
      DELETE FROM disco_customer_favorites
      WHERE customer_email = ${session.email}
        AND (
          restaurant_reference = ${ref}
          OR restaurant_reference IN (
            SELECT c.slug FROM disco_restaurant_cache c
            WHERE c.restaurant_reference = ${ref} AND c.slug IS NOT NULL
          )
          OR restaurant_reference IN (
            SELECT c.restaurant_reference FROM disco_restaurant_cache c
            WHERE c.slug = ${ref} AND c.restaurant_reference IS NOT NULL
          )
        )
      RETURNING restaurant_reference
    `) as Array<{ restaurant_reference: string }>
    // removed:0 means the client and server disagree about the key — surface it
    // rather than reporting a success that the next reload visibly contradicts.
    return NextResponse.json({ success: true, removed: removed.length })
  } catch (err) {
    console.error('[customer/favorites] DELETE failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Unable to remove favorite' }, { status: 500 })
  }
}
