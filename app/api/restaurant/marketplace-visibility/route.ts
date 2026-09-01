import { NextResponse } from 'next/server'
import { sql, runMigrations } from '../../../../lib/db'
import { getRestaurantRef } from '../../../../lib/restaurant-auth'
import { getRestaurantAuthContext, resolveDiscoScopeRef } from '../../../../lib/restaurant-auth-context'
import { requireWritableRestaurantRef } from '../../../../lib/restaurant-write-scope'
import { restaurantActorEmail, overridesSnapshot, cacheSnapshot, accountMarketplaceSnapshot, pick, logSettingsChange } from '../../../../lib/settings-audit'

export const runtime = 'nodejs'

// Restaurant-scoped read/write of disco_restaurant_overrides.visible — controls
// whether the restaurant appears on the Disco Cater fullmap discovery map. The
// restaurant_reference is derived server-side from the auth cookie, so a
// restaurant can only ever read/write its OWN row.

// Resolve the restaurant_reference for either auth system: Disco-native sessions
// carry it directly; FM-token users decode it from the JWT.
async function resolveRef(): Promise<string | null> {
  const ctx = await getRestaurantAuthContext()
  if (!ctx) return null
  // Disco: the currently-selected location; FM: the JWT's restaurant.
  if (ctx.authType === 'disco') return await resolveDiscoScopeRef(ctx)
  return await getRestaurantRef()
}

export async function GET() {
  const ref = await resolveRef()
  if (!ref) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  try {
    await runMigrations()
    const rows = (await sql`
      SELECT visible FROM disco_restaurant_overrides WHERE restaurant_reference = ${ref}
    `) as { visible: boolean }[]
    return NextResponse.json({ visible: rows[0]?.visible ?? false, restaurant_reference: ref })
  } catch (err) {
    console.error('[marketplace-visibility] read failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ visible: false, restaurant_reference: ref })
  }
}

export async function PATCH(req: Request) {
  let visible = false
  let restaurantReference: unknown
  try {
    const body = await req.json()
    visible = !!body?.visible
    restaurantReference = body?.restaurant_reference
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 })
  }

  // Write target is the client-claimed restaurant_reference, verified against
  // the caller's permitted set — never the session's current selection (see
  // disco-profile's PUT for the full stale-intent rationale).
  const check = await requireWritableRestaurantRef(restaurantReference)
  if (!check.ok) return NextResponse.json({ error: check.error }, { status: check.status })
  const ref = check.ref
  // For audit attribution only — the write target is `ref` above, already
  // verified against the caller's permitted set.
  const ctx = await getRestaurantAuthContext()

  try {
    await runMigrations()

    // Prior state of all THREE tables this toggle writes. Captured before any
    // write so the audit row can report what actually changed.
    const beforeVisible = pick(await overridesSnapshot(ref), ['visible'])
    const beforeIsLive = (await cacheSnapshot(ref))?.is_live ?? null
    const beforeJoined = (await accountMarketplaceSnapshot(ref))?.joined_marketplace ?? null

    await sql`
      INSERT INTO disco_restaurant_overrides (restaurant_reference, visible, updated_at)
      VALUES (${ref}, ${visible}, NOW())
      ON CONFLICT (restaurant_reference) DO UPDATE SET visible = ${visible}, updated_at = NOW()
    `
    // Two-way marketplace sync (mirrors the super admin toggle): keep the map's
    // is_live and the account's joined_marketplace opt-in in step with visibility.
    // Both are best-effort, so their outcome is TRACKED rather than assumed — the
    // audit row must not claim a value that a swallowed failure never wrote.
    let isLiveSynced = true
    let joinedMarketplaceSynced = true
    await sql`
      UPDATE disco_restaurant_cache SET is_live = ${visible}, cached_at = NOW()
      WHERE restaurant_reference = ${ref}
    `.catch((e: unknown) => {
      isLiveSynced = false
      console.error('[marketplace-visibility] is_live sync failed:', e instanceof Error ? e.message : e)
    })
    await sql`
      UPDATE disco_restaurant_accounts SET joined_marketplace = ${visible}, updated_at = NOW()
      WHERE restaurant_reference = ${ref}
    `.catch((e: unknown) => {
      joinedMarketplaceSynced = false
      console.error('[marketplace-visibility] joined_marketplace sync failed:', e instanceof Error ? e.message : e)
    })

    // Attribution. Logged after the writes specifically so `after` reports the
    // state that landed, not the state that was intended: a swallowed sync
    // failure shows as the old value plus a false flag in `syncs`. Own try — the
    // toggle has already taken effect and must not 500 because logging failed.
    try {
      await logSettingsChange({
        action: 'marketplace_visibility_update',
        restaurantReference: ref,
        actorEmail: ctx ? restaurantActorEmail(ctx) : null,
        authType: ctx?.authType ?? 'fm',
        before: {
          visible: beforeVisible?.visible ?? null,
          is_live: beforeIsLive,
          joined_marketplace: beforeJoined,
        },
        after: {
          visible,
          is_live: isLiveSynced ? visible : beforeIsLive,
          joined_marketplace: joinedMarketplaceSynced ? visible : beforeJoined,
        },
        extra: { syncs: { isLiveSynced, joinedMarketplaceSynced } },
      })
    } catch (e) {
      console.error('[marketplace-visibility] audit row failed:', e instanceof Error ? e.message : e)
    }

    return NextResponse.json({ visible })
  } catch (err) {
    console.error('[marketplace-visibility] write failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Could not update.' }, { status: 500 })
  }
}
