import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthContext, resolveDiscoScopeRef } from '../../../../../lib/restaurant-auth-context'
import { requireWritableRestaurantRef } from '../../../../../lib/restaurant-write-scope'
import { runDiscoMenuMigrations } from '../../../../../lib/db'
import { applyOrder, cleanRefs } from '../../../../../lib/reorder'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Reorder the restaurant's disco_modifier_groups library. Body { references: string[] } is the
// full desired order; each row's position becomes its index.
//
// ADMIN-LIST ORDER ONLY. Neither disco_modifier_groups.position is read by any
// customer-facing query — the storefront orders modifier groups by
// disco_item_groups.position and modifiers by
// disco_modifier_group_members.position. This changes the portal's own list and
// nothing a diner sees.
//
// One atomic statement, not a loop: see lib/reorder.ts.
export async function POST(req: NextRequest) {
  const ctx = await getRestaurantAuthContext()
  if (!ctx) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  const scope = await resolveDiscoScopeRef(ctx)
  if (!scope) return NextResponse.json({ error: 'No restaurant in context' }, { status: 400 })
  const writable = await requireWritableRestaurantRef(scope)
  if (!writable.ok) return NextResponse.json({ error: writable.error }, { status: writable.status })

  let body: { references?: unknown }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid body' }, { status: 400 }) }
  const refs = cleanRefs(body?.references)
  if (!refs.length) return NextResponse.json({ error: 'references (ordered list) required' }, { status: 400 })

  try {
    await runDiscoMenuMigrations()
    const moved = await applyOrder('disco_modifier_groups', scope, refs)
    return NextResponse.json({ success: true, requested: refs.length, moved })
  } catch (e) {
    console.error('[disco-modifier-groups/reorder] failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Unable to reorder' }, { status: 500 })
  }
}
