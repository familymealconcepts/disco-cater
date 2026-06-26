import { NextRequest, NextResponse } from 'next/server'
import { getAdminAuthHeader, getAdminRole } from '../../../../lib/admin-auth'
import { runDiscoOrderMigrations, sql } from '../../../../lib/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Trim + title-case a cuisine name ("bar & grill" → "Bar & Grill").
function titleCase(name: string): string {
  return name.trim().toLowerCase().replace(/\b\w/g, c => c.toUpperCase())
}

async function listCuisines(): Promise<string[]> {
  const rows = (await sql`
    SELECT name FROM disco_cuisine_types ORDER BY name ASC
  `) as Array<{ name: string }>
  return rows.map(r => r.name)
}

// GET /api/admin/cuisine-types — all cuisine types, alphabetical. Admin-gated.
export async function GET() {
  try { await getAdminAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  try {
    await runDiscoOrderMigrations()
    return NextResponse.json({ cuisineTypes: await listCuisines() })
  } catch (err) {
    console.error('[admin/cuisine-types] GET failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Unable to load cuisine types' }, { status: 500 })
  }
}

// POST /api/admin/cuisine-types  { name } — SUPER_ADMIN only. Trims + title-cases,
// inserts (idempotent), returns the updated alphabetical list.
export async function POST(req: NextRequest) {
  if ((await getAdminRole().catch(() => null)) !== 'SUPER_ADMIN') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  try {
    const body = await req.json().catch(() => ({}))
    const name = titleCase(String(body?.name || ''))
    if (!name) return NextResponse.json({ error: 'Cuisine name required' }, { status: 400 })

    await runDiscoOrderMigrations()
    await sql`
      INSERT INTO disco_cuisine_types (name) VALUES (${name})
      ON CONFLICT (name) DO NOTHING
    `
    return NextResponse.json({ cuisineTypes: await listCuisines(), added: name })
  } catch (err) {
    console.error('[admin/cuisine-types] POST failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Unable to add cuisine type' }, { status: 500 })
  }
}
