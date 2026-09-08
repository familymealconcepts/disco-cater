import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthContext, resolveDiscoScopeRef } from '../../../../../lib/restaurant-auth-context'
import { runDiscoMenuMigrations } from '../../../../../lib/db'
import { applyOrder, cleanRefs } from '../../../../../lib/reorder'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'


// M1 — set menu ordering. Body { references: string[] } is the desired order; each
// menu's `position` is set to its index. Only menus belonging to the caller's
// restaurant are updated (others are ignored). Zero FM.
export async function POST(req: NextRequest) {
  const ctx = await getRestaurantAuthContext()
  if (!ctx) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  const scope = await resolveDiscoScopeRef(ctx)
  if (!scope) return NextResponse.json({ error: 'No restaurant in context' }, { status: 400 })

  let body: { references?: unknown }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid body' }, { status: 400 }) }
  const refs = cleanRefs(body?.references)
  if (!refs.length) return NextResponse.json({ error: 'references (ordered menu list) required' }, { status: 400 })

  try {
    await runDiscoMenuMigrations()
    // ONE atomic statement, not a loop. There are no transactions here, so the
    // previous per-row loop could fail partway and leave a half-applied order.
    // Still restaurant-scoped inside applyOrder, so a foreign ref is a no-op.
    const moved = await applyOrder('disco_menus', scope, refs)
    return NextResponse.json({ success: true, count: refs.length, moved })
  } catch (e) {
    console.error('[restaurant/disco-menus/reorder] failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Unable to reorder menus' }, { status: 500 })
  }
}
