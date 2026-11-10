import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthContext, resolveDiscoScopeRef } from '../../../../../lib/restaurant-auth-context'
import { sql, runDiscoMenuMigrations } from '../../../../../lib/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  const { ref } = await params
  const ctx = await getRestaurantAuthContext()
  // An FM-password session carries no restaurantReference (resolveDiscoScopeRef resolves it);
  // checking it here 404'd every Disco menu page for those logins (Pecking House, 2026-11-10).
  if (!ctx || !UUID_RE.test(ref)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const scopeRef = await resolveDiscoScopeRef(ctx)
  if (!scopeRef) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  await runDiscoMenuMigrations()
  await sql`DELETE FROM disco_restaurant_closed_days WHERE reference = ${ref}::uuid AND restaurant_reference = ${scopeRef}::uuid`
  return NextResponse.json({ ok: true })
}
