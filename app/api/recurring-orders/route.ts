import { NextRequest, NextResponse } from 'next/server'
import { sql } from '../../../lib/db'
import {
  getCustomer,
  generateOccurrences,
  type FrequencyType,
  type EndKind,
} from '../../../lib/recurring'

export const runtime = 'nodejs'

interface RecurringOrderRow {
  id: string
  customer_fm_reference: string
  customer_email: string
  customer_first_name: string | null
  customer_last_name: string | null
  restaurant_reference: string
  restaurant_name: string
  restaurant_slug: string | null
  source_order_reference: string
  frequency_type: string
  repeat_every_day: string
  start_date: string
  end_kind: string
  end_count: number | null
  end_date: string | null
  status: string
  created_at: string
  updated_at: string
}

// GET — all (non-canceled) recurring orders for the logged-in customer, each
// with its occurrences attached.
export async function GET() {
  const customer = await getCustomer()
  if (!customer) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const orders = (await sql`
    SELECT * FROM recurring_orders
    WHERE customer_fm_reference = ${customer.reference}
      AND status != 'CANCELED'
    ORDER BY created_at DESC
  `) as RecurringOrderRow[]

  if (orders.length === 0) return NextResponse.json({ recurringOrders: [] })

  const ids = orders.map((o) => o.id)
  const occurrences = (await sql`
    SELECT * FROM recurring_order_occurrences
    WHERE recurring_order_id = ANY(${ids})
    ORDER BY scheduled_date ASC
  `) as { recurring_order_id: string }[]

  const byOrder = new Map<string, unknown[]>()
  for (const occ of occurrences) {
    const list = byOrder.get(occ.recurring_order_id) ?? []
    list.push(occ)
    byOrder.set(occ.recurring_order_id, list)
  }

  const recurringOrders = orders.map((o) => ({ ...o, occurrences: byOrder.get(o.id) ?? [] }))
  return NextResponse.json({ recurringOrders })
}

// POST — create a recurring order plus its generated occurrences.
export async function POST(req: NextRequest) {
  const customer = await getCustomer()
  if (!customer) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const {
    restaurantReference,
    restaurantName,
    restaurantSlug = null,
    sourceOrderReference,
    frequencyType,
    repeatEveryDay,
    startDate,
    endKind = 'NEVER',
    endCount = null,
    endDate = null,
    cartSnapshot = null,
  } = body as {
    restaurantReference?: string
    restaurantName?: string
    restaurantSlug?: string | null
    sourceOrderReference?: string
    frequencyType?: FrequencyType
    repeatEveryDay?: string
    startDate?: string
    endKind?: EndKind
    endCount?: number | null
    endDate?: string | null
    cartSnapshot?: unknown
  }

  if (!restaurantReference || !restaurantName || !sourceOrderReference) {
    return NextResponse.json({ error: 'restaurantReference, restaurantName and sourceOrderReference are required' }, { status: 400 })
  }
  if (frequencyType !== 'WEEKLY' && frequencyType !== 'BIWEEKLY' && frequencyType !== 'MONTHLY') {
    return NextResponse.json({ error: 'frequencyType must be WEEKLY, BIWEEKLY or MONTHLY' }, { status: 400 })
  }
  if (!repeatEveryDay || !startDate) {
    return NextResponse.json({ error: 'repeatEveryDay and startDate are required' }, { status: 400 })
  }
  if (endKind !== 'NEVER' && endKind !== 'COUNT' && endKind !== 'DATE') {
    return NextResponse.json({ error: 'endKind must be NEVER, COUNT or DATE' }, { status: 400 })
  }

  const created = (await sql`
    INSERT INTO recurring_orders (
      customer_fm_reference, customer_email, customer_first_name, customer_last_name,
      restaurant_reference, restaurant_name, restaurant_slug, source_order_reference,
      frequency_type, repeat_every_day, start_date, end_kind, end_count, end_date
    ) VALUES (
      ${customer.reference}, ${customer.email}, ${customer.firstName}, ${customer.lastName},
      ${restaurantReference}, ${restaurantName}, ${restaurantSlug}, ${sourceOrderReference},
      ${frequencyType}, ${repeatEveryDay}, ${startDate}, ${endKind}, ${endCount}, ${endDate}
    )
    RETURNING *
  `) as RecurringOrderRow[]

  const order = created[0]

  const generated = generateOccurrences(frequencyType, startDate, repeatEveryDay, endKind, endCount, endDate)

  let occurrences: unknown[] = []
  if (generated.length > 0) {
    const snapshot = cartSnapshot === null ? null : JSON.stringify(cartSnapshot)
    occurrences = (await sql`
      INSERT INTO recurring_order_occurrences (recurring_order_id, scheduled_date, scheduled_time, cart_snapshot)
      SELECT ${order.id}::uuid, d.scheduled_date::date, d.scheduled_time, ${snapshot}::jsonb
      FROM jsonb_to_recordset(${JSON.stringify(generated)}::jsonb)
        AS d(scheduled_date text, scheduled_time text)
      RETURNING *
    `) as unknown[]
  }

  return NextResponse.json({ recurringOrder: { ...order, occurrences } }, { status: 201 })
}
