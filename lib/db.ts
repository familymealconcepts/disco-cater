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
    `ALTER TABLE disco_restaurant_overrides ADD COLUMN IF NOT EXISTS online_ordering_enabled BOOLEAN DEFAULT false`,
    // Neon mirror of FM's session-scoped notification settings (PUT /api/notifications),
    // written on every order-settings save. A daily cron + the server-side order
    // dispatch have no restaurant session, so they read these instead of FM.
    // order_reminder_emails_enabled ← FM orderReminderEmailsEnabled;
    // notification_emails ← FM email[] recipient list (comma-separated).
    `ALTER TABLE disco_restaurant_overrides ADD COLUMN IF NOT EXISTS order_reminder_emails_enabled BOOLEAN DEFAULT false`,
    `ALTER TABLE disco_restaurant_overrides ADD COLUMN IF NOT EXISTS notification_emails TEXT`,
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
    // Index the slug so the favorites enrichment can join on slug (some favorites
    // were stored by Sanity slug rather than the restaurant_reference UUID).
    `CREATE INDEX IF NOT EXISTS idx_disco_restaurant_cache_slug ON disco_restaurant_cache(slug)`,
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
