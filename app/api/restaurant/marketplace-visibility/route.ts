import { NextResponse } from 'next/server'
import { sql, runMigrations } from '../../../../lib/db'
import { getRestaurantRef } from '../../../../lib/restaurant-auth'

export const runtime = 'nodejs'

// Restaurant-scoped read/write of disco_restaurant_overrides.visible — controls
// whether the restaurant appears on the Disco Cater fullmap discovery map. The
// restaurant_reference is derived server-side from the auth cookie, so a
// restaurant can only ever read/write its OWN row.

export async function GET() {
  const ref = await getRestaurantRef()
  if (!ref) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  try {
    await runMigrations()
    const rows = (await sql`
      SELECT visible FROM disco_restaurant_overrides WHERE restaurant_reference = ${ref}
    `) as { visible: boolean }[]
    return NextResponse.json({ visible: rows[0]?.visible ?? false })
  } catch (err) {
    console.error('[marketplace-visibility] read failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ visible: false })
  }
}

export async function PATCH(req: Request) {
  const ref = await getRestaurantRef()
  if (!ref) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  let visible = false
  try {
    const body = await req.json()
    visible = !!body?.visible
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 })
  }

  try {
    await runMigrations()
    await sql`
      INSERT INTO disco_restaurant_overrides (restaurant_reference, visible, updated_at)
      VALUES (${ref}, ${visible}, NOW())
      ON CONFLICT (restaurant_reference) DO UPDATE SET visible = ${visible}, updated_at = NOW()
    `
    return NextResponse.json({ visible })
  } catch (err) {
    console.error('[marketplace-visibility] write failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Could not update.' }, { status: 500 })
  }
}
