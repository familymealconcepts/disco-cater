import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthContext, resolveDiscoScopeRef } from '../../../../lib/restaurant-auth-context'
import { getRestaurantRef } from '../../../../lib/restaurant-auth'
import { requireWritableRestaurantRef } from '../../../../lib/restaurant-write-scope'
import { runMigrations } from '../../../../lib/db'
import { restaurantActorEmail } from '../../../../lib/settings-audit'
import { normalizeMoreInfo, MORE_INFO_MAX } from '../../../../lib/more-info'
import { readMoreInfo, saveMoreInfo } from '../../../../lib/more-info-store'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// The restaurant portal's "More Info" field (lib/more-info.ts). Same sign-in and the same write
// check as /api/restaurant/disco-settings, which saves the Announcement Banner: any portal user who
// can save that can save this, for the same locations, and nobody else. Its own route rather than
// a disco-settings column because disco-settings rewrites every column it owns on each save, and
// the FM-backed Settings page never calls it.
async function currentRef(ctx: NonNullable<Awaited<ReturnType<typeof getRestaurantAuthContext>>>): Promise<string> {
  return ctx.authType === 'disco' ? await resolveDiscoScopeRef(ctx) : (await getRestaurantRef()) || ''
}

export async function GET() {
  const ctx = await getRestaurantAuthContext()
  if (!ctx) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  const ref = await currentRef(ctx)
  if (!ref) return NextResponse.json({ error: 'No restaurant in context' }, { status: 400 })
  await runMigrations()
  return NextResponse.json({ restaurant_reference: ref, moreInfo: (await readMoreInfo(ref)) ?? '' })
}

export async function PUT(req: NextRequest) {
  const ctx = await getRestaurantAuthContext()
  if (!ctx) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  let body: Record<string, unknown>
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid body' }, { status: 400 }) }
  // The ref the form was loaded for, checked against what this caller may write — never the
  // session's current selection (see disco-profile's PUT).
  const check = await requireWritableRestaurantRef(body?.restaurant_reference)
  if (!check.ok) return NextResponse.json({ error: check.error }, { status: check.status })
  if (typeof body?.moreInfo === 'string' && body.moreInfo.length > MORE_INFO_MAX * 2) {
    return NextResponse.json({ error: `More Info is limited to ${MORE_INFO_MAX} characters` }, { status: 400 })
  }
  await runMigrations()
  const value = normalizeMoreInfo(body?.moreInfo)
  await saveMoreInfo({ ref: check.ref, value, action: 'disco_settings_update', actorEmail: restaurantActorEmail(ctx), authType: ctx.authType })
  return NextResponse.json({ ok: true, moreInfo: value ?? '' })
}
