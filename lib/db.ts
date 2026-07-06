import { neon, type NeonQueryFunction } from '@neondatabase/serverless'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

// Lazy Neon client. `neon()` throws if DATABASE_URL is unset, and it would do
// so at *import* time — which crashes `next build`'s page-data collection on
// any environment without the var (local builds, CI). The Proxy defers that to
// the first actual query, so importing this module is always safe. Usage is
// unchanged: tagged template `sql\`...\`` and `sql.query(...)`.

let client: NeonQueryFunction<false, false> | undefined

function getClient(): NeonQueryFunction<false, false> {
  if (!client) {
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL is not set — cannot reach the Neon database.')
    }
    client = neon(process.env.DATABASE_URL)
  }
  return client
}

export const sql = new Proxy(function () {} as unknown as NeonQueryFunction<false, false>, {
  apply(_target, _thisArg, args: unknown[]) {
    return (getClient() as unknown as (...a: unknown[]) => unknown)(...args)
  },
  get(_target, prop) {
    const c = getClient() as unknown as Record<string | symbol, unknown>
    const value = c[prop]
    return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(c) : value
  },
}) as NeonQueryFunction<false, false>

// ── Promo-code schema migration ───────────────────────────────────────────────
// Idempotent (IF NOT EXISTS) and cached per-lambda. Each promo API route calls
// this at the top so the tables exist without a separate migration step. The
// Neon HTTP driver runs one statement per round-trip, so each DDL runs alone.
let promoMigrated = false
export async function runMigrations(): Promise<void> {
  if (promoMigrated) return
  const statements = [
    `CREATE TABLE IF NOT EXISTS promo_codes (id SERIAL PRIMARY KEY, code TEXT UNIQUE NOT NULL, discount_type TEXT NOT NULL CHECK (discount_type IN ('flat', 'percent')), discount_value NUMERIC(10,2) NOT NULL, scope TEXT NOT NULL DEFAULT 'global' CHECK (scope IN ('global', 'restaurant')), restaurant_ref TEXT, max_uses INT, uses_count INT NOT NULL DEFAULT 0, max_uses_per_user INT NOT NULL DEFAULT 1, first_time_only BOOLEAN NOT NULL DEFAULT false, min_order_subtotal NUMERIC(10,2), max_discount_cap NUMERIC(10,2), valid_from TIMESTAMPTZ NOT NULL DEFAULT NOW(), valid_until TIMESTAMPTZ, active BOOLEAN NOT NULL DEFAULT true, notes TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
    `CREATE TABLE IF NOT EXISTS promo_code_uses (id SERIAL PRIMARY KEY, promo_code_id INT NOT NULL REFERENCES promo_codes(id), user_email TEXT NOT NULL, order_ref TEXT NOT NULL, discount_applied NUMERIC(10,2) NOT NULL, stripe_refund_id TEXT, refund_status TEXT DEFAULT 'pending', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
    `CREATE INDEX IF NOT EXISTS idx_promo_code_uses_email ON promo_code_uses(user_email)`,
    `CREATE INDEX IF NOT EXISTS idx_promo_code_uses_code_id ON promo_code_uses(promo_code_id)`,
    // ── Restaurant-funded promo codes ─────────────────────────────────────────
    // `funded_by` distinguishes who absorbs the discount:
    //   'DISCO'      → platform Stripe refund post-charge (existing behavior;
    //                  restaurant keeps full payment).
    //   'RESTAURANT' → discount reduces the FM PaymentIntent pre-charge so the
    //                  restaurant absorbs it (mirrors the tax-exempt PI reduction).
    // Enforced in app code (only 'DISCO'/'RESTAURANT' are ever written); the
    // default 'DISCO' correctly classifies every pre-existing row.
    `ALTER TABLE promo_codes ADD COLUMN IF NOT EXISTS funded_by TEXT NOT NULL DEFAULT 'DISCO'`,
    // Uniqueness moves from code-alone to a scope-aware pair: a restaurant may
    // hold many codes, and two restaurants may reuse the same code, but a given
    // (restaurant, code) is unique. Global (Disco-wide) codes stay unique among
    // themselves. Case-insensitive to match the UPPER() lookup in /api/promo/validate.
    `ALTER TABLE promo_codes DROP CONSTRAINT IF EXISTS promo_codes_code_key`,
    `CREATE UNIQUE INDEX IF NOT EXISTS promo_codes_global_code_uq ON promo_codes (UPPER(code)) WHERE restaurant_ref IS NULL`,
    `CREATE UNIQUE INDEX IF NOT EXISTS promo_codes_restaurant_code_uq ON promo_codes (restaurant_ref, UPPER(code)) WHERE restaurant_ref IS NOT NULL`,
    // Speeds the restaurant-portal listing (all codes for a restaurant, newest first).
    `CREATE INDEX IF NOT EXISTS idx_promo_codes_restaurant_ref ON promo_codes(restaurant_ref)`,
    // Per-redemption audit columns. `funded_by`/`restaurant_ref`/
    // `stripe_payment_intent_id` are recorded on each use. Restaurant-funded codes
    // now settle PRE-CHARGE in /api/order/place (subtotal reduction — no refund/
    // reversal), so the reversal_status/stripe_reversal_id/stripe_charge_id columns
    // are legacy (from the retired transfer-reversal approach) and left in place
    // (harmless, no longer written); the index is kept for any historical rows.
    `ALTER TABLE promo_code_uses ADD COLUMN IF NOT EXISTS funded_by TEXT`,
    `ALTER TABLE promo_code_uses ADD COLUMN IF NOT EXISTS restaurant_ref TEXT`,
    `ALTER TABLE promo_code_uses ADD COLUMN IF NOT EXISTS stripe_charge_id TEXT`,
    `ALTER TABLE promo_code_uses ADD COLUMN IF NOT EXISTS stripe_payment_intent_id TEXT`,
    `ALTER TABLE promo_code_uses ADD COLUMN IF NOT EXISTS reversal_status TEXT`,
    `ALTER TABLE promo_code_uses ADD COLUMN IF NOT EXISTS stripe_reversal_id TEXT`,
    `CREATE INDEX IF NOT EXISTS idx_promo_code_uses_charge ON promo_code_uses(stripe_charge_id)`,
    // Generic key/value store for cross-run cursors (e.g. the FM→Sanity sync offset).
    `CREATE TABLE IF NOT EXISTS sync_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
    // Disco-owned per-restaurant overrides layered on top of the FM restaurant
    // record: Premium (isDisco) flag + an order-URL override, set in the super
    // admin edit dialog and read by the public /api/restaurants (fullmap).
    `CREATE TABLE IF NOT EXISTS disco_restaurant_overrides (
      restaurant_reference TEXT PRIMARY KEY,
      is_premium BOOLEAN NOT NULL DEFAULT false,
      visible BOOLEAN NOT NULL DEFAULT false,
      order_url TEXT,
      notes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    // Self-heal DBs created before `visible` existed. Drives fullmap listing:
    // a restaurant appears only when an admin marks it visible.
    `ALTER TABLE disco_restaurant_overrides ADD COLUMN IF NOT EXISTS visible BOOLEAN NOT NULL DEFAULT false`,
    // Stripe Connect status, populated by the /api/admin/sync-stripe-status tool.
    // The fullmap only lists restaurants that are visible AND stripe_connected.
    `ALTER TABLE disco_restaurant_overrides ADD COLUMN IF NOT EXISTS stripe_connected BOOLEAN NOT NULL DEFAULT false`,
    `ALTER TABLE disco_restaurant_overrides ADD COLUMN IF NOT EXISTS stripe_checked_at TIMESTAMPTZ`,
    // Manual pinning for the fullmap default sort: 1..N appear first (by this
    // value ascending), ahead of the alphabetical Premium / non-Premium groups.
    `ALTER TABLE disco_restaurant_overrides ADD COLUMN IF NOT EXISTS featured_order INT DEFAULT NULL`,
    // Disco-side mirror of FM's onlineOrderingAllowed, written alongside the FM
    // call so the super admin view + Disco-native restaurants have a source of
    // truth (FM is unavailable for Disco-native restaurants).
    // Online ordering defaults ON — a restaurant can take orders unless explicitly
    // paused. (The native order gate reads COALESCE(online_ordering_enabled, true),
    // so a missing row is also "open"; a stored FALSE means an intentional pause.)
    `ALTER TABLE disco_restaurant_overrides ADD COLUMN IF NOT EXISTS online_ordering_enabled BOOLEAN DEFAULT true`,
    `ALTER TABLE disco_restaurant_overrides ALTER COLUMN online_ordering_enabled SET DEFAULT true`,
    // Neon mirror of FM's session-scoped notification settings (PUT /api/notifications),
    // written on every order-settings save. A daily cron + the server-side order
    // dispatch have no restaurant session, so they read these instead of FM.
    // order_reminder_emails_enabled ← FM orderReminderEmailsEnabled;
    // notification_emails ← FM email[] recipient list (comma-separated).
    `ALTER TABLE disco_restaurant_overrides ADD COLUMN IF NOT EXISTS order_reminder_emails_enabled BOOLEAN DEFAULT false`,
    // admin_order_reminder_emails_enabled ← FM adminOrderReminderEmailsEnabled: the
    // SEPARATE restaurant-facing reminder toggle. Mirrored on every notifications
    // save; read by the hourly order-reminders cron's restaurant/admin pass.
    `ALTER TABLE disco_restaurant_overrides ADD COLUMN IF NOT EXISTS admin_order_reminder_emails_enabled BOOLEAN`,
    `ALTER TABLE disco_restaurant_overrides ADD COLUMN IF NOT EXISTS notification_emails TEXT`,
    // Disco-native multi-phone SMS recipient list (comma-separated, mirrors the
    // notification_emails pattern). Replaces the single
    // disco_restaurant_accounts.sms_phone going forward; that column is kept as a
    // back-compat fallback when this is empty for a restaurant.
    `ALTER TABLE disco_restaurant_overrides ADD COLUMN IF NOT EXISTS notification_sms_numbers TEXT`,
    // General Settings parity (Disco-native): a customer-facing menu search toggle
    // (RestaurantClient reads restaurantSettings.enableMenuSearch), an announcement
    // banner shown on the native customer page, and an SMS-notifications on/off
    // (mirrors FM's phoneNotificationType). All default off/empty → no visible change.
    `ALTER TABLE disco_restaurant_overrides ADD COLUMN IF NOT EXISTS enable_menu_search BOOLEAN NOT NULL DEFAULT false`,
    `ALTER TABLE disco_restaurant_overrides ADD COLUMN IF NOT EXISTS announcement TEXT`,
    `ALTER TABLE disco_restaurant_overrides ADD COLUMN IF NOT EXISTS text_notifications_enabled BOOLEAN NOT NULL DEFAULT false`,
    // Disco-side mirror of FM's per-restaurant `moneyFlow` (DIRECT | FAMILY_MEAL),
    // written alongside the FM money-flow PUT.
    `ALTER TABLE disco_restaurant_overrides ADD COLUMN IF NOT EXISTS money_flow TEXT`,
    // Disco-side mirror of FM's per-restaurant tax rates ({stateSalesTax, localSalesTax,
    // otherSalesTax}, each {percent, fixedAmount}; otherSalesTax also has `types`).
    // FM only exposes tax rates via an ADMIN endpoint scoped to the authenticated
    // restaurant (no by-ref/SUPER_ADMIN access), so we mirror them on every
    // tax-rate GET/PUT in the restaurant portal. The customer checkout reads THIS
    // to recompute a restaurant-funded promo's discounted tax to the cent; if a
    // restaurant's rates aren't mirrored yet, the discount safely doesn't apply.
    `ALTER TABLE disco_restaurant_overrides ADD COLUMN IF NOT EXISTS tax_rates JSONB`,
    // Native lead-gen commission rates (whole-number percents). FM stores these as
    // Restaurant.leadGenOne/leadGenTwo, but Disco-native restaurants have no FM
    // record, so the native checkout reads them from here. Fee 1 applies to a
    // customer's FIRST paid order from this restaurant; fee 2 to every order after,
    // forever (per customer↔restaurant pair). Defaults mirror FM's 15% / 5%.
    `ALTER TABLE disco_restaurant_overrides ADD COLUMN IF NOT EXISTS lead_gen_one_pct NUMERIC(5,2) DEFAULT 15`,
    `ALTER TABLE disco_restaurant_overrides ADD COLUMN IF NOT EXISTS lead_gen_two_pct NUMERIC(5,2) DEFAULT 5`,
    // Super-admin "withhold payouts" freeze for Disco-native restaurants. When true,
    // the native checkout charges WITHOUT a transfer_data destination so funds stay
    // in the platform account (mirrors FM's payout hold); the intended payout is
    // still recorded so it can be released later. Enforced in the native place route.
    `ALTER TABLE disco_restaurant_overrides ADD COLUMN IF NOT EXISTS withhold_payouts BOOLEAN NOT NULL DEFAULT false`,
    // Delivery order time-window granularity (Stage 9): how a delivery order's time
    // is shown to the customer — 'exact' | '30_min' | '1_hour'. Mirrors FM's
    // feesAndTips.deliveryOrderTimeWindows; read by the customer flow for disco-native.
    `ALTER TABLE disco_restaurant_overrides ADD COLUMN IF NOT EXISTS delivery_order_time_windows VARCHAR(12) NOT NULL DEFAULT 'exact'`,
    // Snapshot of FM restaurants for fast public map loads — refreshed by
    // /api/admin/refresh-restaurant-cache (and the daily sync cron) so the public
    // /api/restaurants reads Neon only, never FM.
    `CREATE TABLE IF NOT EXISTS disco_restaurant_cache (
      restaurant_reference TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT,
      cuisine TEXT DEFAULT 'Other',
      description TEXT,
      image_url TEXT,
      lat NUMERIC,
      lng NUMERIC,
      location TEXT,
      address TEXT,
      cached_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    // Reference (URL or filename) of a menu PDF a partner uploaded during
    // onboarding — recorded by /api/become-a-partner/complete.
    `ALTER TABLE disco_restaurant_cache ADD COLUMN IF NOT EXISTS menu_upload_url TEXT`,
    // Disco-native onboarding fields. `phone` is the restaurant's contact number;
    // `is_disco_native` marks a restaurant created entirely in Disco (no FM
    // record); `is_live` is set true by become-a-partner Go-Live (or a super
    // admin) and surfaces the restaurant on the marketplace alongside the
    // visible+stripe_connected FM-backed rows. (cuisine already exists above.)
    `ALTER TABLE disco_restaurant_cache ADD COLUMN IF NOT EXISTS phone TEXT`,
    `ALTER TABLE disco_restaurant_cache ADD COLUMN IF NOT EXISTS is_live BOOLEAN DEFAULT false`,
    `ALTER TABLE disco_restaurant_cache ADD COLUMN IF NOT EXISTS is_disco_native BOOLEAN DEFAULT false`,
    // Square restaurant icon/logo, captured at onboarding (separate from image_url,
    // which is the wider marketplace/hero image). Both set via become-a-partner.
    `ALTER TABLE disco_restaurant_cache ADD COLUMN IF NOT EXISTS icon_url TEXT`,
    // IANA timezone (e.g. 'America/New_York') for the restaurant. Used by the
    // hourly order-reminders cron to compute the 24h-before-pickup window in the
    // restaurant's local time. NULL falls back to America/New_York in the cron.
    `ALTER TABLE disco_restaurant_cache ADD COLUMN IF NOT EXISTS timezone TEXT`,
    // Structured address parts + manual marketplace ordering — used by the
    // Locations management page (native, per disco group). `address` above holds
    // line 1; these split out the rest so the edit dialog round-trips cleanly and
    // the list can be drag-reordered.
    `ALTER TABLE disco_restaurant_cache ADD COLUMN IF NOT EXISTS address_line2 TEXT`,
    `ALTER TABLE disco_restaurant_cache ADD COLUMN IF NOT EXISTS city TEXT`,
    `ALTER TABLE disco_restaurant_cache ADD COLUMN IF NOT EXISTS state TEXT`,
    `ALTER TABLE disco_restaurant_cache ADD COLUMN IF NOT EXISTS zipcode TEXT`,
    `ALTER TABLE disco_restaurant_cache ADD COLUMN IF NOT EXISTS location_position INTEGER`,
    // Index the slug so the favorites enrichment can join on slug (some favorites
    // were stored by Sanity slug rather than the restaurant_reference UUID).
    `CREATE INDEX IF NOT EXISTS idx_disco_restaurant_cache_slug ON disco_restaurant_cache(slug)`,
    // Per-menu Disco-only settings (keyed by the FM/menu reference). Holds the
    // "Include Utensils" toggle — a Disco concept FM has no field for. When true,
    // the customer ordering page offers an optional "Include utensils" checkbox
    // that writes "Include utensils" to disco_orders.note at placement.
    `CREATE TABLE IF NOT EXISTS disco_menu_settings (
      menu_reference UUID PRIMARY KEY,
      restaurant_reference UUID,
      include_utensils BOOLEAN NOT NULL DEFAULT false,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    // Disco-only per-menu image (keyed by the FM menu reference). FM's
    // MenuRequestDto has no image field — the menu image is a Disco addition
    // captured in MenuSettingsDialog and stored here alongside include_utensils.
    `ALTER TABLE disco_menu_settings ADD COLUMN IF NOT EXISTS image_url TEXT`,
  ]
  for (const s of statements) await sql.query(s)
  promoMigrated = true

  await runDiscoOrderMigrations()

  // One-time idempotent backfill: convert favorites stored by Sanity slug into
  // the canonical restaurant_reference UUID (the enrichment join keys on the
  // UUID). Runs here — after both disco_restaurant_cache (above) and
  // disco_customer_favorites (runDiscoOrderMigrations) exist. Only rows whose
  // stored value matches a cache slug AND isn't already a UUID are touched, and
  // any that would collide with an existing UUID favorite for that user are
  // skipped (the UNIQUE(customer_email, restaurant_reference) constraint).
  // Wrapped so a backfill hiccup can never break a request.
  try {
    await sql.query(`
      UPDATE disco_customer_favorites f
      SET restaurant_reference = c.restaurant_reference
      FROM disco_restaurant_cache c
      WHERE c.slug = f.restaurant_reference
        AND f.restaurant_reference !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        AND NOT EXISTS (
          SELECT 1 FROM disco_customer_favorites f2
          WHERE f2.customer_email = f.customer_email
            AND f2.restaurant_reference = c.restaurant_reference
        )
    `)
  } catch (e) {
    console.error('[migrations] favorites slug→uuid backfill skipped:', e instanceof Error ? e.message : e)
  }
}

// ── Customer saved-addresses schema ───────────────────────────────────────────
// Disco-native multi-address book per customer (FM only stores ONE address).
// Idempotent + cached per lambda; each address API route calls this at the top.
let customerAddressMigrated = false
export async function runCustomerAddressMigrations(): Promise<void> {
  if (customerAddressMigrated) return
  const statements = [
    `CREATE TABLE IF NOT EXISTS customer_addresses (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      customer_fm_reference TEXT NOT NULL,
      customer_email TEXT,
      label TEXT,
      address_line1 TEXT NOT NULL,
      address_line2 TEXT,
      city TEXT NOT NULL,
      state TEXT NOT NULL,
      zipcode TEXT NOT NULL,
      latitude NUMERIC,
      longitude NUMERIC,
      delivery_instructions TEXT,
      is_default BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_customer_addresses_customer ON customer_addresses(customer_fm_reference)`,
  ]
  for (const s of statements) await sql.query(s)
  customerAddressMigrated = true
}

// ── Customer card vault migration ─────────────────────────────────────────────
// The disco_customer_payment_methods table ships (in 001_disco_orders.sql) with
// UNIQUE(customer_email) — one card per customer. The multi-card vault needs many
// rows per email, so drop that constraint. Idempotent + cached per lambda.
let cardVaultMigrated = false
export async function runCustomerPaymentMethodMigrations(): Promise<void> {
  if (cardVaultMigrated) return
  try { await runDiscoOrderMigrations() } catch (e) { console.error('[card-vault] base migration warning:', e) }
  try {
    await sql`ALTER TABLE disco_customer_payment_methods DROP CONSTRAINT IF EXISTS disco_customer_payment_methods_customer_email_key`
  } catch (e) {
    console.error('[card-vault] drop-unique warning (non-fatal):', e)
  }
  cardVaultMigrated = true
}

// ── Disco-native order management schema ──────────────────────────────────────
// Reads lib/migrations/001_disco_orders.sql and executes it against the Neon
// DATABASE_URL. Idempotent (every statement is IF NOT EXISTS) and cached per
// lambda. The Neon HTTP driver runs one statement per round-trip, so we split the
// file on `;` and run each separately rather than sending the whole script.
let discoMigrated = false
export async function runDiscoOrderMigrations(): Promise<void> {
  if (discoMigrated) return

  const sqlPath = path.join(process.cwd(), 'lib', 'migrations', '001_disco_orders.sql')
  const file = await readFile(sqlPath, 'utf8')

  const statements = file
    // Drop full-line `--` comments so they don't get sent as empty statements.
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)

  for (const s of statements) await sql.query(s)
  discoMigrated = true
}

// ── Disco-native menu schema ──────────────────────────────────────────────────
// Reads lib/migrations/002_disco_menus.sql (categories + items). Same idempotent,
// split-on-`;`, cached-per-lambda approach as runDiscoOrderMigrations.
let discoMenuMigrated = false
export async function runDiscoMenuMigrations(): Promise<void> {
  if (discoMenuMigrated) return

  const sqlPath = path.join(process.cwd(), 'lib', 'migrations', '002_disco_menus.sql')
  const file = await readFile(sqlPath, 'utf8')

  const statements = file
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)

  for (const s of statements) await sql.query(s)
  discoMenuMigrated = true
}
