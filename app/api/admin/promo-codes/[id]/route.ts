import { NextRequest, NextResponse } from 'next/server'
import { getAdminAuthHeader } from '../../../../../lib/admin-auth'
import { sql, runMigrations } from '../../../../../lib/db'

export const runtime = 'nodejs'

// PATCH /api/admin/promo-codes/{id} — toggle active (body: { active }).
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try { await getAdminAuthHeader() } catch { return NextResponse.json({ error: 'Not authenticated' }, { status: 401 }) }
  await runMigrations()
  const { id } = await params
  const numericId = parseInt(id, 10)
  if (!Number.isFinite(numericId)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 })

  let b: Record<string, unknown>
  try { b = await req.json() } catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }) }
  if (typeof b.active !== 'boolean') return NextResponse.json({ error: 'Provide { active: boolean }' }, { status: 400 })

  const rows = (await sql`UPDATE promo_codes SET active = ${b.active} WHERE id = ${numericId} RETURNING *`) as unknown[]
  if (rows.length === 0) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json({ code: rows[0] })
}

// DELETE /api/admin/promo-codes/{id} — only if uses_count = 0.
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try { await getAdminAuthHeader() } catch { return NextResponse.json({ error: 'Not authenticated' }, { status: 401 }) }
  await runMigrations()
  const { id } = await params
  const numericId = parseInt(id, 10)
  if (!Number.isFinite(numericId)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 })

  const rows = (await sql`SELECT uses_count FROM promo_codes WHERE id = ${numericId} LIMIT 1`) as { uses_count: number }[]
  if (rows.length === 0) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (rows[0].uses_count > 0) return NextResponse.json({ error: 'Cannot delete a code that has been used. Deactivate it instead.' }, { status: 409 })

  await sql`DELETE FROM promo_codes WHERE id = ${numericId}`
  return NextResponse.json({ ok: true })
}
