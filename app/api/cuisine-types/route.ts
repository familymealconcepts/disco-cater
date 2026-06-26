import { NextResponse } from 'next/server'
import { runDiscoOrderMigrations, sql } from '../../../lib/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// GET /api/cuisine-types — public list of cuisine types (alphabetical), used by
// the fullmap filter pills so admin-added cuisines appear automatically.
export async function GET() {
  try {
    await runDiscoOrderMigrations()
    const rows = (await sql`
      SELECT name FROM disco_cuisine_types ORDER BY name ASC
    `) as Array<{ name: string }>
    return NextResponse.json({ cuisineTypes: rows.map(r => r.name) })
  } catch (err) {
    console.error('[cuisine-types] GET failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ cuisineTypes: [] })
  }
}
