import { NextRequest, NextResponse } from 'next/server'
import { sql, runDiscoOrderMigrations } from '../../../../lib/db'
import { getRestaurantAuthContext, resolveDiscoScopeRef } from '../../../../lib/restaurant-auth-context'
import { getRestaurantRef } from '../../../../lib/restaurant-auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Disco-native restaurant SMS settings (disco_restaurant_accounts.sms_enabled /
// sms_phone), keyed by restaurant_reference so the Stripe webhook reads exactly
// what the portal writes. Settings only persist for restaurants that have a
// Disco Cater account row (the login identity for Disco-native partners).

// Resolve the authenticated restaurant's reference for either auth path:
// Disco-native sessions carry it directly; FM sessions resolve it from the JWT.
async function resolveRef(): Promise<{ ref: string } | { error: string; status: number }> {
  const ctx = await getRestaurantAuthContext()
  if (!ctx) return { error: 'Not authenticated', status: 401 }
  // Disco: the currently-selected location; FM: the JWT's restaurant.
  let ref = ctx.authType === 'disco' ? await resolveDiscoScopeRef(ctx) : (await getRestaurantRef()) || ''
  if (!ref) ref = (await getRestaurantRef()) || ''
  if (!ref) return { error: 'No restaurant in context', status: 400 }
  return { ref }
}

// GET /api/restaurant/sms-settings → { sms_enabled, sms_phone }
export async function GET() {
  const r = await resolveRef()
  if ('error' in r) return NextResponse.json({ error: r.error }, { status: r.status })
  try {
    await runDiscoOrderMigrations() // ensures sms_enabled / sms_phone columns exist
    const rows = (await sql`
      SELECT sms_enabled, sms_phone FROM disco_restaurant_accounts
      WHERE restaurant_reference = ${r.ref} ORDER BY id LIMIT 1
    `) as { sms_enabled: boolean | null; sms_phone: string | null }[]
    return NextResponse.json({
      sms_enabled: rows[0]?.sms_enabled ?? false,
      sms_phone: rows[0]?.sms_phone ?? '',
    })
  } catch (e) {
    console.error('[sms-settings] GET failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Unable to load SMS settings' }, { status: 500 })
  }
}

// PUT /api/restaurant/sms-settings  { sms_enabled?, sms_phone? } → updated values
export async function PUT(req: NextRequest) {
  const r = await resolveRef()
  if ('error' in r) return NextResponse.json({ error: r.error }, { status: r.status })

  let body: { sms_enabled?: unknown; sms_phone?: unknown }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid body' }, { status: 400 }) }

  // Partial update: omitted fields keep their current value.
  const enabled = typeof body.sms_enabled === 'boolean' ? body.sms_enabled : null
  const phoneProvided = body.sms_phone !== undefined
  const phone = phoneProvided ? String(body.sms_phone ?? '').trim() : ''

  try {
    await runDiscoOrderMigrations()
    const rows = (await sql`
      UPDATE disco_restaurant_accounts
      SET sms_enabled = COALESCE(${enabled}::boolean, sms_enabled),
          sms_phone = CASE WHEN ${phoneProvided}::boolean THEN NULLIF(${phone}::text, '') ELSE sms_phone END,
          updated_at = NOW()
      WHERE restaurant_reference = ${r.ref}
      RETURNING sms_enabled, sms_phone
    `) as { sms_enabled: boolean | null; sms_phone: string | null }[]

    if (!rows.length) {
      // No Disco account for this restaurant (e.g. an FM-only login) — nothing to
      // store. Echo the request so the UI stays consistent, with a warning.
      return NextResponse.json({
        sms_enabled: enabled ?? false,
        sms_phone: phoneProvided ? phone : '',
        warning: 'No Disco Cater account on file for this restaurant — settings not saved.',
      })
    }
    return NextResponse.json({
      sms_enabled: rows[0].sms_enabled ?? false,
      sms_phone: rows[0].sms_phone ?? '',
    })
  } catch (e) {
    console.error('[sms-settings] PUT failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Unable to save SMS settings' }, { status: 500 })
  }
}
