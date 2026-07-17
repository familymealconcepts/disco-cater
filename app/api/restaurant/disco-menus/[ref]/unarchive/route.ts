import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthContext, resolveDiscoScopeRef } from '../../../../../../lib/restaurant-auth-context'
import { sql, runDiscoMenuMigrations } from '../../../../../../lib/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// M1 — restore an archived Disco-native menu (inverse of the [ref] DELETE, which
// soft-archives). Scoped to the caller's restaurant; zero FM.
export async function POST(_req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  const ctx = await getRestaurantAuthContext()
  if (!ctx) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  const scope = await resolveDiscoScopeRef(ctx)
  if (!scope) return NextResponse.json({ error: 'No restaurant in context' }, { status: 400 })
  const { ref } = await params
  if (!UUID_RE.test(ref)) return NextResponse.json({ error: 'Invalid menu reference' }, { status: 400 })
  try {
    await runDiscoMenuMigrations()
    const rows = (await sql`
      UPDATE disco_menus SET archived = false, updated_at = NOW()
      WHERE reference = ${ref}::uuid AND restaurant_reference = ${scope}::uuid
      RETURNING reference
    `) as { reference: string }[]
    if (!rows.length) return NextResponse.json({ error: 'Menu not found' }, { status: 404 })
    return NextResponse.json({ success: true })
  } catch (e) {
    console.error('[restaurant/disco-menus/[ref]/unarchive] failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Unable to restore menu' }, { status: 500 })
  }
}
