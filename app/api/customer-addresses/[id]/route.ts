import { NextRequest, NextResponse } from 'next/server'
import { sql, runCustomerAddressMigrations } from '../../../../lib/db'
import { getCustomer } from '../../../../lib/recurring'

export const runtime = 'nodejs'

// PUT — update an address and/or set it as the default. Pass { isDefault: true }
// to make it the default (unsets the others). Other fields update in place.
export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const customer = await getCustomer()
    if (!customer) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    try { await runCustomerAddressMigrations() } catch (e) { console.error('[customer-addresses] migration warning (non-fatal):', e) }

    const { id } = await params
    let body: Record<string, unknown>
    try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }) }

    // Ownership check — never let a customer touch another's address.
    const owned = (await sql`
      SELECT id FROM customer_addresses WHERE id = ${id} AND customer_fm_reference = ${customer.reference} LIMIT 1
    `) as { id: string }[]
    if (!owned.length) return NextResponse.json({ error: 'Address not found' }, { status: 404 })

    if (body?.isDefault === true) {
      await sql`UPDATE customer_addresses SET is_default = false WHERE customer_fm_reference = ${customer.reference}`
      await sql`UPDATE customer_addresses SET is_default = true, updated_at = NOW() WHERE id = ${id}`
    }

    // Optional field edits — only applied when present in the body.
    if (body?.addressLine1 !== undefined || body?.city !== undefined || body?.deliveryInstructions !== undefined) {
      await sql`
        UPDATE customer_addresses SET
          address_line1 = COALESCE(${body?.addressLine1 != null ? String(body.addressLine1) : null}, address_line1),
          address_line2 = ${body?.addressLine2 !== undefined ? (body.addressLine2 ? String(body.addressLine2) : null) : null},
          city = COALESCE(${body?.city != null ? String(body.city) : null}, city),
          state = COALESCE(${body?.state != null ? String(body.state) : null}, state),
          zipcode = COALESCE(${body?.zipcode != null ? String(body.zipcode) : null}, zipcode),
          latitude = COALESCE(${body?.latitude != null && body.latitude !== '' ? Number(body.latitude) : null}, latitude),
          longitude = COALESCE(${body?.longitude != null && body.longitude !== '' ? Number(body.longitude) : null}, longitude),
          delivery_instructions = ${body?.deliveryInstructions !== undefined ? (body.deliveryInstructions ? String(body.deliveryInstructions) : null) : null},
          updated_at = NOW()
        WHERE id = ${id}
      `
    }

    const rows = (await sql`SELECT * FROM customer_addresses WHERE id = ${id}`) as unknown[]
    return NextResponse.json({ address: rows[0] })
  } catch (err) {
    console.error('[customer-addresses PUT]', err)
    return NextResponse.json({ error: 'Could not update address' }, { status: 500 })
  }
}

// DELETE — remove an address. If it was the default, promote the most recently
// created remaining address so the customer always has a default.
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const customer = await getCustomer()
    if (!customer) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    try { await runCustomerAddressMigrations() } catch (e) { console.error('[customer-addresses] migration warning (non-fatal):', e) }

    const { id } = await params
    const owned = (await sql`
      SELECT is_default FROM customer_addresses WHERE id = ${id} AND customer_fm_reference = ${customer.reference} LIMIT 1
    `) as { is_default: boolean }[]
    if (!owned.length) return NextResponse.json({ error: 'Address not found' }, { status: 404 })

    await sql`DELETE FROM customer_addresses WHERE id = ${id} AND customer_fm_reference = ${customer.reference}`

    if (owned[0].is_default) {
      // Promote the newest remaining address to default.
      const next = (await sql`
        SELECT id FROM customer_addresses WHERE customer_fm_reference = ${customer.reference}
        ORDER BY created_at DESC LIMIT 1
      `) as { id: string }[]
      if (next.length) await sql`UPDATE customer_addresses SET is_default = true WHERE id = ${next[0].id}`
    }

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[customer-addresses DELETE]', err)
    return NextResponse.json({ error: 'Could not delete address' }, { status: 500 })
  }
}
