// M3 — FM-backed → Disco-native conversion tooling.
//
// Converting an existing FM restaurant to fully Disco-native is a sequenced,
// verify-before-flip operation. The heavy steps (build the native menu, onboard
// Stripe) are done with the EXISTING tools (menu import dual-write,
// become-a-partner Stripe Connect); this module ORCHESTRATES the readiness check
// and performs the one irreversible-feeling step — flipping is_disco_native — only
// when every prerequisite passes, with marketplace visibility preserved (never
// silently dropped) via the M4 readiness gate.
//
// Sequence enforced (per the approved plan):
//   backfill orders → build native menu → link account → fresh Stripe onboarding
//   → populate settings → M4 readiness gate MUST pass → flip is_disco_native
//   → (visibility stays as-is; the gate guarantees it won't drop off).
import { sql, runMigrations } from './db'
import { checkMarketplaceReadiness } from './marketplace-readiness'

export interface ConversionStep {
  key: 'not-already-native' | 'native-menu' | 'stripe-ready' | 'settings' | 'marketplace-ready'
  label: string
  done: boolean
  blocking: boolean
  detail: string
}

export interface ConversionReadiness {
  restaurantReference: string
  found: boolean
  isDiscoNative: boolean
  steps: ConversionStep[]
  ordersMirrored: number       // advisory: run a final sync/fm-orders before flipping
  ready: boolean               // all BLOCKING steps pass
}

export async function checkConversionReadiness(ref: string): Promise<ConversionReadiness> {
  await runMigrations()

  const cache = (await sql`
    SELECT name, is_disco_native FROM disco_restaurant_cache WHERE restaurant_reference = ${ref} LIMIT 1
  `) as { name: string | null; is_disco_native: boolean | null }[]
  const found = cache.length > 0
  const isDiscoNative = cache[0]?.is_disco_native === true

  // Native menu: a visible, non-archived disco_menus row (native pricing reads the
  // primary visible menu). restaurant_reference is UUID on disco_menus.
  const menu = (await sql`
    SELECT COUNT(*)::int AS n FROM disco_menus
    WHERE restaurant_reference = ${ref}::uuid AND visible = true AND archived = false
  `.catch(() => [{ n: 0 }])) as { n: number }[]
  const hasMenu = (menu[0]?.n ?? 0) > 0

  // Stripe: a connected account with completed onboarding (via own ref or the FM bridge).
  const acct = (await sql`
    SELECT COUNT(*)::int AS n FROM disco_restaurant_accounts
    WHERE (restaurant_reference = ${ref} OR fm_restaurant_reference = ${ref})
      AND stripe_account_id IS NOT NULL AND stripe_onboarding_complete = true
  `.catch(() => [{ n: 0 }])) as { n: number }[]
  const stripeReady = (acct[0]?.n ?? 0) > 0

  // Settings: an overrides row with tax rates mirrored and online ordering not off.
  const ov = (await sql`
    SELECT tax_rates, online_ordering_enabled FROM disco_restaurant_overrides
    WHERE restaurant_reference = ${ref} LIMIT 1
  `.catch(() => [])) as { tax_rates: unknown; online_ordering_enabled: boolean | null }[]
  const settingsOk = !!ov[0]?.tax_rates && ov[0]?.online_ordering_enabled !== false

  // Orders already mirrored (advisory — a final sync is recommended before flip).
  const orders = (await sql`
    SELECT COUNT(*)::int AS n FROM disco_orders WHERE restaurant_reference = ${ref}::uuid
  `.catch(() => [{ n: 0 }])) as { n: number }[]
  const ordersMirrored = orders[0]?.n ?? 0

  // M4 gate: would it stay visible under the native 3-part rule?
  const mk = await checkMarketplaceReadiness(ref)
  const marketplaceReady = mk.wouldBeVisibleAsNative === true

  const steps: ConversionStep[] = [
    { key: 'not-already-native', label: 'Not already Disco-native', done: found && !isDiscoNative, blocking: true, detail: !found ? 'Restaurant not found.' : isDiscoNative ? 'Already Disco-native.' : 'FM-backed — eligible to convert.' },
    { key: 'native-menu', label: 'Native menu built', done: hasMenu, blocking: true, detail: hasMenu ? 'A visible Disco-native menu exists.' : 'No visible native menu — run the menu import (dual-write) first.' },
    { key: 'stripe-ready', label: 'Stripe onboarded', done: stripeReady, blocking: true, detail: stripeReady ? 'Connected account finished Stripe onboarding.' : 'No completed Disco Stripe account — run native Stripe onboarding.' },
    { key: 'settings', label: 'Settings populated', done: settingsOk, blocking: false, detail: settingsOk ? 'Tax rates mirrored; online ordering on.' : 'Populate tax rates and enable online ordering.' },
    { key: 'marketplace-ready', label: 'Won’t drop off marketplace', done: marketplaceReady, blocking: true, detail: marketplaceReady ? 'Passes the native 3-part visibility rule.' : `Would be hidden as native: ${mk.blockers.map(b => b.message).join(' ') || 'check visibility.'}` },
  ]

  const ready = found && steps.filter(s => s.blocking).every(s => s.done)
  return { restaurantReference: ref, found, isDiscoNative, steps, ordersMirrored, ready }
}

export interface ConversionResult {
  converted: boolean
  reason?: string
  readiness: ConversionReadiness
}

// Perform the flip — ONLY when every blocking step passes. Sets is_disco_native
// true; visibility is left as-is (the marketplace-ready gate guarantees it stays
// visible if it was). Never flips a restaurant that isn't ready.
export async function convertToNative(ref: string): Promise<ConversionResult> {
  const readiness = await checkConversionReadiness(ref)
  if (!readiness.found) return { converted: false, reason: 'Restaurant not found.', readiness }
  if (readiness.isDiscoNative) return { converted: false, reason: 'Already Disco-native.', readiness }
  if (!readiness.ready) {
    const failing = readiness.steps.filter(s => s.blocking && !s.done).map(s => s.label).join(', ')
    return { converted: false, reason: `Not ready — resolve: ${failing}.`, readiness }
  }
  await sql`UPDATE disco_restaurant_cache SET is_disco_native = true, cached_at = NOW() WHERE restaurant_reference = ${ref}`
  return { converted: true, readiness: { ...readiness, isDiscoNative: true } }
}
