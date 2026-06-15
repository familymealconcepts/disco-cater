import { NextRequest, NextResponse } from 'next/server'
import { sql, runCustomerAddressMigrations } from '../../../lib/db'
import { getCustomer } from '../../../lib/recurring'

export const runtime = 'nodejs'

interface AddressRow {
  id: string
  address_line1: string
  address_line2: string | null
  city: string
  state: string
  zipcode: string
  latitude: number | null
  longitude: number | null
  delivery_instructions: string | null
  label: string | null
  is_default: boolean
}

// GET — the logged-in customer's saved addresses, default first.
export async function GET() {
  try {
    const customer = await getCustomer()
    if (!customer) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

    try { await runCustomerAddressMigrations() } catch (e) { console.error('[customer-addresses] migration warning (non-fatal):', e) }

    const rows = (await sql`
      SELECT * FROM customer_addresses
      WHERE customer_fm_reference = ${customer.reference}
      ORDER BY is_default DESC, created_at DESC
    `) as AddressRow[]

    return NextResponse.json({ addresses: rows })
  } catch (err) {
    console.error('[customer-addresses GET]', err)
    return NextResponse.json({ error: 'Could not load addresses' }, { status: 500 })
  }
}

// POST — create a saved address. Becomes the default when it's the first one,
// or when isDefault is explicitly requested.
export async function POST(req: NextRequest) {
  try {
    const customer = await getCustomer()
    if (!customer) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

    try { await runCustomerAddressMigrations() } catch (e) { console.error('[customer-addresses] migration warning (non-fatal):', e) }

    let body: Record<string, unknown>
    try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }) }

    const addressLine1 = String(body?.addressLine1 || '').trim()
    const city = String(body?.city || '').trim()
    const state = String(body?.state || '').trim()
    const zipcode = String(body?.zipcode || '').trim()
    if (!addressLine1 || !city || !state || !zipcode) {
      return NextResponse.json({ error: 'Street address, city, state and zip are required.' }, { status: 400 })
    }
    const addressLine2 = body?.addressLine2 ? String(body.addressLine2).trim() : null
    const latitude = body?.latitude != null && body.latitude !== '' ? Number(body.latitude) : null
    const longitude = body?.longitude != null && body.longitude !== '' ? Number(body.longitude) : null
    const deliveryInstructions = body?.deliveryInstructions ? String(body.deliveryInstructions).trim() : null
    const label = body?.label ? String(body.label).trim() : null

    // First address (or an explicit request) becomes the default.
    const existing = (await sql`
      SELECT COUNT(*)::int AS n FROM customer_addresses WHERE customer_fm_reference = ${customer.reference}
    `) as { n: number }[]
    const wantDefault = body?.isDefault === true || (existing[0]?.n ?? 0) === 0

    if (wantDefault) {
      await sql`UPDATE customer_addresses SET is_default = false WHERE customer_fm_reference = ${customer.reference}`
    }

    const created = (await sql`
      INSERT INTO customer_addresses (
        customer_fm_reference, customer_email, label, address_line1, address_line2,
        city, state, zipcode, latitude, longitude, delivery_instructions, is_default
      ) VALUES (
        ${customer.reference}, ${customer.email}, ${label}, ${addressLine1}, ${addressLine2},
        ${city}, ${state}, ${zipcode}, ${latitude}, ${longitude}, ${deliveryInstructions}, ${wantDefault}
      )
      RETURNING *
    `) as AddressRow[]

    return NextResponse.json({ address: created[0] }, { status: 201 })
  } catch (err) {
    console.error('[customer-addresses POST]', err)
    return NextResponse.json({ error: 'Could not save address' }, { status: 500 })
  }
}
