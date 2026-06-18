import { NextRequest, NextResponse } from 'next/server'
import { sql, runDiscoMenuMigrations } from '../../../../../lib/db'
import { getRestaurantAuthContext } from '../../../../../lib/restaurant-auth-context'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Update / delete a Disco-native menu item by its reference (Neon only).

// PUT — update any of: name, description, price, serves, visible, position,
// image_url, category_reference. Only the provided fields change.
export async function PUT(req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  const ctx = await getRestaurantAuthContext()
  if (!ctx) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  const { ref } = await params
  if (!UUID_RE.test(ref)) return NextResponse.json({ error: 'Invalid item reference.' }, { status: 400 })

  let body: Record<string, unknown>
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 }) }

  // COALESCE keeps the existing value when a field isn't sent. Cast each bound
  // param so a NULL passes Postgres type inference.
  const name = body?.name != null ? String(body.name) : null
  const description = body?.description != null ? String(body.description) : null
  const price = body?.price != null && Number.isFinite(Number(body.price)) ? Number(body.price) : null
  const serves = body?.serves != null ? String(body.serves) : null
  const visible = typeof body?.visible === 'boolean' ? body.visible : null
  const position = body?.position != null && Number.isFinite(Number(body.position)) ? Math.trunc(Number(body.position)) : null
  const imageUrl = body?.image_url != null ? String(body.image_url) : (body?.imageUrl != null ? String(body.imageUrl) : null)
  const categoryReference = body?.category_reference != null && UUID_RE.test(String(body.category_reference)) ? String(body.category_reference) : null

  try {
    await runDiscoMenuMigrations()
    const rows = (await sql`
      UPDATE disco_menu_items SET
        name = COALESCE(${name}, name),
        description = COALESCE(${description}, description),
        price = COALESCE(${price}, price),
        serves = COALESCE(${serves}, serves),
        visible = COALESCE(${visible}, visible),
        position = COALESCE(${position}, position),
        image_url = COALESCE(${imageUrl}, image_url),
        category_reference = COALESCE(${categoryReference}::uuid, category_reference),
        updated_at = NOW()
      WHERE reference = ${ref}::uuid
      RETURNING reference, restaurant_reference, category_reference, name, description, price, serves,
                visible, position, image_url, created_at, updated_at
    `) as Record<string, unknown>[]
    if (rows.length === 0) return NextResponse.json({ error: 'Item not found.' }, { status: 404 })
    return NextResponse.json(rows[0])
  } catch (e) {
    console.error('[restaurant/menu/[ref]] PUT failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Unable to update menu item.' }, { status: 500 })
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  const ctx = await getRestaurantAuthContext()
  if (!ctx) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  const { ref } = await params
  if (!UUID_RE.test(ref)) return NextResponse.json({ error: 'Invalid item reference.' }, { status: 400 })

  try {
    await runDiscoMenuMigrations()
    const rows = (await sql`
      DELETE FROM disco_menu_items WHERE reference = ${ref}::uuid RETURNING reference
    `) as { reference: string }[]
    if (rows.length === 0) return NextResponse.json({ error: 'Item not found.' }, { status: 404 })
    return NextResponse.json({ ok: true, reference: rows[0].reference })
  } catch (e) {
    console.error('[restaurant/menu/[ref]] DELETE failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Unable to delete menu item.' }, { status: 500 })
  }
}
