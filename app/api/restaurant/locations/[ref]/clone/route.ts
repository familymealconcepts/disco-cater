import { NextResponse } from 'next/server'
import { randomUUID } from 'crypto'
import { getRestaurantAuthHeader, getRestaurantEmail } from '../../../../../../lib/restaurant-auth'
import { getRestaurantAuthContext } from '../../../../../../lib/restaurant-auth-context'
import { getLocationAccessRefs, grantLocationAccess } from '../../../../../../lib/disco-restaurant-auth'
import { resolveDiscoGroupScope, discoRefAllowed } from '../../../../../../lib/restaurant-write-scope'
import { sql, runMigrations, runDiscoOrderMigrations } from '../../../../../../lib/db'
import { cloneDiscoRestaurantMenus, cloneDiscoRestaurantOverrides } from '../../../../../../lib/locations/clone-restaurant'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

/**
 * May this FM-session caller act on `ref`?
 *
 * ── WHY NOT getCallerScopeRefs ────────────────────────────────────────────────
 * For an FM session that helper returns exactly ONE reference — getRestaurantRef(),
 * the currently-SELECTED location. That is right for an order route, which always
 * operates on the location you are looking at, and wrong here: the Locations page
 * lists every location in the chain and puts a Copy button on each row, so the set
 * the button is OFFERED on is the chain, while the set it was AUTHORIZED against
 * was a single row. Copying any location other than the selected one answered 403.
 *
 * This is what blocked Kealoha on Stacks & Cordials. Our team enters a restaurant
 * with the master password, which for an FM-backed chain logs in as an FM
 * SYSTEM_ADMIN (audit: FM_MASTER_PASSWORD_READ, adminRole SYSTEM_ADMIN,
 * alex@stacksncordials.com) and issues an fm_restaurant_token — so ctx.authType is
 * 'fm', ctx.email is '' and there is no Disco identity to scope with.
 *
 * ── THE SOURCE OF TRUTH IS THE ONE THE LIST ALREADY USES ──────────────────────
 * FM's /api/system-admin/restaurants is what decides which locations this admin
 * manages, and app/api/restaurant/locations/route.ts already authorizes the list
 * against exactly that. Reusing it means the button cannot be offered on a row the
 * clone would then refuse — the two can no longer disagree.
 *
 * This is NOT the "reaching back to FM for a native restaurant" defect. The DATA
 * still comes wholly from Disco (the clone is written from disco_restaurant_cache
 * and disco_restaurant_overrides, zero FM). What is being asked of FM here is who
 * an FM USER is, which only FM can answer, because the caller's identity is an FM
 * identity. A disco session never reaches this function.
 */
/**
 * Announce a duplicate the way FamilyMeal does.
 *
 * FM's cloneRestaurantBySystemAdmin ends by starting
 * afterRegisteredRestaurantProcessDefinition, whose single task is
 * RegisteredRestaurantSlackNotificationTaskRunnable — so in FM a duplicate posts
 * the SAME "New Partner Account Created!" message a brand-new registration does,
 * to the new-partner channel, as an orange (#ED7014) attachment. The wording,
 * field order and colour below are FM's, not ours.
 *
 * Disco's equivalent channel is SLACK_PARTNER_WEBHOOK_URL, falling back to the
 * new-order webhook exactly as become-a-partner does, so the message still lands
 * somewhere if the dedicated webhook is unset.
 *
 * NEVER THROWS. A clone that succeeded must not be reported as failed because
 * Slack was unreachable — the restaurant exists either way.
 */
async function notifyCloneToSlack(sourceName: string, newRef: string, location: string): Promise<void> {
  const url = process.env.SLACK_PARTNER_WEBHOOK_URL || process.env.SLACK_NEW_ORDER_WEBHOOK_URL
  if (!url) return
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        attachments: [{
          color: '#ED7014',
          blocks: [{
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: [
                'New Partner Account Created!',
                `Restaurant Name: ${sourceName} (Copy)`,
                `Email: `,
                `Location: ${location}`,
              ].join('\n'),
            },
          }],
        }],
      }),
    })
  } catch (e) {
    console.error('[locations/clone] Slack notify failed:', newRef, e instanceof Error ? e.message : e)
  }
}

/**
 * Remove everything a failed clone managed to write.
 *
 * Ordered child-first so no foreign key blocks the parent. Each statement is
 * independently guarded: a cleanup that gives up half way would leave exactly the
 * partial record it exists to prevent.
 *
 * MIND THE CASTS. Three tables key restaurants as TEXT, not uuid —
 * disco_restaurant_cache, disco_restaurant_overrides and
 * disco_multi_unit_link_members — while every menu table is genuinely uuid.
 * Casting ::uuid against a text column raises `operator does not exist: text =
 * uuid`, which is the bug that produced the partial rows this function cleans up.
 */
async function rollbackPartialClone(ref: string): Promise<void> {
  const steps: Array<Promise<unknown>> = []
  const run = async (fn: () => Promise<unknown>) => { try { await fn() } catch (e) { console.error('[locations/clone] cleanup step failed:', ref, e instanceof Error ? e.message : e) } }
  await run(() => sql`DELETE FROM disco_item_groups WHERE item_reference IN (SELECT reference FROM disco_menu_items WHERE restaurant_reference = ${ref}::uuid)`)
  await run(() => sql`DELETE FROM disco_modifier_group_members WHERE group_reference IN (SELECT reference FROM disco_modifier_groups WHERE restaurant_reference = ${ref}::uuid)`)
  await run(() => sql`DELETE FROM disco_menu_items WHERE restaurant_reference = ${ref}::uuid`)
  await run(() => sql`DELETE FROM disco_menu_categories WHERE restaurant_reference = ${ref}::uuid`)
  await run(() => sql`DELETE FROM disco_menus WHERE restaurant_reference = ${ref}::uuid`)
  await run(() => sql`DELETE FROM disco_modifier_groups WHERE restaurant_reference = ${ref}::uuid`)
  await run(() => sql`DELETE FROM disco_modifiers WHERE restaurant_reference = ${ref}::uuid`)
  await run(() => sql`DELETE FROM disco_restaurant_closed_days WHERE restaurant_reference = ${ref}::uuid`)
  await run(() => sql`DELETE FROM disco_multi_unit_link_members WHERE restaurant_reference = ${ref}`)
  await run(() => sql`DELETE FROM disco_restaurant_overrides WHERE restaurant_reference = ${ref}`)
  await run(() => sql`DELETE FROM disco_restaurant_cache WHERE restaurant_reference = ${ref}`)
  void steps
}

async function fmCallerMayActOn(ref: string): Promise<boolean> {
  const want = ref.trim().toLowerCase()
  try {
    const h = await getRestaurantAuthHeader()
    const res = await fetch(`${FM}/api/system-admin/restaurants?size=1000`, { headers: h })
    if (!res.ok) return false
    const data = await res.json()
    const list: Array<{ reference?: unknown }> = Array.isArray(data?.content) ? data.content : []
    return list.some((l) => String(l?.reference ?? '').trim().toLowerCase() === want)
  } catch {
    // A refusal, never a silent allow: failing open here would let any FM session
    // duplicate any location.
    return false
  }
}

export async function POST(_req: Request, { params }: { params: Promise<{ ref: string }> }) {
  const { ref } = await params
  const ctx = await getRestaurantAuthContext()

  // WHICH SYSTEM OWNS THE DUPLICATE IS DECIDED BY THE SOURCE RESTAURANT, NOT BY
  // HOW THE CALLER HAPPENS TO BE LOGGED IN.
  //
  // This used to branch on `ctx?.authType === 'disco'`, so a SYSTEM_ADMIN holding
  // an fm_restaurant_token fell through to the FM path and POSTed to FM's clone
  // endpoint even when duplicating a Disco-native restaurant — creating a
  // FamilyMeal record for a native one, which the architecture forbids outright.
  // Three such records exist ([COPY] Stacks & Cordials - Royal Oak x2, [COPY] Tap
  // 42 - Aventura). Same defect shape as the super-admin 404 fixed in 443e91c:
  // deciding from the caller's cookie rather than from the thing that matters.
  await runMigrations(); await runDiscoOrderMigrations()
  const rows = (await sql`SELECT * FROM disco_restaurant_cache WHERE restaurant_reference = ${ref} LIMIT 1`) as Record<string, unknown>[]
  // Never guess. Falling back to the FM path for an unresolvable source is exactly
  // how an FM record gets created for a native restaurant, so an unknown source is
  // an error, not a default.
  if (!rows.length) {
    return NextResponse.json({
      error: 'Could not find this location, so it was not duplicated. Email concierge@discocater.com and we’ll look into it.',
    }, { status: 404 })
  }
  const sourceIsNative = rows[0].is_disco_native === true

  // Disco-native: duplicate the location (profile + full menu tree) into a new,
  // not-live restaurant in the SA's group. Zero FM.
  if (sourceIsNative) {
    if (!ctx) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    // A disco session keeps its existing group check unchanged. An FM session is
    // now reachable here (it never was before) and is scoped with the same
    // both-auth-types resolver the order routes use, because a native restaurant
    // has no FM record for FM to authorize against.
    const scope = ctx.authType === 'disco' ? await resolveDiscoGroupScope(ctx) : null
    const allowed = scope
      ? discoRefAllowed(scope, ref)
      : await fmCallerMayActOn(ref)
    if (!allowed) {
      return NextResponse.json({
        error: 'You don’t have access to this location, so it was not duplicated. If you reached it through the master password, open the location first and try again — or email concierge@discocater.com.',
      }, { status: 403 })
    }
    // ── EVERY THROW BELOW MUST BECOME AN EXPLAINED RESPONSE ──────────────────
    // This block had no try/catch at all, so a failure escaped the handler, Next
    // answered with a non-JSON 500, the UI's res.json() threw, body.error was
    // undefined and the operator saw only the generic fallback. That is precisely
    // what Kealoha hit: cloneDiscoRestaurantMenus threw
    //   operator does not exist: text = uuid  (42883)
    // and nothing anywhere could say so. The message names the step that failed,
    // and the real error goes to the server log for us.
    const s = rows[0]
    const newRef = randomUUID()
    // Declared outside the try so the cleanup below can name what to remove.
    const failedRef = newRef
    try {
    const newSlug = `${(s.slug as string) || 'location'}-copy-${newRef.slice(0, 8)}`
    await sql`
      INSERT INTO disco_restaurant_cache (
        restaurant_reference, name, slug, cuisine, description, image_url, lat, lng, location,
        address, address_line2, city, state, zipcode, phone, timezone, icon_url, is_disco_native, is_live
      ) VALUES (
        ${newRef}, ${((s.name as string) || 'Location') + ' (Copy)'}, ${newSlug}, ${s.cuisine}, ${s.description}, ${s.image_url}, ${s.lat}, ${s.lng}, ${s.location},
        ${s.address}, ${s.address_line2}, ${s.city}, ${s.state}, ${s.zipcode}, ${s.phone}, ${s.timezone}, ${s.icon_url}, true, true
      )`
    // ── THE COPY IS OWNED BY WHOEVER MADE IT, AND BY WHOEVER OWNS THE SOURCE ──
    // Access is expressed ONLY through disco_restaurant_location_access, the same
    // mechanism getDiscoGroupAccounts checks first and the same one the Locations
    // page and resolveDiscoScopeRef already honour. Nothing new is invented here.
    //
    // Two grants, for two different reasons:
    //
    // 1. THE ACTOR. The system admin who clicked Copy must be able to manage what
    //    they just created. This used to run only `if (scope && ctx.email)` — a
    //    DISCO session — and an FM session's ctx.email is always '' (see
    //    RestaurantAuthContext), so a clone made with the master password, which is
    //    how the Disco Cater team enters every restaurant, granted nobody anything.
    //    The actor's identity for an FM session comes from the FM JWT's own `sub`
    //    claim (getRestaurantEmail — the same resolver d77c35f added for exactly
    //    this gap), so both session types now name a real person.
    //
    // 2. EVERYONE WHO ALREADY OWNS THE SOURCE. "The same access to the copy as
    //    they have to the source" is satisfied by mirroring the source's existing
    //    grants onto the copy, so a chain whose locations are shared by several
    //    admins does not end up with a copy only one of them can see.
    //
    // The backfill in (1) is unchanged in spirit: explicit access WINS over
    // business-name grouping, so granting a single ref to someone who had no
    // explicit rows would hide every other location they previously reached by
    // name. When they have no explicit rows yet, their whole current group is
    // written out alongside the copy.
    const actorEmail = (ctx.email || (await getRestaurantEmail()) || '').trim().toLowerCase()
    if (actorEmail) {
      const existing = await getLocationAccessRefs(actorEmail)
      // An FM caller has no `scope`; it was authorized by fmCallerMayActOn instead.
      // With no group to backfill, grant the copy alone — there is nothing to hide.
      const toGrant = existing.length || !scope || scope.unrestricted ? [newRef] : [...scope.refs, newRef]
      for (const r of toGrant) await grantLocationAccess(actorEmail, r, actorEmail).catch(() => {})
    }
    // Mirror the SOURCE's grants onto the copy. ON CONFLICT DO NOTHING inside
    // grantLocationAccess makes re-granting the actor harmless.
    const sourceOwners = (await sql`
      SELECT account_email FROM disco_restaurant_location_access WHERE restaurant_reference = ${ref}
    `.catch(() => [])) as { account_email: string }[]
    for (const o of sourceOwners) {
      await grantLocationAccess(o.account_email, newRef, actorEmail || o.account_email).catch(() => {})
    }

    // ── IS_LIVE TRUE, AND STRIPE IS THE GATE ─────────────────────────────────
    // Matches FM, which builds a copy with .status(RestaurantStatus.ACCEPTED) and
    // never touches `blocked` (entity default FALSE) — so an FM duplicate is
    // immediately listed and orderable. Observed live too: [COPY] Tap 42 -
    // Aventura and [COPY] Inga's Alpine Tavern both sit in FM's public list today.
    //
    // This used to write is_live=false with visible=false, on the reasoning that a
    // duplicate is a draft. That conflated two separate things and is what made a
    // duplicate nobody could find: marketplace visibility is not the mechanism for
    // stopping orders. WHETHER IT CAN SELL IS DECIDED BY STRIPE — a duplicate
    // inherits no stripe_account_id (see cloneDiscoRestaurantOverrides), and the
    // native marketplace feed already requires visible + online-ordering + a
    // Stripe account, so it stays out of the public feed on the Stripe leg alone
    // while being fully visible to the people who run the restaurant.
    //
    // ── THE DUPLICATE MUST JOIN THE CHAIN, OR NOBODY CAN SEE IT ───────────────
    // FM does this explicitly and it is the step Disco was missing:
    //
    //   clonedRestaurant.setRestaurantGroup(restaurantGroup);
    //   clonedRestaurant.setLocationPosition(restaurantGroup.getRestaurants().size());
    //   // Add cloned restaurant to system admin's managed restaurants
    //   currentUser.getManagedRestaurants().add(clonedRestaurant);
    //   userRepository.save(currentUser);
    //
    // Without the Disco equivalent the copy exists but belongs to no group, and
    // the native Locations list filters on resolveDiscoGroupScope — which reads
    // group ACCOUNTS, not the cache — so a duplicate with no account row and no
    // grant is invisible to everyone. That is exactly what happened to Peter's.
    //
    // The grant block above only fires for a DISCO session with an email. A
    // master-password/FM session has ctx.email === '', so it granted nothing at
    // all. Chain membership is the answer that works for both: the source's
    // multi-unit link IS Disco's own native grouping (Stacks & Cordials' two
    // locations share link 9ddf1b0d), it is entirely within Disco, and it needs
    // no caller identity. Every human who can reach the source therefore reaches
    // the copy, which is what FM's managed-restaurants add achieves.
    try {
      await sql`
        INSERT INTO disco_multi_unit_link_members (link_reference, restaurant_reference)
        SELECT link_reference, ${newRef} FROM disco_multi_unit_link_members
         WHERE restaurant_reference = ${ref}
        ON CONFLICT DO NOTHING`
    } catch (e) {
      // Reported, never fatal: a copy outside the chain is recoverable by hand,
      // a failed clone that already wrote a menu tree is not.
      console.error('[locations/clone] could not add the copy to the source chain:', newRef, e instanceof Error ? e.message : e)
    }
    await cloneDiscoRestaurantMenus(ref, newRef)
    // The settings row, WITHOUT the Stripe account — see cloneDiscoRestaurantOverrides.
    // Without this the duplicate has no tax config and checkout refuses every order,
    // which is how both existing native copies ended up unable to transact.
    await cloneDiscoRestaurantOverrides(ref, newRef)

    // ── SLACK, MATCHING FM'S OWN MESSAGE ─────────────────────────────────────
    // FM routes a duplicate through afterRegisteredRestaurantProcessDefinition,
    // whose only task is RegisteredRestaurantSlackNotificationTaskRunnable — so a
    // copy announces itself with the SAME message a brand-new partner does, to
    // the new-partner channel (slack.notifications.new-partner-path), as an
    // orange (#ED7014) attachment. Disco's equivalent channel is
    // SLACK_PARTNER_WEBHOOK_URL. Wording and colour follow FM's rather than
    // being invented.
    await notifyCloneToSlack(String(s.name ?? ''), newRef, String(s.address ?? '') || String(s.zipcode ?? ''))

    return NextResponse.json({ ok: true, reference: newRef })
    } catch (e) {
      console.error('[locations/clone] native clone failed:', ref, e instanceof Error ? (e.stack || e.message) : e)
      // ── NO PARTIAL RECORDS ───────────────────────────────────────────────
      // These writes are separate statements on Neon's HTTP driver, which has no
      // session to hold a transaction across them, so a throw part-way leaves
      // whatever already landed. That is not hypothetical: two "Stacks &
      // Cordials - Royal Oak (Copy)" rows exist with a full 35-item menu tree and
      // NO settings row at all, because the old text = uuid throw happened
      // between the two. A half-built restaurant is worse than none — it is
      // listed, unconfigured, and cannot take an order.
      await rollbackPartialClone(failedRef).catch((ce) =>
        console.error('[locations/clone] cleanup after failure ALSO failed:', failedRef, ce instanceof Error ? ce.message : ce))
      return NextResponse.json({
        error: 'Could not finish duplicating this location, so the partial copy was removed. Nothing was created. Email concierge@discocater.com with the location name and we’ll look into it.',
      }, { status: 500 })
    }
  }

  let h: Record<string, string>
  try { h = await getRestaurantAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  try {
    const res = await fetch(`${FM}/api/system-admin/restaurants/${ref}/clone`, { method: 'POST', headers: h })
    if (!res.ok) return NextResponse.json({ error: 'Failed' }, { status: res.status })
    const text = await res.text()
    return NextResponse.json(text ? JSON.parse(text) : { ok: true })
  } catch { return NextResponse.json({ error: 'Unable to clone' }, { status: 500 }) }
}
