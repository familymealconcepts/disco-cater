import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthContext, resolveDiscoScopeRef } from '../../../../../lib/restaurant-auth-context'
import { sql, runDiscoMenuMigrations } from '../../../../../lib/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

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
  const refs = Array.isArray(body?.references) ? (body.references as unknown[]).map(String).filter(r => UUID_RE.test(r)) : []
  if (!refs.length) return NextResponse.json({ error: 'references (ordered menu list) required' }, { status: 400 })

  try {
    await runDiscoMenuMigrations()
    // Each UPDATE is restaurant-scoped, so a ref that isn't the caller's is a no-op.
    let pos = 0
    for (const ref of refs) {
      await sql`
        UPDATE disco_menus SET position = ${pos}, updated_at = NOW()
        WHERE reference = ${ref}::uuid AND restaurant_reference = ${scope}::uuid
      `
      pos++
    }
    return NextResponse.json({ success: true, count: refs.length })
  } catch (e) {
    console.error('[restaurant/disco-menus/reorder] failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Unable to reorder menus' }, { status: 500 })
  }
}
