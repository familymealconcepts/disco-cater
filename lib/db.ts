import { neon, type NeonQueryFunction } from '@neondatabase/serverless'

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
  ]
  for (const s of statements) await sql.query(s)
  promoMigrated = true
}
