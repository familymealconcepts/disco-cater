import { sql, runMigrations } from './db'
import { logSettingsChange } from './settings-audit'

// ── THE MARKETPLACE SWITCH, AND THE ONLY CODE ALLOWED TO WRITE IT ───────────
// "Marketplace switch" = disco_restaurant_overrides.visible, the Map toggle in
// Peter's three-part rule (see CLAUDE.md, WHAT MAKES A RESTAURANT VISIBLE). This
// file is the single writer of that column. Every path that turns it on or off —
// super-admin Go Live, the admin overrides PATCH, the bulk tool, the portal
// toggle, location block/unblock, location clone, public onboarding and the
// operational scripts — calls setMarketplaceVisible() below.
//
// WHY ONE WRITER. A restaurant flagged as a TEST account (is_test) must never be
// put on the marketplace. Before this file there were nine independent upserts
// of `visible`; keeping a test restaurant off meant every one of them asking the
// same question, and the tenth path would not have known to.
// scripts/tests/marketplace-switch-guard.test.mjs fails the build if any other
// file writes `visible` with anything but a literal `false` (insert-time defaults
// in create routes stay legal: a new row starting hidden is always safe).
//
// THE RULE:
//   • Turning ON a test restaurant is REFUSED. Nothing is written; a
//     marketplace_switch_refused audit row is. HTTP callers turn the result into
//     409 { error, reason: 'test-restaurant' } via marketplaceSwitchRefusalBody.
//   • Turning OFF is always allowed — taking something off the marketplace is
//     never the dangerous direction.
//   • The refusal is decided INSIDE the write, not by a read before it. This repo
//     has no transactions (CLAUDE.md, THERE ARE NO TRANSACTIONS), so a
//     read-then-write would leave a window in which the flag is set between the
//     two. The ON CONFLICT ... WHERE below makes "turn on unless test" one
//     statement: a conflicting row whose is_test is true is simply not updated,
//     and RETURNING comes back empty.
//   • Upsert-safe: a restaurant with no overrides row yet gets one. A brand-new
//     row has is_test = false by default, so it cannot be a test restaurant.
//
// Setting is_test does NOT change `visible` (setTestRestaurant below). The flag
// is a veto on turning the switch ON, not a switch of its own, so clearing it
// puts nothing back on the marketplace by itself and is fully reversible.
//
// lib/marketplace-restaurants.ts also excludes is_test rows from the listing
// query as a LAST LINE — so a path that slips past this file, or a row that was
// visible before it was flagged, still cannot be listed.

export const TEST_RESTAURANT_REASON = 'test-restaurant' as const

export const TEST_RESTAURANT_MESSAGE =
  'This restaurant is marked as a test account, so it cannot be put on the marketplace. ' +
  'Clear the “Test account” flag in super admin first.'

/** Which path asked — recorded on every audit row this file writes. */
export type MarketplaceSwitchSource =
  | 'admin-go-live' | 'admin-overrides-patch' | 'admin-bulk'
  | 'portal-toggle' | 'portal-location-block' | 'location-clone'
  | 'onboarding' | 'script'

export interface MarketplaceSwitchOptions {
  source: MarketplaceSwitchSource
  actorEmail: string | null
  authType: 'disco' | 'fm' | 'admin' | 'script'
  /**
   * Write a marketplace_switch_update audit row for a successful change.
   * Default true. Pass false ONLY when the caller already logs its own row for
   * this write (the admin PATCH's admin_overrides_update, the portal toggle's
   * marketplace_visibility_update) — so a change is audited once, not twice. A
   * REFUSAL is always logged here regardless: no caller logs one of its own.
   */
  audit?: boolean
  /** Extra context for the audit row (e.g. a claimed vs. remapped ref). */
  extra?: Record<string, unknown>
}

export type MarketplaceSwitchResult =
  | { ok: true; visible: boolean; before: boolean | null; inserted: boolean }
  | { ok: false; reason: typeof TEST_RESTAURANT_REASON; error: string; before: boolean | null }

/** The 409 body every HTTP caller returns for a refusal. One shape, everywhere. */
export function marketplaceSwitchRefusalBody(r: { error: string; reason: typeof TEST_RESTAURANT_REASON }) {
  return { error: r.error, reason: r.reason }
}

interface SwitchRow { visible: boolean | null; is_test: boolean | null }

async function readSwitch(ref: string): Promise<SwitchRow | null> {
  const rows = (await sql`
    SELECT visible, is_test FROM disco_restaurant_overrides WHERE restaurant_reference = ${ref} LIMIT 1
  `) as SwitchRow[]
  return rows[0] ?? null
}

async function logRefusal(ref: string, before: SwitchRow | null, opts: MarketplaceSwitchOptions): Promise<void> {
  try {
    await logSettingsChange({
      action: 'marketplace_switch_refused',
      restaurantReference: ref,
      actorEmail: opts.actorEmail,
      authType: opts.authType,
      // Nothing changed — before and after are the same row, recorded so the
      // trail shows what the restaurant looked like when the attempt was made.
      before: { visible: before?.visible ?? null, is_test: true },
      after: { visible: before?.visible ?? null, is_test: true },
      extra: { source: opts.source, requested: { visible: true }, reason: TEST_RESTAURANT_REASON, ...(opts.extra || {}) },
    })
  } catch (e) {
    console.error('[marketplace-switch] refusal audit failed:', e instanceof Error ? e.message : e)
  }
}

/**
 * Pre-check for callers that write OTHER columns before the switch in the same
 * request (the admin PATCH, Go Live): refuse up front so a refused request writes
 * nothing at all. Returns the refusal (already audited) or null when the switch
 * may be turned on. setMarketplaceVisible still enforces the rule atomically —
 * this is about not half-applying a request, not about correctness of the switch.
 *
 * `isTestOverride` lets a request that also sets is_test be judged on the value
 * it is about to write rather than the stored one.
 */
export async function refuseIfTestRestaurant(
  ref: string,
  opts: MarketplaceSwitchOptions,
  isTestOverride?: boolean,
): Promise<Extract<MarketplaceSwitchResult, { ok: false }> | null> {
  await runMigrations()
  const row = await readSwitch(ref)
  const isTest = typeof isTestOverride === 'boolean' ? isTestOverride : row?.is_test === true
  if (!isTest) return null
  await logRefusal(ref, row, opts)
  return { ok: false, reason: TEST_RESTAURANT_REASON, error: TEST_RESTAURANT_MESSAGE, before: row?.visible ?? null }
}

/**
 * Turn the marketplace switch on or off. The only writer of
 * disco_restaurant_overrides.visible — see the header for the rule.
 */
export async function setMarketplaceVisible(
  ref: string,
  visible: boolean,
  opts: MarketplaceSwitchOptions,
): Promise<MarketplaceSwitchResult> {
  await runMigrations()
  // For the audit row's `before` only. The decision below does not read it.
  const before = await readSwitch(ref).catch(() => null)

  let rows: { inserted: boolean }[]
  if (visible) {
    rows = (await sql`
      INSERT INTO disco_restaurant_overrides (restaurant_reference, visible, updated_at)
      VALUES (${ref}, true, NOW())
      ON CONFLICT (restaurant_reference) DO UPDATE SET visible = true, updated_at = NOW()
        WHERE disco_restaurant_overrides.is_test IS NOT TRUE
      RETURNING (xmax = 0) AS inserted
    `) as { inserted: boolean }[]
    if (rows.length === 0) {
      // The row exists and is a test restaurant: the conditional DO UPDATE
      // touched nothing. Nothing was written.
      await logRefusal(ref, before, opts)
      return { ok: false, reason: TEST_RESTAURANT_REASON, error: TEST_RESTAURANT_MESSAGE, before: before?.visible ?? null }
    }
  } else {
    rows = (await sql`
      INSERT INTO disco_restaurant_overrides (restaurant_reference, visible, updated_at)
      VALUES (${ref}, false, NOW())
      ON CONFLICT (restaurant_reference) DO UPDATE SET visible = false, updated_at = NOW()
      RETURNING (xmax = 0) AS inserted
    `) as { inserted: boolean }[]
  }

  const inserted = rows[0]?.inserted === true
  if (opts.audit !== false) {
    try {
      await logSettingsChange({
        action: 'marketplace_switch_update',
        restaurantReference: ref,
        actorEmail: opts.actorEmail,
        authType: opts.authType,
        before: before ? { visible: before.visible } : null,
        after: { visible },
        extra: { source: opts.source, ...(opts.extra || {}) },
      })
    } catch (e) {
      console.error('[marketplace-switch] audit failed:', e instanceof Error ? e.message : e)
    }
  }
  return { ok: true, visible, before: before?.visible ?? null, inserted }
}

/**
 * Set or clear the Test account flag. Admin-only — called from the super-admin
 * overrides PATCH and nowhere in the restaurant portal. Deliberately leaves
 * `visible` alone: flagging a restaurant that is currently ON does not take it
 * off the switch (the listing query's is_test exclusion is what hides it), and
 * clearing the flag does not put anything back on. Always audited.
 */
export async function setTestRestaurant(
  ref: string,
  isTest: boolean,
  opts: { actorEmail: string | null; extra?: Record<string, unknown> },
): Promise<{ before: boolean | null; isTest: boolean }> {
  await runMigrations()
  const before = await readSwitch(ref).catch(() => null)
  await sql`
    INSERT INTO disco_restaurant_overrides (restaurant_reference, is_test, updated_at)
    VALUES (${ref}, ${isTest}, NOW())
    ON CONFLICT (restaurant_reference) DO UPDATE SET is_test = ${isTest}, updated_at = NOW()
  `
  try {
    await logSettingsChange({
      action: 'test_flag_update',
      restaurantReference: ref,
      actorEmail: opts.actorEmail,
      authType: 'admin',
      before: before ? { is_test: before.is_test, visible: before.visible } : null,
      // visible is reported unchanged on purpose — this write never touches it.
      after: { is_test: isTest, visible: before?.visible ?? null },
      extra: opts.extra,
    })
  } catch (e) {
    console.error('[marketplace-switch] test-flag audit failed:', e instanceof Error ? e.message : e)
  }
  return { before: before?.is_test ?? null, isTest }
}
