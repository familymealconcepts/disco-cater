import { NextRequest, NextResponse } from 'next/server'
import { sql } from '../../../lib/db'
import {
  getCustomer,
  generateOccurrences,
  extractStripeIds,
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
  try {
    const customer = await getCustomer()
    if (!customer) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

    // Best-effort schema safety net: the Stripe columns are added by
    // scripts/migrate-stripe.ts; ensure they exist so the INSERT below can't 500
    // on a DB where that migration hasn't been applied.
    try { await sql`ALTER TABLE recurring_orders ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT` } catch {}
    try { await sql`ALTER TABLE recurring_orders ADD COLUMN IF NOT EXISTS stripe_payment_method_id TEXT` } catch {}
    try { await sql`ALTER TABLE recurring_orders ADD COLUMN IF NOT EXISTS source_order_total NUMERIC` } catch {}

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
      sourceOrderTotal = null,
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
      sourceOrderTotal?: number | null
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

    // Capture the diner's saved Stripe customer + payment method so the cron can
    // charge off-session. We reuse the existing payment-source endpoint (forwarding
    // the caller's cookies for its FM auth). No card on file → store nulls; the
    // cron's "no card" path then handles the payment-reminder flow.
    let stripeCustomerId: string | null = null
    let stripePaymentMethodId: string | null = null
    try {
      const psRes = await fetch(new URL('/api/fm-payment-source', req.url), {
        headers: { cookie: req.headers.get('cookie') || '' },
      })
      if (psRes.ok) {
        const source = await psRes.json()
        const ids = extractStripeIds(source)
        stripeCustomerId = ids.stripeCustomerId
        stripePaymentMethodId = ids.stripePaymentMethodId
      }
    } catch (e) {
      console.warn('[recurring-orders POST] could not fetch payment source:', e)
    }

    const created = (await sql`
      INSERT INTO recurring_orders (
        customer_fm_reference, customer_email, customer_first_name, customer_last_name,
        restaurant_reference, restaurant_name, restaurant_slug, source_order_reference,
        frequency_type, repeat_every_day, start_date, end_kind, end_count, end_date,
        stripe_customer_id, stripe_payment_method_id, source_order_total
      ) VALUES (
        ${customer.reference}, ${customer.email}, ${customer.firstName}, ${customer.lastName},
        ${restaurantReference}, ${restaurantName}, ${restaurantSlug}, ${sourceOrderReference},
        ${frequencyType}, ${repeatEveryDay}, ${startDate}, ${endKind}, ${endCount}, ${endDate},
        ${stripeCustomerId}, ${stripePaymentMethodId}, ${sourceOrderTotal}
      )
      RETURNING *
    `) as RecurringOrderRow[]

    const order = created[0]

    const generated = generateOccurrences(frequencyType, startDate, repeatEveryDay, endKind, endCount, endDate)

    let occurrences: unknown[] = []
    if (generated.length > 0) {
      const snapshot = cartSnapshot === null ? null : JSON.stringify(cartSnapshot)
      // generateOccurrences() returns camelCase keys (scheduledDate/scheduledTime),
      // so the recordset column names must be quoted to match exactly — otherwise
      // jsonb_to_recordset yields NULLs and the NOT NULL scheduled_date 500s.
      occurrences = (await sql`
        INSERT INTO recurring_order_occurrences (recurring_order_id, scheduled_date, scheduled_time, cart_snapshot)
        SELECT ${order.id}::uuid, d."scheduledDate"::date, d."scheduledTime", ${snapshot}::jsonb
        FROM jsonb_to_recordset(${JSON.stringify(generated)}::jsonb)
          AS d("scheduledDate" text, "scheduledTime" text)
        RETURNING *
      `) as unknown[]
    }

    return NextResponse.json({ recurringOrder: { ...order, occurrences } }, { status: 201 })
  } catch (err) {
    console.error('[recurring-orders POST]', err)
    return NextResponse.json({ error: 'Could not set up recurring order' }, { status: 500 })
  }
}
